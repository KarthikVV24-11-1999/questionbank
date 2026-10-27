import {
  createAnswerKey,
  createScoringInput,
  type AnswerKeyData,
  type JudgeSlots,
  type ScoringInput,
} from '../../scoring/public/index.js';
import { ROLES } from '../../../platform/auth/roles.js';
import type { Attempt } from '../domain/attempt.js';
import { err, ok, type Result } from '../domain/result.js';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import { toResponseSnapshot, type ScoringKeyReader, type ScoringSpecReader } from '../application/consumers/scoring-consumer.js';
import type { ApplicationContext, ResponseJudge } from '../application/ports.js';

/** Scoring's `JudgeSlots`, in the shape this adapter needs of it. */
export interface SlotJudge {
  handle(command: JudgeSlots, context: ApplicationContext): Promise<Result<readonly { readonly slotRef: string; readonly outcome: string }[], ApplicationError>>;
}

/** The identity the key and the rule are read under: they are the system's, and a learner asking for feedback is not given that reach. */
const JUDGE_PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000f3';

/**
 * The response judge, over the three owning contexts' seams (M7-29): content's key for the pinned version, curriculum's rule set for the profile the
 * attempt pinned, and scoring's `JudgeSlots`. **Nothing here decides what is correct** — the input is built by scoring's own constructor, which checks
 * the key fits the item's type, and the verdict is the rule's.
 *
 * A practice slot belongs to no form and so to no section or mark: it is judged as the first section's, worth one unit that is never shown. The
 * correctness of an answer does not depend on the unit; which section's rules decide it is a stated limit (D79).
 */
export class ScoringResponseJudge implements ResponseJudge {
  constructor(private readonly deps: { readonly keys: ScoringKeyReader; readonly spec: ScoringSpecReader; readonly judge: SlotJudge }) {}

  async judge(attempt: Attempt, slotId: string, answer: unknown, context: ApplicationContext): Promise<Result<string, ApplicationError>> {
    const slot = attempt.slots.find((candidate) => candidate.slotId === slotId);
    if (slot === undefined) return err(applicationError('NotFound', 'NOT_FOUND', `no slot ${slotId}`, 'slotId'));
    const system: ApplicationContext = {
      principal: { kind: 'system', id: JUDGE_PRINCIPAL_ID, roleContext: [ROLES.system] },
      correlationId: context.correlationId,
    };

    const keys = await this.deps.keys.handle({ itemVersionIds: [slot.itemVersionId] }, system);
    if (!keys.ok) return keys;
    const key = keys.value.find((view) => view.itemVersionId === slot.itemVersionId);
    if (key === undefined) return err(applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', 'the item has no key to judge against', 'slotId'));
    const spec = await this.deps.spec.handle({ profileVersionId: attempt.examProfileVersionId }, system);
    if (!spec.ok) return spec;
    if (spec.value.markingRuleSetHash !== attempt.markingRuleSetHash) {
      return err(applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', 'the exam profile no longer hashes to the rules this attempt pinned', 'attemptId'));
    }
    const answerKey = createAnswerKey(key.answerKey as AnswerKeyData);
    if (!answerKey.ok) return err(applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', answerKey.error.message, 'slotId'));
    const response = toResponseSnapshot(key.itemType, answer);
    const input: ScoringInput | undefined = (() => {
      const built = createScoringInput({
        attemptId: attempt.attemptId,
        pin: {
          examProfileVersionId: attempt.examProfileVersionId,
          markingRuleSetHash: attempt.markingRuleSetHash,
          ruleSchemaVersion: spec.value.markingRuleSet.schemaVersion,
          taxonomyVersionId: attempt.taxonomyVersionId,
          itemVersionIds: [slot.itemVersionId],
        },
        sections: [
          {
            ordinal: 1,
            slots: [
              {
                slotId,
                ordinal: 1,
                itemType: key.itemType,
                itemVersionId: slot.itemVersionId,
                marksAvailable: 1,
                answerKey: answerKey.value,
                ...(response === undefined ? {} : { response }),
              },
            ],
          },
        ],
        overrides: [],
      });
      return built.ok ? built.value : undefined;
    })();
    if (input === undefined) return err(applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', 'the response could not be put to marking', 'slotId'));

    const verdict = await this.deps.judge.handle(
      { input, ruleSet: spec.value.markingRuleSet, ruleSetHash: attempt.markingRuleSetHash, aggregation: spec.value.aggregation },
      system,
    );
    if (!verdict.ok) return err(applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', 'marking could not judge this response', 'slotId'));
    const judged = verdict.value.find((entry) => entry.slotRef === slotId);
    return judged === undefined ? err(applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', 'marking returned no verdict for this slot', 'slotId')) : ok(judged.outcome);
  }
}
