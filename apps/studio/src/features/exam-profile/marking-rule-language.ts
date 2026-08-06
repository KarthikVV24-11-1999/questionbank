import type { Award, Condition, MarkingRule } from '@questionbank/contracts';

/**
 * Renders a marking rule in the language a curator reads, not the language the
 * engine executes (M1-34). Order matters: the reader must see that the first
 * match wins.
 */
export function describeCondition(condition: Condition): string {
  switch (condition.kind) {
    case 'UNATTEMPTED':
      return 'the item is unattempted';
    case 'EXACT_MATCH':
      return 'the answer matches exactly';
    case 'NO_MATCH':
      return 'the answer is wrong';
    case 'ALL_CORRECT_SELECTED':
      return 'every correct option is selected and no incorrect one is';
    case 'PARTIAL_CORRECT_SELECTED': {
      const minimum = condition.minCorrect ?? 1;
      const clause = condition.noIncorrect === true ? ' and no incorrect option is selected' : '';
      return `at least ${minimum} correct option${minimum === 1 ? ' is' : 's are'} selected${clause}`;
    }
    case 'ANY_INCORRECT_SELECTED':
      return 'any incorrect option is selected';
    case 'MATCHING_PAIRS_CORRECT':
      return `exactly ${condition.count ?? 0} pairs are matched correctly`;
    case 'ALWAYS':
      return 'nothing above matched';
    default:
      return 'an unrecognised condition holds';
  }
}

export function describeAward(award: Award): string {
  switch (award.kind) {
    case 'FIXED': {
      const marks = award.marks ?? 0;
      if (marks === 0) return '0 marks';
      return `${marks > 0 ? '+' : ''}${marks} mark${Math.abs(marks) === 1 ? '' : 's'}`;
    }
    case 'PER_CORRECT':
      return `${award.marks ?? 0} marks for each correct selection`;
    case 'FULL_MARKS':
      return "the item's full marks";
    default:
      return 'an unrecognised award';
  }
}

/** “If the item is unattempted → 0 marks”. */
export function describeRule(rule: MarkingRule): string {
  return `If ${describeCondition(rule.condition)} → ${describeAward(rule.award)}`;
}
