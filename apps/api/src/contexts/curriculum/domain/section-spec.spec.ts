import { describe, expect, it } from 'vitest';
import { SectionSpec, checkBlueprintConsistency, type CreateSectionSpecProps } from './section-spec.js';
import { TimingPolicy } from './value-objects/timing-policy.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const physicsSection: CreateSectionSpecProps = {
  ordinal: 1,
  name: 'Physics',
  subject: 'physics',
  itemCount: 25,
  itemTypeMix: { SINGLE_CORRECT_MCQ: 20, NUMERIC: 5 },
  maxMarks: 100,
};

function section(overrides: Partial<CreateSectionSpecProps> = {}): SectionSpec {
  return expectValue(SectionSpec.create({ ...physicsSection, ...overrides }));
}

function timing(sectionLocking: boolean): TimingPolicy {
  return expectValue(
    TimingPolicy.create({
      totalDurationMinutes: 180,
      sectionLocking,
      warningThresholdsMinutes: [30, 5],
      autoSubmitOnExpiry: true,
    }),
  );
}

function threeSections(): SectionSpec[] {
  return [
    section(),
    section({ ordinal: 2, name: 'Chemistry', subject: 'chemistry' }),
    section({ ordinal: 3, name: 'Mathematics', subject: 'mathematics' }),
  ];
}

describe('SectionSpec', () => {
  it('carries ordinal, name, subject, counts, mix, marks and optional timing', () => {
    const spec = section({ sectionTiming: { durationMinutes: 60 } });

    expect(spec.ordinal).toBe(1);
    expect(spec.name).toBe('Physics');
    expect(spec.subject).toBe('physics');
    expect(spec.itemCount).toBe(25);
    expect(spec.itemTypeMix).toEqual({ SINGLE_CORRECT_MCQ: 20, NUMERIC: 5 });
    expect(spec.maxMarks).toBe(100);
    expect(spec.sectionTiming).toEqual({ durationMinutes: 60 });
  });

  it('reports the item count of a type, including absent types', () => {
    expect(section().itemCountOfType('NUMERIC')).toBe(5);
    expect(section().itemCountOfType('MATCHING')).toBe(0);
  });

  it('is immutable', () => {
    const spec = section({ sectionTiming: { durationMinutes: 60 } });

    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.itemTypeMix)).toBe(true);
    expect(Object.isFrozen(spec.sectionTiming)).toBe(true);
  });

  it.each([
    ['ordinal 0', { ordinal: 0 }, 'ORDINAL_INVALID'],
    ['a fractional ordinal', { ordinal: 1.5 }, 'ORDINAL_INVALID'],
    ['a blank name', { name: '  ' }, 'NAME_REQUIRED'],
    ['a blank subject', { subject: '' }, 'SUBJECT_REQUIRED'],
    ['item count 0', { itemCount: 0 }, 'ITEM_COUNT_INVALID'],
    ['an empty item type mix', { itemTypeMix: {} }, 'ITEM_TYPE_MIX_EMPTY'],
    ['a negative type count', { itemCount: 20, itemTypeMix: { A: 25, B: -5 } }, 'ITEM_TYPE_COUNT_INVALID'],
    ['max marks 0', { maxMarks: 0 }, 'MAX_MARKS_INVALID'],
    ['section timing of 0 minutes', { sectionTiming: { durationMinutes: 0 } }, 'SECTION_TIMING_INVALID'],
  ])('rejects %s', (_case, overrides, code) => {
    expect(expectError(SectionSpec.create({ ...physicsSection, ...overrides })).code).toBe(code);
  });

  it('rejects an item type mix that does not sum to the item count', () => {
    const error = expectError(
      SectionSpec.create({ ...physicsSection, itemTypeMix: { SINGLE_CORRECT_MCQ: 20, NUMERIC: 4 } }),
    );

    expect(error.code).toBe('ITEM_TYPE_MIX_MISMATCH');
    expect(error.message).toContain('24');
    expect(error.ordinal).toBe(1);
  });

  it('accepts a mix that sums exactly, including a zero-count type', () => {
    const spec = section({ itemTypeMix: { SINGLE_CORRECT_MCQ: 25, NUMERIC: 0 } });

    expect(spec.itemCount).toBe(25);
  });
});

describe('blueprint consistency', () => {
  it('accepts three contiguous sections summing to the profile total', () => {
    expect(expectValue(checkBlueprintConsistency(threeSections(), 300, timing(false)))).toBe(true);
  });

  it('accepts sections supplied out of order as long as the ordinals are contiguous', () => {
    const [first, second, third] = threeSections();

    expect(
      expectValue(checkBlueprintConsistency([third, first, second] as SectionSpec[], 300, timing(false))),
    ).toBe(true);
  });

  it('rejects an empty section list', () => {
    expect(expectError(checkBlueprintConsistency([], 0, timing(false))).code).toBe('SECTIONS_REQUIRED');
  });

  it('rejects a gap in the ordinals', () => {
    const sections = [section(), section({ ordinal: 3, name: 'Maths', subject: 'mathematics' })];

    expect(expectError(checkBlueprintConsistency(sections, 200, timing(false))).code).toBe(
      'ORDINALS_NOT_CONTIGUOUS',
    );
  });

  it('rejects duplicate ordinals', () => {
    const sections = [section(), section({ name: 'Chemistry', subject: 'chemistry' })];

    expect(expectError(checkBlueprintConsistency(sections, 200, timing(false))).code).toBe(
      'DUPLICATE_ORDINAL',
    );
  });

  it('rejects section marks that do not sum to the profile total', () => {
    const error = expectError(checkBlueprintConsistency(threeSections(), 299, timing(false)));

    expect(error.code).toBe('SECTION_MARKS_MISMATCH');
    expect(error.message).toContain('300');
    expect(error.kind).toBe('RuleViolation');
  });

  it('rejects section timing when the profile does not lock sections', () => {
    const sections = [
      section({ sectionTiming: { durationMinutes: 60 } }),
      section({ ordinal: 2, name: 'Chemistry', subject: 'chemistry' }),
      section({ ordinal: 3, name: 'Maths', subject: 'mathematics' }),
    ];

    const error = expectError(checkBlueprintConsistency(sections, 300, timing(false)));

    expect(error.code).toBe('SECTION_TIMING_WITHOUT_LOCKING');
    expect(error.message).toContain('1');
  });

  it('requires section timing on every section when the profile locks sections', () => {
    expect(expectError(checkBlueprintConsistency(threeSections(), 300, timing(true))).code).toBe(
      'SECTION_TIMING_REQUIRED_WHEN_LOCKED',
    );
  });

  it('accepts locked sections when every section is timed', () => {
    const sections = threeSections().map((spec) =>
      expectValue(
        SectionSpec.create({
          ordinal: spec.ordinal,
          name: spec.name,
          subject: spec.subject,
          itemCount: spec.itemCount,
          itemTypeMix: spec.itemTypeMix,
          maxMarks: spec.maxMarks,
          sectionTiming: { durationMinutes: 60 },
        }),
      ),
    );

    expect(expectValue(checkBlueprintConsistency(sections, 300, timing(true)))).toBe(true);
  });
});
