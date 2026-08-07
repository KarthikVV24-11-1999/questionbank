import { describe, expect, it } from 'vitest';
import type {
  AnswerKeyData,
  MatchedPair,
  NumericAnswerSpecData,
  ResponseSnapshot,
  ScoreAttempt,
  CreateScoredSection,
  CreateScoredSlot,
  ScoredSlot,
  ScoringInput,
  ScoringPin,
  SlotOverride,
} from './public/index.js';
import { createAnswerKey, createScoringInput } from './public/index.js';
import { expectValue } from '../../testing/expect-result.js';

/**
 * The M2 → M3 seam.
 *
 * M3 owns `ItemVersion`, which must carry a response specification the
 * executor consumes **unchanged**. M6 then assembles those into an attempt.
 * Neither may reach past `scoring/public/` to do it — this spec is written
 * against the barrel only, so it stops compiling the moment something the
 * seam needs is not exported.
 */

/** What an M3 `ItemVersion` will hold, expressed only in barrel types. */
interface ItemVersionResponseSpec {
  readonly itemType: string;
  readonly answerKey: AnswerKeyData;
  readonly marksAvailable: number;
}

describe('an ItemVersion can carry every answer-key shape the executor accepts', () => {
  const specs: readonly ItemVersionResponseSpec[] = [
    { itemType: 'SINGLE_CORRECT_MCQ', marksAvailable: 4, answerKey: { kind: 'SINGLE_CORRECT', optionId: 'B' } },
    {
      itemType: 'MULTIPLE_CORRECT_MCQ',
      marksAvailable: 4,
      answerKey: { kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'C'] },
    },
    {
      itemType: 'MATCHING',
      marksAvailable: 4,
      answerKey: { kind: 'MATCHING', pairs: [{ left: 'P', right: 'ii' } satisfies MatchedPair] },
    },
    {
      itemType: 'NUMERIC',
      marksAvailable: 4,
      answerKey: {
        kind: 'NUMERIC',
        spec: {
          expectedValue: '9.81',
          comparisonMode: 'ABSOLUTE_TOLERANCE',
          toleranceValue: '0.01',
          unit: { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true },
          acceptedForms: ['DECIMAL', 'SCIENTIFIC'],
        } satisfies NumericAnswerSpecData,
      },
    },
  ];

  for (const spec of specs) {
    it(`round trips a ${spec.itemType} specification into a usable key`, () => {
      const key = expectValue(createAnswerKey(spec.answerKey));
      expect(key.kind).toBe(spec.answerKey.kind);
    });
  }

  it('carries the full NumericAnswerSpec — every mode parameter, unit and form', () => {
    const numeric = specs.find((spec) => spec.itemType === 'NUMERIC') as ItemVersionResponseSpec;
    const key = expectValue(createAnswerKey(numeric.answerKey));
    expect(key.kind === 'NUMERIC' ? key.spec.unit?.canonical : null).toBe('m/s^2');
    expect(key.kind === 'NUMERIC' ? key.spec.acceptedForms : null).toEqual(['DECIMAL', 'SCIENTIFIC']);
    // Normalization flags default rather than being M3's problem to supply.
    expect(key.kind === 'NUMERIC' ? Object.keys(key.spec.normalization).length : 0).toBe(4);
  });
});

describe('an attempt can be assembled from barrel types alone', () => {
  it('builds a scoring input without reaching past the barrel', () => {
    const pin: ScoringPin = {
      examProfileVersionId: 'epv-1',
      markingRuleSetHash: 'hash',
      ruleSchemaVersion: 1,
      taxonomyVersionId: 'tax-1',
      itemVersionIds: ['iv-1'],
    };

    const response: ResponseSnapshot = { kind: 'OPTION_SELECTION', optionIds: ['B'] };
    const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));

    const slot: CreateScoredSlot = {
      slotId: 'slot-1',
      ordinal: 1,
      itemType: 'SINGLE_CORRECT_MCQ',
      itemVersionId: 'iv-1',
      marksAvailable: 4,
      answerKey: key,
      response,
    };

    const section: CreateScoredSection = { ordinal: 1, slots: [slot] };
    const override: SlotOverride = { kind: 'DROPPED', slotId: 'slot-1', reason: 'key defect' };

    const input: ScoringInput = expectValue(
      createScoringInput({ attemptId: 'a-1', pin, sections: [section], overrides: [override] }),
    );
    expect(input.sections[0]?.slots[0]?.slotId).toBe('slot-1');
  });

  it('exposes the ScoreAttempt command as a complete, constructible shape', () => {
    const command: Pick<ScoreAttempt, 'idempotencyKey' | 'ruleSetHash'> = {
      idempotencyKey: 'k-1',
      ruleSetHash: 'hash',
    };
    expect(command.ruleSetHash).toBe('hash');
  });
});

describe('nothing the seam needs lives outside the barrel', () => {
  it('names the exports M3 and M6 depend on', async () => {
    const barrel = await import('./public/index.js');
    // Value exports are deliberately few; the seam is otherwise types, which
    // is what keeps a consumer from mutating scoring state.
    expect(Object.keys(barrel)).toContain('SCORING_EVENT_TYPES');
  });

  it('re-exports the marks helper a consumer needs to read a total', async () => {
    const barrel = await import('./public/index.js');
    expect(typeof barrel.marksToDecimalString).toBe('function');
    expect(barrel.marksToDecimalString({ num: 7n, den: 2n })).toBe('3.5');
  });
});
