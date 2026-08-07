import { describe, expect, it } from 'vitest';
import { makeRational } from '../numeric/decimal.js';
import { createAnswerKey, type AnswerKey } from '../answer-key.js';
import { createScoringInput, type CreateScoredSlot, type ScoredSlot, type ScoringInput, type SlotOverride } from '../scoring-input.js';
import { disposeSlot, overridesBySlotId } from './apply-overrides.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const authoredKey: AnswerKey = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const correctedKey: AnswerKey = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'C' }));

function draft(overrides: Partial<CreateScoredSlot> = {}): CreateScoredSlot {
  return {
    slotId: 'slot-1',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: 'iv-1',
    marksAvailable: 4,
    answerKey: authoredKey,
    ...overrides,
  };
}

/** A validated slot, as the executor sees it. */
function slot(overrides: Partial<CreateScoredSlot> = {}): ScoredSlot {
  const built = input([], [draft(overrides)]);
  return built.sections[0]?.slots[0] as ScoredSlot;
}

function input(overrides: readonly SlotOverride[] = [], slots: readonly CreateScoredSlot[] = [draft()]): ScoringInput {
  return expectValue(
    createScoringInput({
      attemptId: 'attempt-1',
      pin: {
        examProfileVersionId: 'epv-1',
        markingRuleSetHash: 'hash',
        ruleSchemaVersion: 1,
        taxonomyVersionId: 'tax-1',
        itemVersionIds: ['iv-1'],
      },
      sections: [{ ordinal: 1, slots }],
      overrides,
    }),
  );
}

describe('a slot with no override', () => {
  it('scores normally against its authored key', () => {
    expect(disposeSlot(slot(), undefined)).toEqual({ kind: 'SCORE_NORMALLY', key: authoredKey });
  });
});

describe('DROPPED', () => {
  const override: SlotOverride = { kind: 'DROPPED', slotId: 'slot-1', reason: 'key defect confirmed' };

  it('disposes the slot as dropped, carrying the reason', () => {
    expect(disposeSlot(slot(), override)).toEqual({ kind: 'DROPPED', reason: 'key defect confirmed' });
  });

  it('never yields a key, so the slot cannot reach the rule loop', () => {
    expect(disposeSlot(slot(), override)).not.toHaveProperty('key');
  });

  it('disposes as dropped whatever the response was', () => {
    const answered = slot({ response: { kind: 'OPTION_SELECTION', optionIds: ['B'] } });
    expect(disposeSlot(answered, override).kind).toBe('DROPPED');
  });
});

describe('BONUS', () => {
  const override: SlotOverride = { kind: 'BONUS', slotId: 'slot-1', reason: 'challenge upheld' };

  it('disposes the slot as a bonus, carrying the reason', () => {
    expect(disposeSlot(slot(), override)).toEqual({ kind: 'BONUS', reason: 'challenge upheld' });
  });

  it('disposes as a bonus for an unattempted slot — it pays regardless of response', () => {
    expect(disposeSlot(slot(), override).kind).toBe('BONUS');
  });

  it('disposes as a bonus for a wrong response', () => {
    const wrong = slot({ response: { kind: 'OPTION_SELECTION', optionIds: ['A'] } });
    expect(disposeSlot(wrong, override).kind).toBe('BONUS');
  });

  it('never yields a key, so no rule can contradict the override', () => {
    expect(disposeSlot(slot(), override)).not.toHaveProperty('key');
  });
});

describe('KEY_CORRECTED', () => {
  const override: SlotOverride = {
    kind: 'KEY_CORRECTED',
    slotId: 'slot-1',
    reason: 'answer key challenge upheld',
    replacementKey: correctedKey,
  };

  it('scores normally, but against the replacement key', () => {
    expect(disposeSlot(slot(), override)).toEqual({ kind: 'SCORE_NORMALLY', key: correctedKey });
  });

  it('does not return the authored key', () => {
    const disposition = disposeSlot(slot(), override);
    expect(disposition.kind === 'SCORE_NORMALLY' ? disposition.key : null).not.toBe(authoredKey);
  });
});

describe('indexing overrides by slot', () => {
  it('indexes an empty override list', () => {
    expect(overridesBySlotId(input()).size).toBe(0);
  });

  it('indexes each override under its slot', () => {
    const two = [draft(), draft({ slotId: 'slot-2', ordinal: 2 })];
    const overrides: SlotOverride[] = [
      { kind: 'DROPPED', slotId: 'slot-1', reason: 'a' },
      { kind: 'BONUS', slotId: 'slot-2', reason: 'b' },
    ];
    const index = overridesBySlotId(input(overrides, two));
    expect(index.get('slot-1')?.kind).toBe('DROPPED');
    expect(index.get('slot-2')?.kind).toBe('BONUS');
  });

  it('returns undefined for a slot with no override', () => {
    const two = [draft(), draft({ slotId: 'slot-2', ordinal: 2 })];
    const index = overridesBySlotId(input([{ kind: 'DROPPED', slotId: 'slot-1', reason: 'a' }], two));
    expect(index.get('slot-2')).toBeUndefined();
  });
});

describe('invalid overrides are unconstructible, not merely unhandled (DEC-3)', () => {
  it('rejects an override naming an unknown slot at construction', () => {
    const result = createScoringInput({
      attemptId: 'attempt-1',
      pin: {
        examProfileVersionId: 'epv-1',
        markingRuleSetHash: 'hash',
        ruleSchemaVersion: 1,
        taxonomyVersionId: 'tax-1',
        itemVersionIds: ['iv-1'],
      },
      sections: [{ ordinal: 1, slots: [draft()] }],
      overrides: [{ kind: 'DROPPED', slotId: 'slot-99', reason: 'typo' }],
    });
    expect(expectError(result).code).toBe('OVERRIDE_SLOT_UNKNOWN');
  });

  it('rejects two overrides on one slot at construction', () => {
    const result = createScoringInput({
      attemptId: 'attempt-1',
      pin: {
        examProfileVersionId: 'epv-1',
        markingRuleSetHash: 'hash',
        ruleSchemaVersion: 1,
        taxonomyVersionId: 'tax-1',
        itemVersionIds: ['iv-1'],
      },
      sections: [{ ordinal: 1, slots: [draft()] }],
      overrides: [
        { kind: 'DROPPED', slotId: 'slot-1', reason: 'a' },
        { kind: 'BONUS', slotId: 'slot-1', reason: 'b' },
      ],
    });
    expect(expectError(result).code).toBe('OVERRIDE_DUPLICATE');
  });
});
