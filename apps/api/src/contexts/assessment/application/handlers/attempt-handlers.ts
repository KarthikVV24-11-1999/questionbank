import { admitNewAttempt, isExpired, startAttempt, submitAttempt, type Attempt } from '../../domain/attempt.js';
import { createAttemptFromForm } from '../../domain/form.js';
import type { AttemptRepository, FormRepository, ResponseLog } from '../../domain/repository-ports.js';
import { acceptResponseEvent, type ResponseEvent } from '../../domain/response-event.js';
import { mergeIncoming } from '../../domain/response-log.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, fromAssessment, type ApplicationError, type AuthorizationPolicy } from '../authorization.js';
import type { CreateAttempt, GetAttempt, IngestResponseEvents, StartAttempt, SubmitAttempt } from '../commands/attempt-commands.js';
import type { Handler } from '../handler-registry.js';
import {
  CREATE_ATTEMPT_POLICY,
  GET_ATTEMPT_POLICY,
  INGEST_RESPONSE_EVENTS_POLICY,
  START_ATTEMPT_POLICY,
  SUBMIT_ATTEMPT_POLICY,
} from '../policies.js';
import type { ApplicationContext, AttemptPinSource, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import { toAttemptView, type AttemptView } from '../views.js';

export interface AttemptDependencies {
  readonly forms: Pick<FormRepository, 'findById'>;
  readonly attempts: AttemptRepository;
  readonly responses: ResponseLog;
  readonly pins: AttemptPinSource;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

/** The constraint names the database reports, which is how a conflict says what it was. */
const ACTIVE_MOCK_INDEX = 'attempt_one_active_mock_per_student';

async function record(deps: AttemptDependencies, context: ApplicationContext, action: string, attemptId: string): Promise<void> {
  await deps.audit.record({
    principal: context.principal,
    action,
    targetContext: 'assessment',
    targetType: 'attempt',
    targetId: attemptId,
    correlationId: context.correlationId,
    occurredAt: deps.clock.now(),
  });
}

/**
 * The attempt, if it is the caller's. Someone else's attempt is `NotFound`, the same answer as one that does not
 * exist, so the route does not disclose which ids are real.
 */
async function ownAttempt(deps: AttemptDependencies, attemptId: string, context: ApplicationContext): Promise<Result<Attempt, ApplicationError>> {
  const found = await deps.attempts.findById(attemptId);
  if (!found.ok) return err(fromAssessment(found.error));
  if (found.value.studentId !== context.principal.id) {
    return err(applicationError('NotFound', 'NOT_FOUND', `no attempt ${attemptId}`, 'attempt'));
  }
  return ok(found.value);
}

function gate(policy: AuthorizationPolicy, context: ApplicationContext): ApplicationError | null {
  const permitted = authorize(policy, context);
  return permitted.ok ? null : permitted.error;
}

export interface CreatedAttempt {
  readonly attempt: AttemptView;
  /** True when this key had already created the attempt: a retry, answered with what it made. */
  readonly replayed: boolean;
}

/**
 * Creates an attempt on a form (M6-30).
 *
 * **Three refusals, each its own code**: the form is not active (`FORM_NOT_OPEN_FOR_ATTEMPTS`), its window is
 * not open at this moment (`FORM_WINDOW_NOT_YET_OPEN` / `FORM_WINDOW_CLOSED`), or it was not published for the
 * session named (`FORM_SESSION_NOT_PUBLISHED_FOR`) — decided by the domain here, at the route, and again by the
 * database's own constraints behind it.
 *
 * **Idempotent on the caller's key**: a retry returns the attempt the key already made and writes nothing; the
 * same key naming a different form or session is a conflict, not a replay. The duration, window and pins are
 * copied from the form and its exam profile; nothing a client sends can set one.
 */
export class CreateAttemptHandler implements Handler<CreateAttempt, CreatedAttempt> {
  readonly name = 'CreateAttempt';
  readonly policy = CREATE_ATTEMPT_POLICY;

  constructor(private readonly deps: AttemptDependencies) {}

  async handle(command: CreateAttempt, context: ApplicationContext): Promise<Result<CreatedAttempt, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);

    const studentId = context.principal.id;
    const now = this.deps.clock.now().toISOString();

    const prior = await this.deps.attempts.findByCreationKey(studentId, command.idempotencyKey);
    if (!prior.ok) return err(fromAssessment(prior.error));
    if (prior.value !== undefined) return this.replay(prior.value, command, now);

    const form = await this.deps.forms.findById(command.formId);
    if (!form.ok) return err(fromAssessment(form.error));

    const pins = await this.deps.pins.pinsFor(form.value.examProfileVersionId, context);
    if (!pins.ok) return err(pins.error);

    const built = createAttemptFromForm(
      form.value,
      {
        attemptId: this.deps.identifiers.next(),
        studentId,
        taxonomyVersionId: pins.value.taxonomyVersionId,
        markingRuleSetHash: pins.value.markingRuleSetHash,
        deliveryPolicy: pins.value.deliveryPolicy,
        sessionRef: command.sessionRef,
        shiftId: command.shiftId ?? command.sessionRef,
        durationMs: pins.value.durationMs,
        createdAt: now,
      },
      now,
    );
    if (!built.ok) return err(fromAssessment(built.error));

    // The friendly answer first: it names the attempt in the way. The index below is what actually decides.
    const active = await this.deps.attempts.findActiveMock(studentId);
    if (!active.ok) return err(fromAssessment(active.error));
    const admitted = admitNewAttempt(built.value.mode, active.value === undefined ? [] : [active.value]);
    if (!admitted.ok) {
      // The "active mock" in the way may be the very attempt this key made a moment ago, in a request racing this one: that is a replay.
      const raced = await this.deps.attempts.findByCreationKey(studentId, command.idempotencyKey);
      if (raced.ok && raced.value !== undefined) return this.replay(raced.value, command, now);
      return err(fromAssessment(admitted.error));
    }

    const created = await this.deps.attempts.create(built.value, command.idempotencyKey);
    if (!created.ok) return this.afterRefusedCreate(created.error, studentId, command, now);

    await record(this.deps, context, 'CreateAttempt', created.value.attemptId);
    return ok(Object.freeze({ attempt: toAttemptView(created.value, now), replayed: false }));
  }

  private replay(prior: Attempt, command: CreateAttempt, now: string): Result<CreatedAttempt, ApplicationError> {
    if (prior.formId !== command.formId || prior.sessionRef !== command.sessionRef) {
      return err(applicationError('Conflict', 'IDEMPOTENCY_KEY_REUSED', 'that idempotency key already created an attempt for a different form or session', 'idempotencyKey'));
    }
    return ok(Object.freeze({ attempt: toAttemptView(prior, now), replayed: true }));
  }

  /** The store refused the write. Say which rule did, in terms an operator or a client can act on. */
  private async afterRefusedCreate(
    error: { readonly kind: string; readonly code: string; readonly message: string; readonly location?: string },
    studentId: string,
    command: CreateAttempt,
    now: string,
  ): Promise<Result<CreatedAttempt, ApplicationError>> {
    if (error.code === 'CONFLICT') {
      // A concurrent create under the same key already won: that is a replay, not a conflict.
      const raced = await this.deps.attempts.findByCreationKey(studentId, command.idempotencyKey);
      if (raced.ok && raced.value !== undefined) return this.replay(raced.value, command, now);
      if (error.location === ACTIVE_MOCK_INDEX) {
        const blocking = await this.deps.attempts.findActiveMock(studentId);
        const named = blocking.ok && blocking.value !== undefined ? ` (attempt ${blocking.value.attemptId})` : '';
        return err(applicationError('Conflict', 'ACTIVE_MOCK_ATTEMPT_EXISTS', `the student already has an active mock attempt${named}; submit or abandon it first`, 'attemptId', { constraint: ACTIVE_MOCK_INDEX }));
      }
    }
    return err(fromAssessment(error as Parameters<typeof fromAssessment>[0]));
  }
}

