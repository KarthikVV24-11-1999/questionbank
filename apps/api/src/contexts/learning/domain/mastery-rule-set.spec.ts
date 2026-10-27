import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { D002_THRESHOLDS, thresholdsWith } from '../../../testing/learning-thresholds.js';
import { canonicalJson, createMasteryRuleSet, hashThresholds, validateThresholds } from './mastery-rule-set.js';

const ID = '3f2b8a52-6f0c-4c1e-9a52-0d4b1c7e9a10';

describe('validating thresholds', () => {
  it('accepts D-002 as written and returns it frozen, group by group', () => {
    const valid = expectValue(validateThresholds(D002_THRESHOLDS));
    expect(valid).toEqual(D002_THRESHOLDS);
    for (const group of [valid, valid.promotion, valid.verification, valid.session, valid.states, valid.decay]) expect(Object.isFrozen(group)).toBe(true);
  });

  it('refuses a missing group, a non-object and null, naming what is needed', () => {
    for (const bad of [null, undefined, 7, 'x', {}, ...(['promotion', 'verification', 'session', 'states', 'decay'] as const).map((group) => ({ ...D002_THRESHOLDS, [group]: undefined }))]) {
      expect(expectError(validateThresholds(bad)).code).toBe('RULE_SET_THRESHOLDS_INVALID');
    }
  });

  it('refuses each value that is out of its own range, naming the field', () => {
    const cases: [string, Parameters<typeof thresholdsWith>[0]][] = [
      ['promotion.minResponses', { promotion: { minResponses: 0 } }],
      ['promotion.minDistinctItems', { promotion: { minDistinctItems: 1.5 } }],
      ['promotion.minDistinctSessions', { promotion: { minDistinctSessions: -1 } }],
      ['promotion.recentWindow', { promotion: { recentWindow: 0 } }],
      ['promotion.minRecentAtDemonstratedBand', { promotion: { minRecentAtDemonstratedBand: 0 } }],
      ['promotion.minRecentAccuracy', { promotion: { minRecentAccuracy: 0 } }],
      ['promotion.minRecentAccuracy', { promotion: { minRecentAccuracy: 1.01 } }],
      ['verification.minVerifyingResponses', { verification: { minVerifyingResponses: 0 } }],
      ['verification.minGapHours', { verification: { minGapHours: 0 } }],
      ['session.idleGapMinutes', { session: { idleGapMinutes: 0 } }],
      ['states.weakBelowAccuracy', { states: { weakBelowAccuracy: 1 } }],
      ['decay.halfLifeDays', { decay: { halfLifeDays: Number.NaN } }],
      ['decay.confidenceFloor', { decay: { confidenceFloor: 1 } }],
    ];
    for (const [field, changes] of cases) {
      const error = expectError(validateThresholds(thresholdsWith(changes)));
      expect(error.message, field).toContain(field);
    }
  });

  it('accepts a verification accuracy of exactly one, the boundary of its range', () => {
    expect(expectValue(validateThresholds(thresholdsWith({ promotion: { minRecentAccuracy: 1 } }))).promotion.minRecentAccuracy).toBe(1);
  });

  it('refuses values that are each fine alone and mean nothing together', () => {
    const cases: [string, Parameters<typeof thresholdsWith>[0]][] = [
      ['recentWindow cannot exceed', { promotion: { recentWindow: 9 } }],
      ['minRecentAtDemonstratedBand cannot exceed', { promotion: { minRecentAtDemonstratedBand: 9 } }],
      ['minDistinctItems cannot exceed', { promotion: { minDistinctItems: 9 } }],
      ['weakBelowAccuracy cannot exceed', { states: { weakBelowAccuracy: 0.9 } }],
    ];
    for (const [message, changes] of cases) {
      expect(expectError(validateThresholds(thresholdsWith(changes))).message).toContain(message);
    }
  });
});

describe('naming a version by what it says', () => {
  it('hashes the same thresholds to the same bytes however the keys were ordered', () => {
    const reordered = { decay: D002_THRESHOLDS.decay, states: D002_THRESHOLDS.states, session: D002_THRESHOLDS.session, verification: D002_THRESHOLDS.verification, promotion: D002_THRESHOLDS.promotion };
    expect(hashThresholds(reordered)).toBe(hashThresholds(D002_THRESHOLDS));
    expect(hashThresholds(D002_THRESHOLDS)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('hashes differently when any one value changes: the set, not a loop over what was tried', () => {
    const base = hashThresholds(D002_THRESHOLDS);
    const changed = [
      thresholdsWith({ promotion: { minResponses: 9 } }),
      thresholdsWith({ promotion: { minRecentAccuracy: 0.9 } }),
      thresholdsWith({ verification: { minGapHours: 24 } }),
      thresholdsWith({ session: { idleGapMinutes: 45 } }),
      thresholdsWith({ decay: { halfLifeDays: 30 } }),
    ].map(hashThresholds);
    expect(new Set([base, ...changed]).size).toBe(6);
  });

  it('writes keys sorted at every depth and handles arrays and scalars', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":1}]},"b":1}');
  });

  it('builds a version with its hash, and takes a scope of null as the platform default', () => {
    const set = expectValue(createMasteryRuleSet({ ruleSetId: ID, taxonomyVersionId: null, versionNo: 3, thresholds: D002_THRESHOLDS }));
    expect(set).toMatchObject({ ruleSetId: ID, taxonomyVersionId: null, versionNo: 3, thresholdsHash: hashThresholds(D002_THRESHOLDS) });
    expect(Object.isFrozen(set)).toBe(true);
    expect(expectValue(createMasteryRuleSet({ ruleSetId: ID, taxonomyVersionId: ID, versionNo: 1, thresholds: D002_THRESHOLDS })).taxonomyVersionId).toBe(ID);
  });

  it('refuses a reference that is not one, and thresholds that are not valid', () => {
    for (const bad of [{ ruleSetId: 'x' }, { taxonomyVersionId: 'x' }, { taxonomyVersionId: undefined }, { versionNo: 0 }, { versionNo: 1.5 }]) {
      const props = { ruleSetId: ID, taxonomyVersionId: null, versionNo: 1, thresholds: D002_THRESHOLDS, ...bad };
      expect(expectError(createMasteryRuleSet(props)).code).toBe('RULE_SET_REFERENCE_INVALID');
    }
    expect(expectError(createMasteryRuleSet({ ruleSetId: ID, taxonomyVersionId: null, versionNo: 1, thresholds: {} })).code).toBe('RULE_SET_THRESHOLDS_INVALID');
  });
});
