import type { AnswerKey } from '../answer-key.js';
import type { Condition } from '../marking-rule-data.js';
import type { ResponseSnapshot, ScoredSlot } from '../scoring-input.js';
import { normalizeNumericEntry } from '../numeric/normalize.js';
import { compareNumeric } from '../numeric/compare.js';
import { checkUnit } from '../numeric/unit.js';
import { detectAnswerForm, isFormAccepted } from '../numeric/answer-form.js';

/**
 * The eight conditions (ASSESSMENT-ENGINE §2.2), evaluated.
 *
 * **Evaluation is three-valued, not boolean.** `indeterminate` is the whole
 * point: a numeric entry that cannot be parsed, or a response whose shape does
 * not fit its answer key, is neither a match nor a recognised wrong answer. If
 * the result were boolean it would collapse into `not_matched`, `NO_MATCH`
 * would catch it, and a candidate would lose a mark for a gap in the engine.
 * Three-valued evaluation is what makes ADR-0003 structural rather than a
 * convention someone must remember.
 *
 * An indeterminate response matches no authored condition and therefore falls
 * through to the terminal `ALWAYS`, which awards 0.
 */
export type ConditionOutcome = 'matched' | 'not_matched' | 'indeterminate';

function toOutcome(matched: boolean): ConditionOutcome {
  return matched ? 'matched' : 'not_matched';
}

function selectedOptions(response: ResponseSnapshot): readonly string[] | undefined {
  return response.kind === 'OPTION_SELECTION' ? response.optionIds : undefined;
}

/**
 * Whether the response is exactly right. Shared by `EXACT_MATCH` and
 * `NO_MATCH` so the two can never drift into disagreeing about what "right"
 * means — `NO_MATCH` is the inversion of this, never a second opinion.
 *
 * Exported through `scoring/public/` because Content asks the same question
 * when it checks that a solution's stated final answer is what the item's key
 * calls correct (M3-14). That check has to mean what it will mean at scoring
 * time, and the only way to guarantee that is to run the same function — a
 * comparison written in Content that resembles this one would disagree the
 * first time a tolerance, a unit rule or an accepted form was involved.
 */
export function evaluateExactness(response: ResponseSnapshot, key: AnswerKey): ConditionOutcome {
  switch (key.kind) {
    case 'SINGLE_CORRECT': {
      const selected = selectedOptions(response);
      if (selected === undefined) return 'indeterminate';
      return toOutcome(selected.length === 1 && selected[0] === key.optionId);
    }

    case 'MULTI_CORRECT': {
      const selected = selectedOptions(response);
      if (selected === undefined) return 'indeterminate';
      const correct = new Set(key.correctOptionIds);
      const chosen = new Set(selected);
      return toOutcome(chosen.size === correct.size && [...chosen].every((option) => correct.has(option)));
    }

    case 'MATCHING': {
      if (response.kind !== 'MATCHING') return 'indeterminate';
      const expected = new Map(key.pairs.map((pair) => [pair.left, pair.right]));
      const allCorrect = response.pairs.every((pair) => expected.get(pair.left) === pair.right);
      return toOutcome(allCorrect && response.pairs.length === key.pairs.length);
    }

    case 'NUMERIC': {
      if (response.kind !== 'NUMERIC_ENTRY') return 'indeterminate';

      const normalized = normalizeNumericEntry(response.raw, key.spec.normalization);
      if (!normalized.ok) return 'indeterminate';

      // A form the author excluded is a recognised wrong answer, not an
      // unreadable one: `acceptedForms: [DECIMAL]` usually means converting to
      // a decimal is part of what the item tests, so a fraction answers a
      // different question. The author's restriction is honoured.
      const form = detectAnswerForm(normalized.value.value);
      if (!isFormAccepted(form, key.spec.acceptedForms)) return 'not_matched';

      const unit = checkUnit(normalized.value.unit, key.spec);
      if (unit === 'missing') return 'indeterminate';
      if (unit === 'mismatch') return 'not_matched';

      const comparison = compareNumeric(normalized.value.value, key.spec);
      if (!comparison.ok) return 'indeterminate';
      return toOutcome(comparison.value);
    }
  }
}

function countCorrectAndIncorrect(
  selected: readonly string[],
  correctOptionIds: readonly string[],
): { readonly correct: number; readonly incorrect: number } {
  const correct = new Set(correctOptionIds);
  const chosen = new Set(selected);
  let matched = 0;
  let unmatched = 0;
  for (const option of chosen) {
    if (correct.has(option)) matched += 1;
    else unmatched += 1;
  }
  return { correct: matched, incorrect: unmatched };
}

export function evaluateCondition(
  condition: Condition,
  slot: ScoredSlot,
  key: AnswerKey,
): ConditionOutcome {
  const response = slot.response;

  switch (condition.kind) {
    case 'ALWAYS':
      return 'matched';

    case 'UNATTEMPTED':
      return toOutcome(response === undefined);

    case 'EXACT_MATCH':
      if (response === undefined) return 'not_matched';
      return evaluateExactness(response, key);

    case 'NO_MATCH': {
      // "A response exists and is wrong." An absent response is not wrong, and
      // an unreadable one is not recognisably wrong — neither may be penalised.
      if (response === undefined) return 'not_matched';
      const exactness = evaluateExactness(response, key);
      if (exactness === 'indeterminate') return 'indeterminate';
      return toOutcome(exactness === 'not_matched');
    }

    case 'ALL_CORRECT_SELECTED': {
      if (response === undefined) return 'not_matched';
      if (key.kind !== 'MULTI_CORRECT') return 'indeterminate';
      const selected = selectedOptions(response);
      if (selected === undefined) return 'indeterminate';
      const tally = countCorrectAndIncorrect(selected, key.correctOptionIds);
      return toOutcome(tally.correct === key.correctOptionIds.length && tally.incorrect === 0);
    }

    case 'PARTIAL_CORRECT_SELECTED': {
      if (response === undefined) return 'not_matched';
      if (key.kind !== 'MULTI_CORRECT') return 'indeterminate';
      const selected = selectedOptions(response);
      if (selected === undefined) return 'indeterminate';
      const tally = countCorrectAndIncorrect(selected, key.correctOptionIds);
      const enough = tally.correct >= condition.minCorrect;
      const clean = !condition.noIncorrect || tally.incorrect === 0;
      return toOutcome(enough && clean);
    }

    case 'ANY_INCORRECT_SELECTED': {
      if (response === undefined) return 'not_matched';
      if (key.kind !== 'MULTI_CORRECT') return 'indeterminate';
      const selected = selectedOptions(response);
      if (selected === undefined) return 'indeterminate';
      return toOutcome(countCorrectAndIncorrect(selected, key.correctOptionIds).incorrect > 0);
    }

    case 'MATCHING_PAIRS_CORRECT': {
      if (response === undefined) return 'not_matched';
      if (key.kind !== 'MATCHING') return 'indeterminate';
      if (response.kind !== 'MATCHING') return 'indeterminate';
      const expected = new Map(key.pairs.map((pair) => [pair.left, pair.right]));
      const correct = response.pairs.filter((pair) => expected.get(pair.left) === pair.right).length;
      return toOutcome(correct === condition.count);
    }

    default:
      // A condition kind this executor does not know cannot be said to match.
      // It must not match either — a guess here awards or deducts a mark on a
      // predicate nobody wrote.
      return 'not_matched';
  }
}
