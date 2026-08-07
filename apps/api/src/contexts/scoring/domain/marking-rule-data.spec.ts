import { describe, expect, it } from 'vitest';
import type {
  Award as BarrelAward,
  Condition as BarrelCondition,
  MarkingRuleSetData as BarrelMarkingRuleSetData,
} from '../../curriculum/public/index.js';
import { JEE_ADVANCED_RULE_SET, JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import {
  AWARD_KINDS,
  CONDITION_KINDS,
  type Award,
  type Condition,
  type MarkingRuleSetData,
} from './marking-rule-data.js';

describe('the mirrored rule types', () => {
  it('declares the same eight condition kinds as curriculum', () => {
    expect([...CONDITION_KINDS]).toEqual([
      'UNATTEMPTED',
      'EXACT_MATCH',
      'NO_MATCH',
      'ALL_CORRECT_SELECTED',
      'PARTIAL_CORRECT_SELECTED',
      'ANY_INCORRECT_SELECTED',
      'MATCHING_PAIRS_CORRECT',
      'ALWAYS',
    ]);
  });

  it('declares the same three award kinds as curriculum', () => {
    expect([...AWARD_KINDS]).toEqual(['FIXED', 'PER_CORRECT', 'FULL_MARKS']);
  });

  it('accepts a condition that came across the barrel', () => {
    const fromBarrel: BarrelCondition = { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true };
    const asScoring: Condition = fromBarrel;
    expect(asScoring.kind).toBe('PARTIAL_CORRECT_SELECTED');
  });

  it('accepts an award that came across the barrel', () => {
    const fromBarrel: BarrelAward = { kind: 'FIXED', marks: -1 };
    const asScoring: Award = fromBarrel;
    expect(asScoring.kind).toBe('FIXED');
  });

  it('accepts the shipped JEE Main rule set unchanged', () => {
    const fromBarrel: BarrelMarkingRuleSetData = JEE_MAIN_RULE_SET;
    const asScoring: MarkingRuleSetData = fromBarrel;
    expect(asScoring.rules).toHaveLength(4);
    expect(asScoring.rules.at(-1)?.condition.kind).toBe('ALWAYS');
  });

  it('accepts the shipped JEE Advanced rule set unchanged', () => {
    const fromBarrel: BarrelMarkingRuleSetData = JEE_ADVANCED_RULE_SET;
    const asScoring: MarkingRuleSetData = fromBarrel;
    expect(asScoring.rules).toHaveLength(7);
  });

  it('confirms the terminal rule awards zero, never a penalty (ADR-0003)', () => {
    for (const ruleSet of [JEE_MAIN_RULE_SET, JEE_ADVANCED_RULE_SET]) {
      const terminal = ruleSet.rules.at(-1);
      expect(terminal?.condition.kind).toBe('ALWAYS');
      expect(terminal?.award).toEqual({ kind: 'FIXED', marks: 0 });
    }
  });
});