/**
 * Starts the attempt and anchors its deadline — fixed here from the server's clock and the sitting's length, never
 * recomputed and never taken from the client. Idempotent: starting a started attempt returns it as it is.
 */
export class StartAttemptHandler implements Handler<StartAttempt, AttemptView> {
  readonly name = 'StartAttempt';
  readonly policy = START_ATTEMPT_POLICY;

  constructor(private readonly deps: AttemptDependencies) {}

  async handle(command: StartAttempt, context: ApplicationContext): Promise<Result<AttemptView, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);

    const owned = await ownAttempt(this.deps, command.attemptId, context);
    if (!owned.ok) return owned;
    const now = this.deps.clock.now().toISOString();
    if (owned.value.state === 'in_progress') return ok(toAttemptView(owned.value, now));

    const started = startAttempt(owned.value, now);
    if (!started.ok) return err(fromAssessment(started.error));

    const saved = await this.deps.attempts.save(started.value, 'created');
    if (!saved.ok) {
      // Another start won the race: what it made is the answer.
      const current = await ownAttempt(this.deps, command.attemptId, context);
      if (current.ok && current.value.state === 'in_progress') return ok(toAttemptView(current.value, now));
      return err(fromAssessment(saved.error));
    }
    await record(this.deps, context, 'StartAttempt', saved.value.attemptId);
    return ok(toAttemptView(saved.value, now));
  }
}

