import { describe, expect, it } from 'vitest';
import { makeRational } from './numeric/decimal.js';
import {
  allSlots,
  createScoringInput,
  isUnattempted,
  type CreateScoredSlot,
  type CreateScoringInputProps,
  type ScoredSlot,
  type ScoringPin,
} from './scoring-input.js';
import { createAnswerKey, type AnswerKey } from './answer-key.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const SINGLE_KEY: AnswerKey = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const NUMERIC_KEY: AnswerKey = expectValue(
  createAnswerKey({
    kind: 'NUMERIC',
    spec: { expectedValue: '9.81', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL'] },
  }),
);

const PIN: ScoringPin = {
  examProfileVersionId: 'epv-jee-main-2026',
  markingRuleSetHash: '4fe24605633c',
  ruleSchemaVersion: 1,
  taxonomyVersionId: 'tax-jee-2026',
  itemVersionIds: ['iv-1', 'iv-2'],
};

function slot(overrides: Partial<CreateScoredSlot> = {}): CreateScoredSlot {
  return {
    slotId: 'slot-1',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: 'iv-1',
    marksAvailable: 4,
    answerKey: SINGLE_KEY,
    ...overrides,
  };
}

function input(overrides: Partial<CreateScoringInputProps> = {}): CreateScoringInputProps {
  return {
    attemptId: 'attempt-1',
    pin: PIN,
    sections: [{ ordinal: 1, slots: [slot()] }],
    overrides: [],
    ...overrides,
  };
}

describe('createScoringInput', () => {
  it('constructs a valid input', () => {
    const result = expectValue(createScoringInput(input()));
    expect(result.attemptId).toBe('attempt-1');
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.slots).toHaveLength(1);
  });

  it('rejects a blank attemptId', () => {
    expect(expectError(createScoringInput(input({ attemptId: '  ' }))).code).toBe('ATTEMPT_ID_REQUIRED');
  });

  it('returns a Validation error, never a partially-built input', () => {
    const error = expectError(createScoringInput(input({ attemptId: '' })));
    expect(error.kind).toBe('Validation');
  });
});

describe('the pin', () => {
  const requiredFields = ['examProfileVersionId', 'markingRuleSetHash', 'taxonomyVersionId'] as const;

  for (const field of requiredFields) {
    it(`requires pin.${field}`, () => {
      const error = expectError(createScoringInput(input({ pin: { ...PIN, [field]: '  ' } })));
      expect(error.code).toBe('PIN_FIELD_REQUIRED');
      expect(error.message).toContain(field);
    });
  }

  it('requires ruleSchemaVersion to be an integer of at least 1', () => {
    expect(expectError(createScoringInput(input({ pin: { ...PIN, ruleSchemaVersion: 0 } }))).code).toBe(
      'RULE_SCHEMA_VERSION_INVALID',
    );
    expect(expectError(createScoringInput(input({ pin: { ...PIN, ruleSchemaVersion: 1.5 } }))).code).toBe(
      'RULE_SCHEMA_VERSION_INVALID',
    );
  });

  it('requires at least one item version', () => {
    expect(expectError(createScoringInput(input({ pin: { ...PIN, itemVersionIds: [] } }))).code).toBe(
      'ITEM_VERSION_IDS_REQUIRED',
    );
  });

  it('rejects a blank item version identifier', () => {
    expect(expectError(createScoringInput(input({ pin: { ...PIN, itemVersionIds: ['iv-1', ' '] } }))).code).toBe(
      'ITEM_VERSION_ID_BLANK',
    );
  });

  it('carries every pin field through to the constructed input', () => {
    expect(expectValue(createScoringInput(input())).pin).toEqual(PIN);
  });
});

