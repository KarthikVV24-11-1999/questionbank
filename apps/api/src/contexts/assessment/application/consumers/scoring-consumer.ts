import {
  createAnswerKey,
  createScoringInput,
  type AnswerKeyData,
  type CreateScoredSection,
  type ResponseSnapshot,
  type ScoreAttempt,
} from '../../../scoring/public/index.js';
import { ROLES } from '../../../../platform/auth/roles.js';
import type { AttemptRepository, FormRepository, ResponseLog } from '../../domain/repository-ports.js';
import { projectLog } from '../../domain/response-log.js';
import type { Result } from '../../domain/result.js';
import type { ApplicationError } from '../authorization.js';
import type { ApplicationContext } from '../ports.js';

/**
 * Scores a submitted attempt (M6-40, D60): the consumer of `AttemptSubmitted`.
 *
 * **Scoring's barrel is the only way in, and `AnswerKeyData` is the only thing that crosses.** The attempt's pinned item
 * versions are asked of content for their keys (content's own seam, the system's alone); the marking rules and aggregation are
 * asked of curriculum for the profile the attempt pinned; the scoring input is built by scoring's own constructor
 * (`createScoringInput`), which validates that every key fits its item type; and scoring's handler does the marking. Nothing here
 * decides what a mark is.
 *
 * **Exactly once per submission** is a property of the pieces together, because the relay delivers *at least* once:
 *
 *   - scoring's handler returns the current score record if one exists, so a redelivery after a success writes nothing;
 *   - scoring's store refuses a second current record per attempt, so two deliveries racing both reach the write and one is
 *     told it lost — and that loser asks again and is handed the winner's record. Either way one record exists, and both
 *     deliveries succeed.
 *
 * **A failure is loud and recoverable.** Anything that stops the attempt being scored — a version content cannot give a key for,
 * a profile whose rules no longer hash to the pin, a store that is down — throws, which leaves the message to be retried and,
 * past the relay's attempts, dead-lettered where an operator can see it and `requeue` it. The attempt is never silently left
 * scoreless: until a score record exists its result reads `pending`.
 *
 * The answers it reads are the **projection** of the log (the engine's, with the attempt's own pinned interval cap), not the
 * events: scoring inherits determinism from projection or it has none (§4). An answer that cannot be read as the kind its item
 * takes is unattempted (D62).
 */
export const SCORING_CONSUMER_PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000f0';

export interface SubmittedEnvelope {
  readonly messageId: string;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ScoringKeyReader {
  handle(query: { readonly itemVersionIds: readonly string[] }, context: ApplicationContext): Promise<Result<readonly { readonly itemVersionId: string; readonly itemType: string; readonly answerKey: AnswerKeyData }[], ApplicationError>>;
}

export interface ScoringSpecReader {
  handle(
    query: { readonly profileVersionId: string },
    context: ApplicationContext,
  ): Promise<Result<{ readonly markingRuleSet: ScoreAttempt['ruleSet']; readonly markingRuleSetHash: string | null; readonly aggregation: ScoreAttempt['aggregation'] }, ApplicationError>>;
}

export interface Scorer {
  handle(command: ScoreAttempt, context: ApplicationContext): Promise<Result<unknown, ApplicationError>>;
}

export interface ScoringConsumerDependencies {
  readonly attempts: Pick<AttemptRepository, 'findById'>;
  readonly forms: Pick<FormRepository, 'findById'>;
  readonly responses: Pick<ResponseLog, 'findByAttempt'>;
  readonly keys: ScoringKeyReader;
  readonly spec: ScoringSpecReader;
  readonly scorer: Scorer;
}

export class ScoringFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ScoringFailure';
  }
}

const CONFLICT_CODES = new Set(['CONFLICT']);

/** What the learner's answer is as the item's kind reads it; `undefined` is unattempted. */
export function toResponseSnapshot(itemType: string, answer: unknown): ResponseSnapshot | undefined {
  if (answer === null || answer === undefined) return undefined;
  switch (itemType) {
    case 'SINGLE_CORRECT_MCQ':
    case 'MULTIPLE_CORRECT_MCQ': {
      const chosen = (Array.isArray(answer) ? answer : [answer]).filter((option): option is string => typeof option === 'string' && option.length > 0);
      return chosen.length === 0 ? undefined : { kind: 'OPTION_SELECTION', optionIds: chosen };
    }
    case 'MATCHING': {
      // a pair is the text "left:right"; a list of them is the whole matching
      const pairs = (Array.isArray(answer) ? answer : [answer])
        .filter((pair): pair is string => typeof pair === 'string')
        .map((pair) => pair.split(':'))
        .filter((parts): parts is [string, string] => parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0)
        .map(([left, right]) => ({ left, right }));
      return pairs.length === 0 ? undefined : { kind: 'MATCHING', pairs };
    }
    case 'NUMERIC': {
      const raw = Array.isArray(answer) ? undefined : String(answer);
      return raw === undefined || raw.trim().length === 0 ? undefined : { kind: 'NUMERIC_ENTRY', raw };
    }
    default:
      return undefined;
  }
}

