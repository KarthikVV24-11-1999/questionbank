import { ROLES } from '../../../../platform/auth/roles.js';
import { appendSlot, createAttempt, type Attempt, type AttemptSlot } from '../../domain/attempt.js';
import { BLUEPRINT_ITEM_TYPES, type BlueprintItemType } from '../../domain/blueprint.js';
import { createPracticePolicy, practicePolicyOf, type PracticePolicy } from '../../domain/delivery-policy.js';
import { selectPracticeItems } from '../../domain/practice-selection.js';
import type { AttemptRepository } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, fromAssessment, type ApplicationError } from '../authorization.js';
import type { CreatePracticeAttempt, GrowPracticeAttempt } from '../commands/attempt-commands.js';
import type { Handler } from '../handler-registry.js';
import { CREATE_PRACTICE_ATTEMPT_POLICY, GROW_PRACTICE_ATTEMPT_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock, FormCorpus, IdentifierFactory, PracticePinSource, RemediationSource } from '../ports.js';
import { toAttemptView } from '../views.js';
import { gate, ownAttempt, record, type CreatedAttempt } from './attempt-handlers.js';

/** A run starts with, and is grown by, at most this many items at a time. */
export const MAX_PRACTICE_RUN = 50;

/** How many concepts the targeted strategy asks Learning for. */
const TARGET_CONCEPTS = 5;

/** The identity the catalogue is read under: content's catalogue is the system's, and a learner is not given that reach by asking for practice. */
const PRACTICE_CATALOGUE_PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000f2';

export interface PracticeDependencies {
  readonly attempts: AttemptRepository;
  readonly corpus: FormCorpus;
  readonly practicePins: PracticePinSource;
  /** Absent where Learning is not composed in: the targeted strategy then says so rather than guessing. */
  readonly remediation?: RemediationSource;
  readonly intervalCapMs: number;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

const asCatalogueReader = (context: ApplicationContext): ApplicationContext => ({
  principal: { kind: 'system', id: PRACTICE_CATALOGUE_PRINCIPAL_ID, roleContext: [ROLES.system] },
  correlationId: context.correlationId,
});

/**
 * What the policy selects, resolved to items: the catalogue through the one seam content offers, the learner's earlier items from the attempts, and —
 * for the targeted strategy — the concepts Learning names. Shared by creating a run and growing one, so the two cannot choose differently.
 */
async function choose(
  deps: PracticeDependencies,
  policy: PracticePolicy,
  taxonomyVersionId: string,
  studentId: string,
  inRun: ReadonlySet<string>,
  count: number,
  context: ApplicationContext,
): Promise<Result<readonly AttemptSlotDraft[], ApplicationError>> {
  if (policy.selectionStrategy === 'spaced_review') {
    return err(applicationError('PreconditionFailed', 'SPACED_REVIEW_NOT_AVAILABLE', 'spaced review is chosen from the review schedule, which does not exist yet', 'selectionStrategy'));
  }
  let targets: readonly string[] | undefined;
  if (policy.selectionStrategy === 'targeted') {
    if (deps.remediation === undefined) {
      return err(applicationError('PreconditionFailed', 'TARGETED_NOT_AVAILABLE', 'targeted practice needs Learning, which is not composed in', 'selectionStrategy'));
    }
    const concepts = await deps.remediation.conceptsFor(taxonomyVersionId, TARGET_CONCEPTS, context);
    if (!concepts.ok) return concepts;
    if (concepts.value.length === 0) {
      return err(applicationError('PreconditionFailed', 'NOTHING_TO_REMEDIATE', 'there is no concept the learner is weak on to practise', 'selectionStrategy'));
    }
    targets = concepts.value;
  }
  const itemTypes = policy.scopeFilter.itemTypes as readonly BlueprintItemType[];
  const loaded = await deps.corpus.load(
    { ...(policy.scopeFilter.subject === null ? {} : { subject: policy.scopeFilter.subject }), ...(itemTypes.length === 0 ? {} : { itemTypes }) },
    asCatalogueReader(context),
  );
  if (!loaded.ok) return loaded;
  const seen = policy.excludeRecentlySeen ? await deps.attempts.itemsSeenBy(studentId) : ok(new Set<string>() as ReadonlySet<string>);
  if (!seen.ok) return err(fromAssessment(seen.error));
  const picked = selectPracticeItems({
    candidates: loaded.value.candidates,
    policy,
    ...(targets === undefined ? {} : { targetConceptIds: targets }),
    seenItemIds: seen.value,
    inRunItemIds: inRun,
    exposure: loaded.value.exposure,
    count,
  });
  return ok(picked.map((candidate) => ({ itemId: candidate.itemId, itemVersionId: candidate.itemVersionId, stimulusVersionId: candidate.stimulusVersionId })));
}

interface AttemptSlotDraft {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly stimulusVersionId: string | null;
}

const validCount = (count: unknown): count is number => Number.isInteger(count) && (count as number) >= 1 && (count as number) <= MAX_PRACTICE_RUN;

/**
 * Starts a practice run (M7-28, M7-29): the same `Attempt`, in the practice mode, with no form, no window and no deadline. The policy is built and
 * validated by the domain, the delivery document pinned on the attempt is the one derivation's, and the slots are the items selected from the published
 * catalogue — each written together with its exposure ledger row (M7-30). Idempotent on the caller's key.
 */
export class CreatePracticeAttemptHandler implements Handler<CreatePracticeAttempt, CreatedAttempt> {
  readonly name = 'CreatePracticeAttempt';
  readonly policy = CREATE_PRACTICE_ATTEMPT_POLICY;

