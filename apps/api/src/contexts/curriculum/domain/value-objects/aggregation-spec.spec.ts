import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createAggregationSpec,
  DEFAULT_AGGREGATION,
  ROUNDING_MODES,
  SECTION_AGGREGATIONS,
  TOTAL_AGGREGATIONS,
} from './aggregation-spec.js';
import { hashMarkingRuleSet } from './marking-rule-set-hash.js';
import { MarkingRuleSet } from './marking-rule-set.js';
import { JEE_ADVANCED_RULE_SET, JEE_MAIN_RULE_SET } from '../../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const GOLDEN = fileURLToPath(new URL('../../../../testing/golden/marking-rule-set-hashes.json', import.meta.url));

describe('the default specification', () => {
  it('reproduces JEE Main with no configuration', () => {
    const spec = expectValue(createAggregationSpec());
    expect(spec).toEqual(DEFAULT_AGGREGATION);
    expect(spec.sectionAggregation).toBe('SUM');
    expect(spec.totalAggregation).toBe('SUM_OF_SECTIONS');
    expect(spec.floorAtZero).toBe(false);
    expect(spec.rounding).toEqual({ mode: 'NONE', decimalPlaces: 0 });
  });

  it('carries no bestOf by default', () => {
    expect(expectValue(createAggregationSpec()).bestOf).toBeUndefined();
  });

  it('states the rounding mode explicitly rather than inheriting one', () => {
    expect(DEFAULT_AGGREGATION.rounding.mode).toBe('NONE');
  });
});

describe('validation', () => {
  it('rejects an unknown section aggregation', () => {
    expect(expectError(createAggregationSpec({ sectionAggregation: 'MEAN' as never })).code).toBe(
      'SECTION_AGGREGATION_UNKNOWN',
    );
  });

  it('rejects an unknown total aggregation', () => {
    expect(expectError(createAggregationSpec({ totalAggregation: 'MAX' as never })).code).toBe(
      'TOTAL_AGGREGATION_UNKNOWN',
    );
  });

  it('rejects an unknown rounding mode', () => {
    expect(
      expectError(createAggregationSpec({ rounding: { mode: 'BANKERS' as never, decimalPlaces: 2 } })).code,
    ).toBe('ROUNDING_MODE_UNKNOWN');
  });

  it('rejects negative or fractional decimal places', () => {
    expect(expectError(createAggregationSpec({ rounding: { mode: 'HALF_UP', decimalPlaces: -1 } })).code).toBe(
      'DECIMAL_PLACES_INVALID',
    );
    expect(expectError(createAggregationSpec({ rounding: { mode: 'HALF_UP', decimalPlaces: 1.5 } })).code).toBe(
      'DECIMAL_PLACES_INVALID',
    );
  });

  it('accepts an explicit rounding specification', () => {
    const spec = expectValue(createAggregationSpec({ rounding: { mode: 'HALF_UP', decimalPlaces: 2 } }));
    expect(spec.rounding).toEqual({ mode: 'HALF_UP', decimalPlaces: 2 });
  });

  it('accepts floorAtZero when an exam wants it', () => {
    expect(expectValue(createAggregationSpec({ floorAtZero: true })).floorAtZero).toBe(true);
  });

  it('declares one mode for each aggregation axis in v1', () => {
    expect([...SECTION_AGGREGATIONS]).toEqual(['SUM']);
    expect([...TOTAL_AGGREGATIONS]).toEqual(['SUM_OF_SECTIONS']);
    expect([...ROUNDING_MODES]).toEqual(['NONE', 'HALF_UP']);
  });
});

describe('bestOf — NEET Section B scores the best 10 of 15', () => {
  it('accepts a best-of rule', () => {
    const spec = expectValue(createAggregationSpec({ bestOf: [{ sectionOrdinal: 2, countScored: 10 }] }));
    expect(spec.bestOf).toEqual([{ sectionOrdinal: 2, countScored: 10 }]);
  });

  it('accepts a best-of rule per section', () => {
    const spec = expectValue(
      createAggregationSpec({
        bestOf: [
          { sectionOrdinal: 2, countScored: 10 },
          { sectionOrdinal: 4, countScored: 10 },
        ],
      }),
    );
    expect(spec.bestOf).toHaveLength(2);
  });

  it('rejects a section ordinal below one', () => {
    expect(expectError(createAggregationSpec({ bestOf: [{ sectionOrdinal: 0, countScored: 10 }] })).code).toBe(
      'BEST_OF_SECTION_INVALID',
    );
  });

  it('rejects a fractional section ordinal', () => {
    expect(expectError(createAggregationSpec({ bestOf: [{ sectionOrdinal: 1.5, countScored: 10 }] })).code).toBe(
      'BEST_OF_SECTION_INVALID',
    );
  });

  it('rejects a count below one', () => {
    expect(expectError(createAggregationSpec({ bestOf: [{ sectionOrdinal: 2, countScored: 0 }] })).code).toBe(
      'BEST_OF_COUNT_INVALID',
    );
  });

  it('rejects a fractional count', () => {
    expect(expectError(createAggregationSpec({ bestOf: [{ sectionOrdinal: 2, countScored: 2.5 }] })).code).toBe(
      'BEST_OF_COUNT_INVALID',
    );
  });

  it('rejects two best-of rules on one section', () => {
    const duplicated = [
      { sectionOrdinal: 2, countScored: 10 },
      { sectionOrdinal: 2, countScored: 12 },
    ];
    expect(expectError(createAggregationSpec({ bestOf: duplicated })).code).toBe('BEST_OF_SECTION_DUPLICATE');
  });
});

describe('immutability', () => {
  it('freezes the specification and its nested parts', () => {
    const spec = expectValue(
      createAggregationSpec({
        bestOf: [{ sectionOrdinal: 2, countScored: 10 }],
        rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
      }),
    );
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.rounding)).toBe(true);
    expect(Object.isFrozen(spec.bestOf)).toBe(true);
    expect(Object.isFrozen(spec.bestOf?.[0])).toBe(true);
  });

  it('does not alias the caller’s bestOf array', () => {
    const mutable = [{ sectionOrdinal: 2, countScored: 10 }];
    const spec = expectValue(createAggregationSpec({ bestOf: mutable }));
    mutable.push({ sectionOrdinal: 3, countScored: 5 });
    expect(spec.bestOf).toHaveLength(1);
  });
});

describe('no published rule-set hash moves (ADR-0006)', () => {
  it('leaves the golden hashes exactly as M1 froze them', () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, string>;
    const jeeMain = expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET));
    const jeeAdvanced = expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET));

    expect(hashMarkingRuleSet(jeeMain)).toBe(golden['jeeMain']);
    expect(hashMarkingRuleSet(jeeAdvanced)).toBe(golden['jeeAdvanced']);
  });

  it('keeps aggregation off the rule set entirely', () => {
    // The whole point of ADR-0006: the hashed structure has no aggregation
    // field to hash, so adding aggregation reissues nothing.
    expect(Object.keys(JEE_MAIN_RULE_SET)).toEqual(['schemaVersion', 'rules']);
  });
});
