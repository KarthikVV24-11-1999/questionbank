import { describe, expect, it } from 'vitest';
import { Exam, type CreateExamProps } from './exam.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const jeeMain: CreateExamProps = {
  examId: 'ex_jee_main',
  code: 'JEE_MAIN',
  displayName: 'JEE Main',
  jurisdiction: 'IN',
  conductingBody: 'National Testing Agency',
};

function exam(overrides: Partial<CreateExamProps> = {}): Exam {
  return expectValue(Exam.create({ ...jeeMain, ...overrides }));
}

describe('Exam construction', () => {
  it('carries id, code, display name, jurisdiction and conducting body', () => {
    const created = exam();

    expect(created.examId).toBe('ex_jee_main');
    expect(created.code).toBe('JEE_MAIN');
    expect(created.displayName).toBe('JEE Main');
    expect(created.jurisdiction).toBe('IN');
    expect(created.conductingBody).toBe('National Testing Agency');
    expect(created.activeProfileVersions.size).toBe(0);
  });

  it.each([
    ['examId', { examId: ' ' }, 'EXAM_ID_REQUIRED'],
    ['code', { code: '' }, 'CODE_REQUIRED'],
    ['displayName', { displayName: '  ' }, 'DISPLAY_NAME_REQUIRED'],
    ['jurisdiction', { jurisdiction: '' }, 'JURISDICTION_REQUIRED'],
    ['conductingBody', { conductingBody: ' ' }, 'CONDUCTING_BODY_REQUIRED'],
  ])('rejects a blank %s', (_field, overrides, code) => {
    expect(expectError(Exam.create({ ...jeeMain, ...overrides })).code).toBe(code);
  });

  it.each(['jee_main', 'JE', 'JEE MAIN', '1JEE', 'JEE-MAIN'])('rejects code %j', (code) => {
    expect(expectError(Exam.create({ ...jeeMain, code })).code).toBe('CODE_FORMAT_INVALID');
  });

  it.each(['JEE_MAIN', 'NEET_UG', 'JEE_ADVANCED_2026'])('accepts code %j', (code) => {
    expect(exam({ code }).code).toBe(code);
  });
});

describe('Exam code immutability', () => {
  it('rejects reassignment of the code', () => {
    const created = exam();

    expect(() => {
      (created as unknown as Record<string, unknown>)['code'] = 'NEET_UG';
    }).toThrow(TypeError);
    expect(created.code).toBe('JEE_MAIN');
  });

  it('keeps the code across activations', () => {
    const activated = expectValue(exam().activateProfileVersion('2026', 'epv_1'));

    expect(activated.code).toBe('JEE_MAIN');
    expect(Object.isFrozen(activated)).toBe(true);
  });
});

describe('Exam active profile versions', () => {
  it('tracks one active version per academic year', () => {
    const withOne = expectValue(exam().activateProfileVersion('2026', 'epv_2026'));
    const withTwo = expectValue(withOne.activateProfileVersion('2027', 'epv_2027'));

    expect(withTwo.activeProfileVersionFor('2026')).toBe('epv_2026');
    expect(withTwo.activeProfileVersionFor('2027')).toBe('epv_2027');
    expect(withTwo.activeProfileVersions.size).toBe(2);
  });

  it('rejects a second activation for the same year', () => {
    const activated = expectValue(exam().activateProfileVersion('2026', 'epv_2026'));

    const error = expectError(activated.activateProfileVersion('2026', 'epv_2026_revised'));

    expect(error.code).toBe('ACADEMIC_YEAR_ALREADY_ACTIVE');
    expect(error.kind).toBe('RuleViolation');
    expect(activated.activeProfileVersionFor('2026')).toBe('epv_2026');
  });

  it('allows a successor after the year is deactivated', () => {
    const activated = expectValue(exam().activateProfileVersion('2026', 'epv_2026'));
    const cleared = expectValue(activated.deactivateProfileVersion('2026'));
    const reactivated = expectValue(cleared.activateProfileVersion('2026', 'epv_2026_revised'));

    expect(reactivated.activeProfileVersionFor('2026')).toBe('epv_2026_revised');
  });

  it('rejects deactivating a year with no active version', () => {
    expect(expectError(exam().deactivateProfileVersion('2026')).code).toBe('ACADEMIC_YEAR_NOT_ACTIVE');
  });

  it.each(['', '26', '2026/27'])('rejects academic year %j', (academicYear) => {
    expect(expectError(exam().activateProfileVersion(academicYear, 'epv_1')).code).toBe(
      'ACADEMIC_YEAR_INVALID',
    );
  });

  it('rejects a blank profile version id', () => {
    expect(expectError(exam().activateProfileVersion('2026', '  ')).code).toBe(
      'PROFILE_VERSION_ID_REQUIRED',
    );
  });

  it('leaves the original exam untouched when a version is activated', () => {
    const original = exam();

    expectValue(original.activateProfileVersion('2026', 'epv_2026'));

    expect(original.activeProfileVersions.size).toBe(0);
  });
});
