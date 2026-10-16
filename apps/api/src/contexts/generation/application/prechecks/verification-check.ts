import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import type { JudgementProvider } from '../ports.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import type { CheckOutcome, PrecheckRunner } from './battery.js';
import { judgeIndependently, type JudgedCheckConfig } from './judge.js';
import { claimedAnswerOf, isVerifiable, normalizeAnswer, solveInputOf } from './solve-input.js';

/** How many independent solves are taken. Unanimity across all of them is required. */
export const SOLVE_COUNT = 2;

/**
 * Check 3 — independent answer verification (AI-ARCHITECTURE §11, blocking).
 *
 * Two independent solves through the provider port, **unanimous agreement
 * required**, and the agreed answer must be the one the proposal claims. Each
 * solve runs under a prompt version that is not the one the candidate was
 * generated with (F29, enforced by the gateway every judged check goes
 * through), and sees the question without the claimed key — "different prompt,
 * no sight of the claimed key, solving cold", because a model checking its own
 * work agrees with itself.
 *
 * **Disagreement auto-rejects and never escalates to a human.** A solve that
 * disagrees with another, or with the claimed key, is a failing blocking verdict
 * carrying every answer given, and a candidate with one can never be accepted.
 * Routing uncertain candidates to reviewers is precisely what destroys the
 * throughput this architecture exists to protect. The candidate is not moved to
 * `rejected` by the machine — deciding is a human act, and the pipeline holds no
 * capability to decide (INV-01) — it is simply unacceptable, with no path to a
 * reviewer's queue.
 *
 * **The CAS branch is not built (D39).** §11 reads "CAS where symbolic;
 * otherwise 2 independent solves", and the repository has no Python and no
 * SymPy. The `otherwise` branch is what ships; the architecture specifies it as
 * the fallback, not as a reduced form of the CAS, so this is the check §11
 * describes for every item type that is not symbolic and, today, for those that
 * are.
 */
export function answerVerificationCheck(deps: {
  readonly judge: JudgementProvider;
  readonly config: JudgedCheckConfig;
}): PrecheckRunner {
  return {
    check: 'answer_verification',
    async run(candidate) {
      const { itemType, body } = candidate.content;
      if (!isVerifiable(itemType)) {
        return err(
          applicationError(
            'PreconditionFailed',
            'ITEM_TYPE_NOT_VERIFIABLE',
            `an independent solve is defined for choice and numeric items, and this is ${itemType}`,
            'content.itemType',
          ),
        );
      }

      const claimed = claimedAnswerOf(itemType, body);
      if (!claimed.ok) return claimed;
      const question = solveInputOf(itemType, body);
      if (!question.ok) return question;

      const answers: unknown[] = [];
      for (let attempt = 1; attempt <= SOLVE_COUNT; attempt += 1) {
        const solved = await judgeIndependently(deps.judge, candidate, 'answer_verification', deps.config, { ...question.value, attempt });
        if (!solved.ok) return solved;

        const answer = normalizeAnswer(itemType, solved.value.output['answer']);
        if (answer === undefined) {
          return err(
            applicationError('Unavailable', 'PROVIDER_REPLY_MALFORMED', `solve ${attempt} returned no usable answer`, `solve ${attempt}`),
          );
        }
        answers.push(answer);
      }

      const unanimous = answers.every((answer) => canonicalJson(answer) === canonicalJson(answers[0]));
      const matchesKey = unanimous && canonicalJson(answers[0]) === canonicalJson(claimed.value);
      const working = `${answers.map((answer, index) => `solve ${index + 1} answered ${JSON.stringify(answer)}`).join('; ')}; the proposal claims ${JSON.stringify(claimed.value)}`;

      if (matchesKey) return ok<CheckOutcome>({ outcome: 'pass', detail: `${SOLVE_COUNT} independent solves agree with the claimed key: ${working}` });
      return ok<CheckOutcome>({
        outcome: 'fail',
        detail: unanimous
          ? `the independent solves agree with each other and not with the claimed key: ${working}`
          : `the independent solves disagree: ${working}`,
      });
    },
  };
}