  constructor(private readonly deps: PracticeDependencies) {}

  async handle(command: CreatePracticeAttempt, context: ApplicationContext): Promise<Result<CreatedAttempt, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);
    const studentId = context.principal.id;
    const now = this.deps.clock.now().toISOString();

    const prior = await this.deps.attempts.findByCreationKey(studentId, command.idempotencyKey);
    if (!prior.ok) return err(fromAssessment(prior.error));
    if (prior.value !== undefined) return this.replay(prior.value, command, now);

    if (!validCount(command.count)) {
      return err(applicationError('Validation', 'PRACTICE_COUNT_INVALID', `a run starts with between 1 and ${MAX_PRACTICE_RUN} items`, 'count'));
    }
    const types = command.scopeFilter?.itemTypes ?? [];
    if (!types.every((type) => (BLUEPRINT_ITEM_TYPES as readonly string[]).includes(type))) {
      return err(applicationError('Validation', 'PRACTICE_SCOPE_INVALID', 'an item type is one the blueprint knows', 'scopeFilter.itemTypes'));
    }
    const policy = createPracticePolicy({
      selectionStrategy: command.selectionStrategy,
      ...(command.scopeFilter === undefined ? {} : { scopeFilter: command.scopeFilter }),
      ...(command.difficultyBand === undefined ? {} : { difficultyBand: command.difficultyBand }),
      ...(command.excludeRecentlySeen === undefined ? {} : { excludeRecentlySeen: command.excludeRecentlySeen }),
    });
    if (!policy.ok) return err(fromAssessment(policy.error));

    const pins = await this.deps.practicePins.practicePinsFor(command.examProfileVersionId, policy.value, context);
    if (!pins.ok) return pins;

    const chosen = await choose(this.deps, policy.value, pins.value.taxonomyVersionId, studentId, new Set(), command.count, context);
    if (!chosen.ok) return chosen;
    if (chosen.value.length === 0) {
      return err(applicationError('PreconditionFailed', 'NO_ITEMS_MATCH', 'no published item matches what was asked for', 'scopeFilter'));
    }

