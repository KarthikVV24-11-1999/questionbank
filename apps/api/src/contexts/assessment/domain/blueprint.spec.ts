import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import { BLUEPRINT_DIFFICULTY_BANDS, BLUEPRINT_ITEM_TYPES, createBlueprint, type Blueprint, type SectionBlueprint } from './blueprint.js';

const section = (overrides: Partial<SectionBlueprint> = {}): SectionBlueprint => ({
  ordinal: 1,
  sectionSpecRef: 'physics-a',
  itemCount: 4,
  typeMix: { SINGLE_CORRECT_MCQ: 3, NUMERIC: 1 },
  marksPerItem: 4,
  difficultyTarget: { moderate: 3, advanced: 1 },
  ...overrides,
});

const props = (overrides: Partial<Blueprint> = {}): Blueprint => ({
  examProfileVersionId: id(TAG.profile),
  formType: 'mock',
  totalMarks: 16,
  difficultyTolerance: 1,
  sections: [section()],
  ...overrides,
});

describe('a blueprint', () => {
  it('is validated, frozen and ordered by section', () => {
    const blueprint = expectValue(createBlueprint(props({ sections: [section({ ordinal: 2 }), section({ ordinal: 1 })] })));
    expect(blueprint.sections.map((s) => s.ordinal)).toEqual([1, 2]);
    expect(Object.isFrozen(blueprint)).toBe(true);
    expect(Object.isFrozen(blueprint.sections[0])).toBe(true);
    expect(Object.isFrozen(blueprint.sections[0]!.typeMix)).toBe(true);
    expect(Object.isFrozen(blueprint.sections[0]!.difficultyTarget)).toBe(true);
  });

  it('does not check that its total marks agree with its sections: a contradiction is assembly\'s to refuse by name', () => {
    expect(createBlueprint(props({ totalMarks: 999 })).ok).toBe(true);
  });

  it('names the vocabularies it accepts', () => {
    expect([...BLUEPRINT_ITEM_TYPES]).toEqual(['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC']);
    expect([...BLUEPRINT_DIFFICULTY_BANDS]).toEqual(['foundational', 'moderate', 'challenging', 'advanced']);
  });

  const REFUSALS: readonly (readonly [string, Partial<Blueprint>, string])[] = [
    ['a bad profile version', { examProfileVersionId: 'nope' }, 'BLUEPRINT_PROFILE_INVALID'],
    ['an unknown form type', { formType: 'practice' as 'mock' }, 'BLUEPRINT_FORM_TYPE_INVALID'],
    ['zero total marks', { totalMarks: 0 }, 'BLUEPRINT_TOTAL_MARKS_INVALID'],
    ['a negative tolerance', { difficultyTolerance: -1 }, 'BLUEPRINT_TOLERANCE_INVALID'],
    ['no sections', { sections: [] }, 'BLUEPRINT_SECTIONS_INVALID'],
    ['a repeated section ordinal', { sections: [section(), section()] }, 'BLUEPRINT_SECTIONS_INVALID'],
    ['a section with no spec reference', { sections: [section({ sectionSpecRef: ' ' })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['a negative ordinal', { sections: [section({ ordinal: -1 })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['no items', { sections: [section({ itemCount: 0 })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['no marks per item', { sections: [section({ marksPerItem: 0 })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['a type mix that does not sum to the count', { sections: [section({ typeMix: { NUMERIC: 1 } })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['an unknown item type', { sections: [section({ typeMix: { ESSAY: 4 } as never })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['a fractional count in the mix', { sections: [section({ typeMix: { SINGLE_CORRECT_MCQ: 3.5, NUMERIC: 0.5 } })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['a difficulty target that does not sum to the count', { sections: [section({ difficultyTarget: { moderate: 1 } })] }, 'BLUEPRINT_SECTION_INVALID'],
    ['an unknown band', { sections: [section({ difficultyTarget: { impossible: 4 } as never })] }, 'BLUEPRINT_SECTION_INVALID'],
  ];

  it.each(REFUSALS)('refuses %s', (_name, overrides, code) => {
    const error = expectError(createBlueprint(props(overrides)));
    expect(error.code).toBe(code);
    expect(error.kind).toBe('Validation');
  });
});
