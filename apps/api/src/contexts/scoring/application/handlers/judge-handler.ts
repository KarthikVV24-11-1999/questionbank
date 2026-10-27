import { err, ok, type Result } from '../../domain/result.js';
import { scoreAttemptAtPinnedVersion } from '../../domain/schema-version-registry.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, IdentifierFactory } from '../ports.js';
import type { Handler } from '../handler-registry.js';
import type { JudgeSlots } from '../commands/scoring-commands.js';
import { ROLES } from '../../../../platform/auth/roles.js';

/**
 * `JudgeSlots` — what the marking rules say of some responses, **written nowhere** (M7-29).
 *
 * Practice shows a learner whether their answer was right straight away, and the rule for what counts as right is scoring's: the same pure
 * function that scores an attempt, run over the slots it is given. This handler is that function with the persistence taken off — it makes no score
 * record, emits no event and leaves no trace — and it answers with the slot's reference and the correctness the rule attributed, and nothing else: not
 * the marks, not the rule's explanation, not the key. A practice slot belongs to no form, so it carries no marks of its own to award.
 *
 * It is the system's alone, so a learner reaches it only through assessment's handler, which has already checked that the response is theirs.
 */
export const JUDGE_SLOTS_POLICY = policy('JudgeSlots', [ROLES.system]);

export interface JudgedSlot {
  readonly slotRef: string;
  /** `correct`, `incorrect`, `unattempted`, or `indeterminate` — a rule's attribution, as scoring's `Correctness`. */
  readonly outcome: string;
}

export interface JudgeDependencies {
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
}

export class JudgeSlotsHandler implements Handler<JudgeSlots, readonly JudgedSlot[]> {
  readonly name = 'JudgeSlots';
  readonly policy = JUDGE_SLOTS_POLICY;

  constructor(private readonly deps: JudgeDependencies) {}

  async handle(command: JudgeSlots, context: ApplicationContext): Promise<Result<readonly JudgedSlot[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const judged = scoreAttemptAtPinnedVersion({
      input: command.input,
      ruleSet: command.ruleSet,
      ruleSetHash: command.ruleSetHash,
      aggregation: command.aggregation,
      computedAt: this.deps.clock.now().toISOString(),
      scoreRecordId: this.deps.identifiers.next(),
    });
    if (!judged.ok) return err(applicationError(judged.error.kind, judged.error.code, judged.error.message));
    return ok(
      Object.freeze(judged.value.itemOutcomes.map((outcome) => Object.freeze({ slotRef: outcome.slotId, outcome: outcome.correctness }))),
    );
  }
}