    const built = createAttempt({
      attemptId: this.deps.identifiers.next(),
      studentId,
      mode: 'practice',
      formId: null,
      examProfileVersionId: command.examProfileVersionId,
      markingRuleSetHash: pins.value.markingRuleSetHash,
      taxonomyVersionId: pins.value.taxonomyVersionId,
      deliveryPolicy: pins.value.deliveryPolicy,
      sessionRef: null,
      shiftId: null,
      slots: chosen.value.map((item, index) => ({ slotId: this.deps.identifiers.next(), ordinal: index + 1, ...item })),
      durationMs: pins.value.durationMs,
      intervalCapMs: this.deps.intervalCapMs,
      windowClosesAt: null,
      createdAt: now,
    });
    if (!built.ok) return err(fromAssessment(built.error));

    const created = await this.deps.attempts.create(built.value, command.idempotencyKey);
    if (!created.ok) {
      const raced = await this.deps.attempts.findByCreationKey(studentId, command.idempotencyKey);
      if (raced.ok && raced.value !== undefined) return this.replay(raced.value, command, now);
      return err(fromAssessment(created.error));
    }
    await record(this.deps, context, 'CreatePracticeAttempt', created.value.attemptId);
    return ok(Object.freeze({ attempt: toAttemptView(created.value, now), replayed: false }));
  }

  private replay(prior: Attempt, command: CreatePracticeAttempt, now: string): Result<CreatedAttempt, ApplicationError> {
    if (prior.mode !== 'practice' || prior.examProfileVersionId !== command.examProfileVersionId) {
      return err(applicationError('Conflict', 'IDEMPOTENCY_KEY_REUSED', 'that idempotency key already created an attempt for something else', 'idempotencyKey'));
    }
    return ok(Object.freeze({ attempt: toAttemptView(prior, now), replayed: true }));
  }
}

/**
 * Grows a run in progress (M7-27): more items, chosen under the policy the run pinned when it was created, none repeating one already in it. Each is
 * appended as a new slot — a new pin, and a new ledger row — and no slot already there is touched.
 */
export class GrowPracticeAttemptHandler implements Handler<GrowPracticeAttempt, ReturnType<typeof toAttemptView>> {
  readonly name = 'GrowPracticeAttempt';
  readonly policy = GROW_PRACTICE_ATTEMPT_POLICY;

  constructor(private readonly deps: PracticeDependencies) {}

  async handle(command: GrowPracticeAttempt, context: ApplicationContext): Promise<Result<ReturnType<typeof toAttemptView>, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);
    if (!validCount(command.count)) {
      return err(applicationError('Validation', 'PRACTICE_COUNT_INVALID', `a run grows by between 1 and ${MAX_PRACTICE_RUN} items`, 'count'));
    }
    const owned = await ownAttempt(this.deps, command.attemptId, context);
    if (!owned.ok) return owned;
    let attempt = owned.value;
    const now = this.deps.clock.now().toISOString();

    const policy = practicePolicyOf(attempt.deliveryPolicy);
    if (attempt.mode !== 'practice' || policy === null) {
      return err(applicationError('RuleViolation', 'ATTEMPT_NOT_PRACTICE', 'only a practice run grows', 'mode'));
    }
    if (!policy.ok) return err(fromAssessment(policy.error));

    const chosen = await choose(
      this.deps,
      policy.value,
      attempt.taxonomyVersionId,
      attempt.studentId,
      new Set(attempt.slots.map((slot) => slot.itemId)),
      command.count,
      context,
    );
    if (!chosen.ok) return chosen;
    if (chosen.value.length === 0) {
      return err(applicationError('PreconditionFailed', 'NO_FURTHER_ITEMS', 'no further published item matches this run', 'scopeFilter'));
    }
    for (const item of chosen.value) {
      const slot: AttemptSlot = { slotId: this.deps.identifiers.next(), ordinal: (attempt.slots[attempt.slots.length - 1]?.ordinal ?? 0) + 1, ...item };
      const grown = appendSlot(attempt, slot);
      if (!grown.ok) return err(fromAssessment(grown.error));
      const written = await this.deps.attempts.appendSlot(attempt.attemptId, slot, now);
      if (!written.ok) return err(fromAssessment(written.error));
      attempt = grown.value;
    }
    await record(this.deps, context, 'GrowPracticeAttempt', attempt.attemptId);
    return ok(toAttemptView(attempt, now));
  }
}
