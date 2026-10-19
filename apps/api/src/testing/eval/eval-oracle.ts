import { canonicalJson } from '../../contexts/generation/domain/canonical-json.js';
import type { PrecheckId } from '../../contexts/generation/domain/precheck-vocabulary.js';
import { err, ok } from '../../contexts/generation/domain/result.js';
import { applicationError } from '../../contexts/generation/application/authorization.js';
import type { JudgementProvider, ProposalProvider } from '../../contexts/generation/application/ports.js';
import type { EvalItem } from './eval-corpus.js';

/**
 * The verifier the evaluation corpus runs against — **an oracle, and said so.**
 *
 * The structural checks in the battery are real code over a proposal, so the
 * corpus measures them directly. The judged checks consult a provider, and no live
 * provider exists (D45). What stands in for one here answers each question the way
 * a *competent* verifier would, because it is told the truth about the item: it
 * knows which option is actually correct, whether the solution contradicts the key,
 * whether two options satisfy the stem, whether the content is unsafe.
 *
 * That makes the judged half of the catch rate a measurement of **the battery's
 * wiring and decision logic** — that a verifier's finding becomes a failing
 * blocking verdict and a blocked candidate — and not of a model's sensitivity,
 * which needs a live provider and cannot be measured here. The report says so
 * (`describeEvaluation`), and a spec holds the oracle to its word: blinded, it
 * misses what it was meant to find and the catch rate falls.
 *
 * It finds the item from what a check sends it — the stem, which every corpus item
 * makes unique — and never from a candidate id or a flag in the request.
 */
export interface OracleOptions {
  /** Checks the oracle is blinded for: it answers "fine" to every question put to it for these. */
  readonly blindTo?: readonly PrecheckId[];
}

/** One prompt version per judged check, so the oracle can tell which question it is being asked. */
export type PromptOfCheck = Readonly<Partial<Record<PrecheckId, string>>>;

export function evalOracle(items: readonly EvalItem[], promptOfCheck: PromptOfCheck, options: OracleOptions = {}): ProposalProvider & JudgementProvider {
  const byStem = new Map(items.map((item) => [canonicalJson(item.body['stem']), item]));
  const checkOfPrompt = new Map(Object.entries(promptOfCheck).map(([check, prompt]) => [prompt, check as PrecheckId]));
  const blind = new Set(options.blindTo ?? []);
  const usage = { inputTokens: 900, outputTokens: 120 };

  return {
    async propose() {
      return err(applicationError('Unavailable', 'ORACLE_DOES_NOT_PROPOSE', 'the evaluation oracle verifies; it does not propose'));
    },
    async judge(request) {
      const check = checkOfPrompt.get(request.promptVersionId);
      const item = byStem.get(canonicalJson(request.input['stem']));
      if (check === undefined || item === undefined) {
        return err(applicationError('PreconditionFailed', 'ORACLE_DOES_NOT_KNOW_THE_QUESTION', 'the oracle was asked about something outside the corpus'));
      }
      const fine = (why: string) => ok({ output: { outcome: 'pass', rationale: why }, usage });
      const found = (why: string) => ok({ output: { outcome: 'fail', rationale: why }, usage });
      const blinded = blind.has(check);

      switch (check) {
        case 'answer_verification':
          // A solver working the problem cold: it answers the true option, whatever the proposal claims.
          return ok({ output: { answer: blinded ? (item.body['responseSpec'] as { correctOptionId?: string }).correctOptionId ?? item.trueAnswer : item.trueAnswer }, usage });
        case 'item_solution_key_consistency':
          return !blinded && item.defect === 'solution_contradicts_key' ? found('the solution reaches a different answer than the key') : fine('the solution reaches the keyed answer');
        case 'distractor_validity':
          return !blinded && item.defect === 'two_correct_options' ? found('two options satisfy the stem') : fine('exactly one option is correct');
        case 'safety_appropriateness':
          return !blinded && item.defect === 'unsafe_content' ? found('the content asks for harm to a person') : fine('nothing unsafe');
        case 'syllabus_scope':
        case 'ambiguity_clarity':
          return fine('within scope and unambiguous');
        default:
          return err(applicationError('PreconditionFailed', 'ORACLE_DOES_NOT_KNOW_THE_QUESTION', `the oracle answers no question for ${check}`));
      }
    },
  };
}