export class ScoreSubmittedAttemptConsumer {
  readonly name = 'ScoreSubmittedAttempt';

  constructor(private readonly deps: ScoringConsumerDependencies) {}

  async handle(envelope: SubmittedEnvelope): Promise<void> {
    const attemptId = envelope.payload['attemptId'];
    if (typeof attemptId !== 'string') throw new ScoringFailure('PAYLOAD_INVALID', 'the event names no attempt');
    const context: ApplicationContext = {
      principal: { kind: 'system', id: SCORING_CONSUMER_PRINCIPAL_ID, roleContext: [ROLES.system] },
      correlationId: envelope.correlationId,
    };

    const attempt = await this.deps.attempts.findById(attemptId);
    if (!attempt.ok) throw new ScoringFailure(attempt.error.code, attempt.error.message);
    if (attempt.value.state !== 'submitted') throw new ScoringFailure('ATTEMPT_NOT_SUBMITTED', `attempt ${attemptId} is ${attempt.value.state}`);
    const form = await this.deps.forms.findById(attempt.value.formId);
    if (!form.ok) throw new ScoringFailure(form.error.code, form.error.message);
    const events = await this.deps.responses.findByAttempt(attemptId);
    if (!events.ok) throw new ScoringFailure(events.error.code, events.error.message);

    const itemVersionIds = [...new Set(attempt.value.slots.map((slot) => slot.itemVersionId))];
    const keys = await this.deps.keys.handle({ itemVersionIds }, context);
    if (!keys.ok) throw new ScoringFailure(keys.error.code, keys.error.message);
    const spec = await this.deps.spec.handle({ profileVersionId: attempt.value.examProfileVersionId }, context);
    if (!spec.ok) throw new ScoringFailure(spec.error.code, spec.error.message);
    if (spec.value.markingRuleSetHash !== attempt.value.markingRuleSetHash) {
      throw new ScoringFailure('MARKING_RULES_NO_LONGER_MATCH_THE_PIN', 'the exam profile no longer hashes to the rules this attempt pinned');
    }

    const answers = new Map(projectLog(attempt.value, events.value).slots.map((slot) => [slot.slot, slot.answer]));
    const keyOf = new Map(keys.value.map((view) => [view.itemVersionId, view]));

    const sections: CreateScoredSection[] = [];
    for (const section of form.value.sections) {
      const slots = [];
      for (const [index, slot] of section.slots.entries()) {
        const key = keyOf.get(slot.itemVersionId);
        if (key === undefined) throw new ScoringFailure('ANSWER_KEY_MISSING', `no key for item version ${slot.itemVersionId}`);
        const answerKey = createAnswerKey(key.answerKey);
        if (!answerKey.ok) throw new ScoringFailure(answerKey.error.code, answerKey.error.message);
        const response = toResponseSnapshot(key.itemType, answers.get(slot.slotId));
        slots.push({
          slotId: slot.slotId,
          ordinal: index + 1,
          itemType: key.itemType,
          itemVersionId: slot.itemVersionId,
          marksAvailable: slot.marksAvailable,
          answerKey: answerKey.value,
          ...(response === undefined ? {} : { response }),
        });
      }
      sections.push({ ordinal: section.ordinal, slots });
    }

    const input = createScoringInput({
      attemptId,
      pin: {
        examProfileVersionId: attempt.value.examProfileVersionId,
        markingRuleSetHash: attempt.value.markingRuleSetHash,
        ruleSchemaVersion: spec.value.markingRuleSet.schemaVersion,
        taxonomyVersionId: attempt.value.taxonomyVersionId,
        itemVersionIds,
      },
      sections,
      overrides: [],
    });
    if (!input.ok) throw new ScoringFailure(input.error.code, input.error.message);

    const command: ScoreAttempt = {
      input: input.value,
      ruleSet: spec.value.markingRuleSet,
      ruleSetHash: attempt.value.markingRuleSetHash,
      aggregation: spec.value.aggregation,
      idempotencyKey: `submission:${attemptId}`,
    };
    const scored = await this.deps.scorer.handle(command, context);
    if (scored.ok) return;
    // Two deliveries racing both reached the write; the loser asks again and is handed the winner's record.
    if (CONFLICT_CODES.has(scored.error.code)) {
      const again = await this.deps.scorer.handle(command, context);
      if (again.ok) return;
      throw new ScoringFailure(again.error.code, again.error.message);
    }
    throw new ScoringFailure(scored.error.code, scored.error.message);
  }
}