export class GetAttemptHandler implements Handler<GetAttempt, AttemptView> {
  readonly name = 'GetAttempt';
  readonly policy = GET_ATTEMPT_POLICY;

  constructor(private readonly deps: AttemptDependencies) {}

  async handle(query: GetAttempt, context: ApplicationContext): Promise<Result<AttemptView, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);
    const owned = await ownAttempt(this.deps, query.attemptId, context);
    return owned.ok ? ok(toAttemptView(owned.value, this.deps.clock.now().toISOString())) : owned;
  }
}

export type EventOutcome = 'accepted' | 'late' | 'replayed' | 'rejected';

export interface EventResult {
  readonly eventId: string;
  readonly outcome: EventOutcome;
  /** For a rejection: why. Never present otherwise. */
  readonly code?: string;
  readonly message?: string;
}

export interface IngestReport {
  readonly attemptId: string;
  readonly state: string;
  /** One per event sent, in the order sent. A per-event answer, never all-or-nothing (a bad event must not reject a three-hour log). */
  readonly results: readonly EventResult[];
  /** The ids a device may drop from its queue: recorded, recorded late, or already held. A rejected event is not acknowledged. */
  readonly acknowledged: readonly string[];
}

export const MAX_EVENTS_PER_BATCH = 200;

/**
 * Takes events from a device (M6-32): append-only, idempotent on `event_id`, and answering each one.
 *
 *  - **`accepted`** — new, recorded, counts;
 *  - **`late`** — new, recorded, but the attempt was already submitted: kept and excluded from scoring (§4);
 *  - **`replayed`** — already held, same content: nothing changes;
 *  - **`rejected`** — refused, with the reason (it is not silently dropped, and it is not acknowledged).
 *
 * Which events are new and which are replays is **the attempt engine's merge** (REL-06, ADR-0035), not a
 * second implementation here, so order and repetition cannot change the log: delivery in any order, any number
 * of times, converges to one set. An attempt that is not in progress or submitted takes none, and says so.
 */
export class IngestResponseEventsHandler implements Handler<IngestResponseEvents, IngestReport> {
  readonly name = 'IngestResponseEvents';
  readonly policy = INGEST_RESPONSE_EVENTS_POLICY;

  constructor(private readonly deps: AttemptDependencies) {}