describe('sections and slots', () => {
  it('requires at least one section', () => {
    expect(expectError(createScoringInput(input({ sections: [] }))).code).toBe('SECTIONS_REQUIRED');
  });

  it('requires section ordinals contiguous from 1', () => {
    const gapped = [
      { ordinal: 1, slots: [slot()] },
      { ordinal: 3, slots: [slot({ slotId: 'slot-2' })] },
    ];
    expect(expectError(createScoringInput(input({ sections: gapped }))).code).toBe(
      'SECTION_ORDINALS_NOT_CONTIGUOUS',
    );
  });

  it('rejects sections that do not start at 1', () => {
    const sections = [{ ordinal: 2, slots: [slot()] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('SECTION_ORDINALS_NOT_CONTIGUOUS');
  });

  it('rejects duplicate section ordinals', () => {
    const sections = [
      { ordinal: 1, slots: [slot()] },
      { ordinal: 1, slots: [slot({ slotId: 'slot-2' })] },
    ];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('SECTION_ORDINALS_NOT_CONTIGUOUS');
  });

  it('accepts two contiguous sections', () => {
    const sections = [
      { ordinal: 1, slots: [slot()] },
      { ordinal: 2, slots: [slot({ slotId: 'slot-2' })] },
    ];
    expect(expectValue(createScoringInput(input({ sections }))).sections).toHaveLength(2);
  });

  it('requires at least one slot per section', () => {
    expect(expectError(createScoringInput(input({ sections: [{ ordinal: 1, slots: [] }] }))).code).toBe(
      'SLOTS_REQUIRED',
    );
  });

  it('requires slot ordinals contiguous from 1 within a section', () => {
    const sections = [
      { ordinal: 1, slots: [slot(), slot({ slotId: 'slot-2', ordinal: 3 })] },
    ];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('SLOT_ORDINALS_NOT_CONTIGUOUS');
  });

  it('restarts slot ordinals at 1 in each section', () => {
    const sections = [
      { ordinal: 1, slots: [slot()] },
      { ordinal: 2, slots: [slot({ slotId: 'slot-2', ordinal: 1 })] },
    ];
    expect(expectValue(createScoringInput(input({ sections }))).sections[1]?.slots[0]?.ordinal).toBe(1);
  });

  it('rejects a duplicate slotId across sections', () => {
    const sections = [
      { ordinal: 1, slots: [slot()] },
      { ordinal: 2, slots: [slot({ ordinal: 1 })] },
    ];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('SLOT_ID_DUPLICATE');
  });

  it('rejects a blank slotId', () => {
    const sections = [{ ordinal: 1, slots: [slot({ slotId: ' ' })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('SLOT_ID_REQUIRED');
  });

  it('rejects a blank itemType', () => {
    const sections = [{ ordinal: 1, slots: [slot({ itemType: '' })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('ITEM_TYPE_REQUIRED');
  });

  it('rejects a blank itemVersionId', () => {
    const sections = [{ ordinal: 1, slots: [slot({ itemVersionId: '' })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('SLOT_ITEM_VERSION_ID_REQUIRED');
  });

  it('rejects marksAvailable of zero or less', () => {
    for (const marks of [0, -4]) {
      const sections = [{ ordinal: 1, slots: [slot({ marksAvailable: marks })] }];
      expect(expectError(createScoringInput(input({ sections }))).code).toBe('MARKS_AVAILABLE_INVALID');
    }
  });

  it('rejects a non-finite marksAvailable', () => {
    const sections = [{ ordinal: 1, slots: [slot({ marksAvailable: Number.NaN })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('MARKS_AVAILABLE_INVALID');
  });
});

describe('the projected response', () => {
  it('reads an absent response as unattempted', () => {
    const built = expectValue(createScoringInput(input()));
    const only = built.sections[0]?.slots[0];
    expect(only?.response).toBeUndefined();
    expect(isUnattempted(only as ScoredSlot)).toBe(true);
  });

  it('reads a present response as attempted', () => {
    const sections = [
      { ordinal: 1, slots: [slot({ response: { kind: 'OPTION_SELECTION', optionIds: ['B'] } })] },
    ];
    const built = expectValue(createScoringInput(input({ sections })));
    expect(isUnattempted(built.sections[0]?.slots[0] as ScoredSlot)).toBe(false);
  });

  it('carries each response kind through unchanged', () => {
    const sections = [
      {
        ordinal: 1,
        slots: [
          slot({ response: { kind: 'OPTION_SELECTION', optionIds: ['A', 'C'] } }),
          slot({ slotId: 'slot-2', ordinal: 2, response: { kind: 'NUMERIC_ENTRY', raw: '9.81 m/s^2' } }),
          slot({
            slotId: 'slot-3',
            ordinal: 3,
            response: { kind: 'MATCHING', pairs: [{ left: 'P', right: 'ii' }] },
          }),
        ],
      },
    ];
    const built = expectValue(createScoringInput(input({ sections })));
    expect(built.sections[0]?.slots.map((s) => s.response?.kind)).toEqual([
      'OPTION_SELECTION',
      'NUMERIC_ENTRY',
      'MATCHING',
    ]);
  });

  it('preserves the learner keystrokes verbatim — normalization is the evaluator’s job', () => {
    const raw = '  1,234.50 J  ';
    const sections = [{ ordinal: 1, slots: [slot({ response: { kind: 'NUMERIC_ENTRY', raw } })] }];
    const built = expectValue(createScoringInput(input({ sections })));
    const response = built.sections[0]?.slots[0]?.response;
    expect(response?.kind === 'NUMERIC_ENTRY' ? response.raw : null).toBe(raw);
  });

  it('rejects an empty option selection rather than reading it as unattempted', () => {
    const sections = [{ ordinal: 1, slots: [slot({ response: { kind: 'OPTION_SELECTION', optionIds: [] } })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('RESPONSE_EMPTY');
  });

  it('rejects an empty matching set', () => {
    const sections = [{ ordinal: 1, slots: [slot({ response: { kind: 'MATCHING', pairs: [] } })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('RESPONSE_EMPTY');
  });

  it('rejects a blank numeric entry', () => {
    const sections = [{ ordinal: 1, slots: [slot({ response: { kind: 'NUMERIC_ENTRY', raw: '   ' } })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('RESPONSE_EMPTY');
  });
});

describe('overrides', () => {
  it('accepts an override naming a known slot', () => {
    const built = expectValue(
      createScoringInput(input({ overrides: [{ kind: 'DROPPED', slotId: 'slot-1', reason: 'key defect' }] })),
    );
    expect(built.overrides).toHaveLength(1);
  });

  it('accepts both override kinds', () => {
    const sections = [{ ordinal: 1, slots: [slot(), slot({ slotId: 'slot-2', ordinal: 2 })] }];
    const built = expectValue(
      createScoringInput(
        input({
          sections,
          overrides: [
            { kind: 'DROPPED', slotId: 'slot-1', reason: 'key defect' },
            { kind: 'BONUS', slotId: 'slot-2', reason: 'challenge upheld' },
          ],
        }),
      ),
    );
    expect(built.overrides.map((o) => o.kind)).toEqual(['DROPPED', 'BONUS']);
  });

  it('rejects an override naming an unknown slot rather than ignoring it (DEC-3)', () => {
    const error = expectError(
      createScoringInput(input({ overrides: [{ kind: 'BONUS', slotId: 'slot-99', reason: 'typo' }] })),
    );
    expect(error.code).toBe('OVERRIDE_SLOT_UNKNOWN');
    expect(error.message).toContain('slot-99');
  });

  it('rejects two overrides on one slot', () => {
    const error = expectError(
      createScoringInput(
        input({
          overrides: [
            { kind: 'DROPPED', slotId: 'slot-1', reason: 'first' },
            { kind: 'BONUS', slotId: 'slot-1', reason: 'second' },
          ],
        }),
      ),
    );
    expect(error.code).toBe('OVERRIDE_DUPLICATE');
  });

  it('accepts an empty override list', () => {
    expect(expectValue(createScoringInput(input())).overrides).toEqual([]);
  });
});

describe('immutability', () => {
  it('freezes the input, its pin, its sections and its slots', () => {
    const built = expectValue(createScoringInput(input()));
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.pin)).toBe(true);
    expect(Object.isFrozen(built.pin.itemVersionIds)).toBe(true);
    expect(Object.isFrozen(built.sections)).toBe(true);
    expect(Object.isFrozen(built.sections[0])).toBe(true);
    expect(Object.isFrozen(built.sections[0]?.slots)).toBe(true);
    expect(Object.isFrozen(built.sections[0]?.slots[0])).toBe(true);
  });

  it('freezes the response and the override list', () => {
    const sections = [{ ordinal: 1, slots: [slot({ response: { kind: 'OPTION_SELECTION', optionIds: ['A'] } })] }];
    const built = expectValue(
      createScoringInput(
        input({ sections, overrides: [{ kind: 'DROPPED', slotId: 'slot-1', reason: 'r' }] }),
      ),
    );
    expect(Object.isFrozen(built.sections[0]?.slots[0]?.response)).toBe(true);
    expect(Object.isFrozen(built.overrides)).toBe(true);
    expect(Object.isFrozen(built.overrides[0])).toBe(true);
  });

  it('does not alias the caller’s arrays', () => {
    const mutablePin = { ...PIN, itemVersionIds: ['iv-1'] };
    const built = expectValue(createScoringInput(input({ pin: mutablePin })));
    mutablePin.itemVersionIds.push('iv-smuggled');
    expect(built.pin.itemVersionIds).toEqual(['iv-1']);
  });
});

describe('allSlots', () => {
  it('returns every slot in section then slot order', () => {
    const sections = [
      { ordinal: 1, slots: [slot(), slot({ slotId: 'slot-2', ordinal: 2 })] },
      { ordinal: 2, slots: [slot({ slotId: 'slot-3', ordinal: 1 })] },
    ];
    const built = expectValue(createScoringInput(input({ sections })));
    expect(allSlots(built).map((s) => s.slotId)).toEqual(['slot-1', 'slot-2', 'slot-3']);
  });
});

describe('the answer key on a slot', () => {
  it('carries the key through to the constructed slot', () => {
    const built = expectValue(createScoringInput(input()));
    expect(built.sections[0]?.slots[0]?.answerKey).toBe(SINGLE_KEY);
  });

  it('rejects a key whose variant does not match the item type', () => {
    const sections = [{ ordinal: 1, slots: [slot({ answerKey: NUMERIC_KEY })] }];
    const error = expectError(createScoringInput(input({ sections })));
    expect(error.code).toBe('ANSWER_KEY_MISMATCH');
    expect(error.message).toContain('slot-1');
  });

  it('accepts a numeric key on a numeric slot', () => {
    const sections = [
      { ordinal: 1, slots: [slot({ itemType: 'NUMERIC', answerKey: NUMERIC_KEY })] },
    ];
    expect(expectValue(createScoringInput(input({ sections }))).sections).toHaveLength(1);
  });

  it('rejects a key on an item type it does not know', () => {
    const sections = [{ ordinal: 1, slots: [slot({ itemType: 'ASSERTION_REASON' })] }];
    expect(expectError(createScoringInput(input({ sections }))).code).toBe('ANSWER_KEY_MISMATCH');
  });
});

describe('the KEY_CORRECTED override', () => {
  const corrected = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'C' }));

  it('accepts a replacement key of the right variant', () => {
    const built = expectValue(
      createScoringInput(
        input({
          overrides: [
            { kind: 'KEY_CORRECTED', slotId: 'slot-1', reason: 'challenge upheld', replacementKey: corrected },
          ],
        }),
      ),
    );
    expect(built.overrides[0]?.kind).toBe('KEY_CORRECTED');
  });

  it('rejects a replacement key whose variant does not match the slot', () => {
    const error = expectError(
      createScoringInput(
        input({
          overrides: [
            { kind: 'KEY_CORRECTED', slotId: 'slot-1', reason: 'wrong shape', replacementKey: NUMERIC_KEY },
          ],
        }),
      ),
    );
    expect(error.code).toBe('OVERRIDE_KEY_MISMATCH');
    expect(error.message).toContain('slot-1');
  });
});
