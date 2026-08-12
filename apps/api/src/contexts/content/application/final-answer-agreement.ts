import {
  evaluateExactMatch,
  type ConditionOutcome,
  type ResponseSnapshot,
} from '../../scoring/public/index.js';
import type { FinalAnswerAssertion, SolutionVersion } from '../domain/solution.js';
import type { ResponseSpecification } from '../domain/response-specification.js';
import { err, ok, type Result } from '../domain/result.js';
import { validationError, type ContentError } from '../domain/content-error.js';
import { projectValidatedAnswerKey } from './answer-key-projection.js';

/**
 * Does the solution's stated final answer match the item's key?
 * (DOMAIN-MODEL §5, FR-TCH-07 rule 1.)
 *
 * **Blocking, not advisory.** A solution that contradicts the key is the defect
 * class that produces answer-key challenges: the learner reads a worked
 * derivation ending in 9.8, answers 9.8, is marked wrong, and is entirely
 * right to dispute it. Catching it at authoring costs an author a minute;
 * catching it after publication costs a re-scoring operation and a cohort's
 * trust.
 *
 * **The executor decides, not a comparison written here.** The solution's
 * assertion is expressed as the response a learner would have given and handed
 * to `evaluateExactMatch` from `scoring/public/` — the same function
 * `EXACT_MATCH` uses. Everything that makes numeric correctness subtle
 * (tolerance, comparison mode, units, accepted forms, normalization) therefore
 * applies exactly as it will at scoring time.
 *
 * **Agreement means "the executor would mark this correct".** A solution
 * asserting a value inside the item's own tolerance band agrees, because a
 * learner answering it is marked correct and no defect exists. The rule guards
 * against a solution that would get a learner marked *wrong* — not against
 * authorial imprecision, which is a review matter rather than a scoring one.
 *
 * `indeterminate` is not agreement. A solution omitting a unit the
 * specification requires is one the executor could not mark correct either.
 *
 * This lives in `application/` because it reaches `scoring/public/`, and
 * `domain/` imports nothing.
 */

export type AgreementErrorCode =
  | 'FINAL_ANSWER_SHAPE_MISMATCH'
  | 'FINAL_ANSWER_DISAGREES_WITH_KEY'
  | 'FINAL_ANSWER_INDETERMINATE'
  | 'ANSWER_KEY_UNUSABLE';

export type AgreementError = ContentError<AgreementErrorCode>;

/** The assertion as the response snapshot a learner would have produced. */
function toResponseSnapshot(
  assertion: FinalAnswerAssertion,
  spec: ResponseSpecification,
): Result<ResponseSnapshot, AgreementError> {
  const mismatch = (): Result<never, AgreementError> =>
    err(
      validationError(
        'FINAL_ANSWER_SHAPE_MISMATCH',
        `a ${spec.itemType} item cannot be answered with a ${assertion.kind} assertion`,
        'solution.finalAnswerAssertion',
      ),
    );

  switch (spec.itemType) {
    case 'SINGLE_CORRECT_MCQ':
      return assertion.kind === 'OPTION'
        ? ok({ kind: 'OPTION_SELECTION', optionIds: [assertion.optionId] })
        : mismatch();

    case 'MULTIPLE_CORRECT_MCQ':
      return assertion.kind === 'OPTION_SET'
        ? ok({ kind: 'OPTION_SELECTION', optionIds: [...assertion.optionIds] })
        : mismatch();

    case 'MATCHING':
      return assertion.kind === 'PAIRS'
        ? ok({ kind: 'MATCHING', pairs: assertion.pairs.map((pair) => ({ ...pair })) })
        : mismatch();

    case 'NUMERIC':
      return assertion.kind === 'NUMERIC'
        ? ok({
            kind: 'NUMERIC_ENTRY',
            // The unit is included exactly as the solution stated it. A
            // specification with `unit.required` treats a missing unit as
            // indeterminate, and a solution that omits it is one the executor
            // could not mark correct either — so the omission must reach the
            // evaluator rather than being papered over here.
            raw: assertion.unit === undefined ? assertion.value : `${assertion.value} ${assertion.unit}`,
          })
        : mismatch();
  }
}

/**
 * Whether the solution's final answer is what the item's key calls correct.
 *
 * Names the disagreement so the editor can show it beside the key (M3-41).
 */
export function checkFinalAnswerMatchesKey(
  solutionVersion: SolutionVersion,
  spec: ResponseSpecification,
): Result<true, AgreementError> {
  const key = projectValidatedAnswerKey(spec);
  if (!key.ok) {
    return err(
      validationError(
        'ANSWER_KEY_UNUSABLE',
        `agreement cannot be decided because the item's key is not usable: ${key.error.message}`,
        'responseSpec',
      ),
    );
  }

  const snapshot = toResponseSnapshot(solutionVersion.finalAnswerAssertion, spec);
  if (!snapshot.ok) return err(snapshot.error);

  const outcome: ConditionOutcome = evaluateExactMatch(snapshot.value, key.value);

  switch (outcome) {
    case 'matched':
      return ok(true);

    case 'indeterminate':
      return err(
        validationError(
          'FINAL_ANSWER_INDETERMINATE',
          `the executor cannot read ${describe(solutionVersion.finalAnswerAssertion)} as an answer to this item — a required unit or an accepted form is missing`,
          'solution.finalAnswerAssertion',
        ),
      );

    case 'not_matched':
      return err(
        validationError(
          'FINAL_ANSWER_DISAGREES_WITH_KEY',
          `the solution states ${describe(solutionVersion.finalAnswerAssertion)}, which is not what this item's key calls correct`,
          'solution.finalAnswerAssertion',
        ),
      );
  }
}

function describe(assertion: FinalAnswerAssertion): string {
  switch (assertion.kind) {
    case 'OPTION':
      return `option ${assertion.optionId}`;
    case 'OPTION_SET':
      return `options ${[...assertion.optionIds].sort().join(', ')}`;
    case 'PAIRS':
      return `the pairing ${assertion.pairs.map((pair) => `${pair.left}→${pair.right}`).join(', ')}`;
    case 'NUMERIC':
      return assertion.unit === undefined ? assertion.value : `${assertion.value} ${assertion.unit}`;
  }
}

/** The boolean M3-11's publication precondition consumes. */
export function solutionAgreesWithKey(
  solutionVersion: SolutionVersion,
  spec: ResponseSpecification,
): boolean {
  return checkFinalAnswerMatchesKey(solutionVersion, spec).ok;
}