  async handle(command: IngestResponseEvents, context: ApplicationContext): Promise<Result<IngestReport, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);

    if (command.events.length === 0 || command.events.length > MAX_EVENTS_PER_BATCH) {
      return err(applicationError('Validation', 'EVENT_BATCH_SIZE_INVALID', `a batch carries between 1 and ${MAX_EVENTS_PER_BATCH} events`, 'events'));
    }
    const owned = await ownAttempt(this.deps, command.attemptId, context);
    if (!owned.ok) return owned;
    const attempt = owned.value;
    if (attempt.state !== 'in_progress' && attempt.state !== 'submitted') {
      return err(applicationError('RuleViolation', 'ATTEMPT_NOT_ACCEPTING_RESPONSES', `a ${attempt.state} attempt takes no responses`, 'state'));
    }

    const receivedAt = this.deps.clock.now().toISOString();
    const results: (EventResult | undefined)[] = command.events.map(() => undefined);
    const accepted: { readonly index: number; readonly event: ResponseEvent }[] = [];
    command.events.forEach((draft, index) => {
      const event = acceptResponseEvent(attempt, draft, receivedAt);
      if (event.ok) accepted.push({ index, event: event.value });
      else results[index] = { eventId: String(draft.eventId), outcome: 'rejected', code: event.error.code, message: event.error.message };
    });

    const stored = await this.deps.responses.findByAttempt(attempt.attemptId);
    if (!stored.ok) return err(fromAssessment(stored.error));

    // The engine's union decides what is new, what is a replay and what reuses an id; an offender is refused alone.
    let live = accepted;
    let merged = mergeIncoming(attempt.attemptId, stored.value, live.map((entry) => entry.event));
    while (!merged.ok) {
      const offender = merged.error.eventId;
      for (const entry of live.filter((candidate) => candidate.event.eventId === offender)) {
        results[entry.index] = { eventId: offender, outcome: 'rejected', code: merged.error.code, message: merged.error.message };
      }
      live = live.filter((candidate) => candidate.event.eventId !== offender);
      merged = mergeIncoming(attempt.attemptId, stored.value, live.map((entry) => entry.event));
    }

    const appended = new Map<string, EventResult>();
    for (const event of merged.value.fresh) {
      const written = await this.deps.responses.append(event);
      if (written.ok) {
        appended.set(event.eventId, { eventId: event.eventId, outcome: written.value.afterSubmission ? 'late' : 'accepted' });
      } else if (written.error.code === 'CONFLICT') {
        appended.set(event.eventId, { eventId: event.eventId, outcome: 'rejected', code: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT', message: written.error.message });
      } else if (written.error.message.startsWith('assessment_attempt_not_accepting_responses')) {
        appended.set(event.eventId, { eventId: event.eventId, outcome: 'rejected', code: 'ATTEMPT_NOT_ACCEPTING_RESPONSES', message: 'the attempt stopped taking responses while this batch was in flight' });
      } else {
        // The store is failing, not the event: the device resends the whole batch, which is safe because it is idempotent.
        return err(fromAssessment(written.error));
      }
    }

    const firstSeen = new Set<string>();
    for (const entry of live) {
      const id = entry.event.eventId;
      const fresh = appended.get(id);
      if (fresh !== undefined && !firstSeen.has(id)) results[entry.index] = fresh;
      else results[entry.index] = { eventId: id, outcome: 'replayed' };
      firstSeen.add(id);
    }

    const final = results as readonly EventResult[];
    const acknowledged = [...new Set(final.filter((result) => result.outcome !== 'rejected').map((result) => result.eventId))];
    return ok(Object.freeze({ attemptId: attempt.attemptId, state: attempt.state, results: Object.freeze(final), acknowledged: Object.freeze(acknowledged) }));
  }
}

/**
 * Submits the attempt (M6-34), idempotent on the caller's key: the same key again returns the submission that exists
 * and changes nothing; a different key on a submitted attempt is a conflict.
 *
 * The reason is the caller's and is **never relabelled**. An `expiry` is true only if the deadline has passed, so one
 * sent before it is refused; a `manual` submission that arrives after the deadline is recorded as `manual`, with
 * `pastDeadline` set so the lateness is visible — not silently turned into an expiry, and not lost.
 *
 * Nothing is told to score the attempt yet: submission writes no outbox event (D60).
 */
export class SubmitAttemptHandler implements Handler<SubmitAttempt, AttemptView> {
  readonly name = 'SubmitAttempt';
  readonly policy = SUBMIT_ATTEMPT_POLICY;

  constructor(private readonly deps: AttemptDependencies) {}

  async handle(command: SubmitAttempt, context: ApplicationContext): Promise<Result<AttemptView, ApplicationError>> {
    const denied = gate(this.policy, context);
    if (denied !== null) return err(denied);

    const owned = await ownAttempt(this.deps, command.attemptId, context);
    if (!owned.ok) return owned;
    const now = this.deps.clock.now().toISOString();

    if (owned.value.submission === null && command.reason === 'expiry' && !isExpired(owned.value, now)) {
      return err(applicationError('RuleViolation', 'SUBMISSION_EXPIRY_BEFORE_DEADLINE', 'an expiry submission is for an attempt whose deadline has passed', 'reason'));
    }

    const submitted = submitAttempt(owned.value, { reason: command.reason, idempotencyKey: command.idempotencyKey }, now);
    if (!submitted.ok) return err(fromAssessment(submitted.error));
    if (owned.value.submission !== null) return ok(toAttemptView(submitted.value, now)); // a replay: nothing to write

    const saved = await this.deps.attempts.save(submitted.value, 'in_progress');
    if (!saved.ok) {
      // A concurrent submit under the same key won: what it made is the answer.
      const current = await ownAttempt(this.deps, command.attemptId, context);
      if (current.ok) {
        const again = submitAttempt(current.value, { reason: command.reason, idempotencyKey: command.idempotencyKey }, now);
        if (again.ok && current.value.submission !== null) return ok(toAttemptView(again.value, now));
        if (!again.ok) return err(fromAssessment(again.error));
      }
      return err(fromAssessment(saved.error));
    }
    await record(this.deps, context, 'SubmitAttempt', saved.value.attemptId);
    return ok(toAttemptView(saved.value, now));
  }
}
