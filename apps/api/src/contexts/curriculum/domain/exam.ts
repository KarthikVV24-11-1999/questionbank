import { err, ok, type Result } from './result.js';

export type ExamId = string;
export type ExamProfileVersionId = string;

export interface CreateExamProps {
  readonly examId: ExamId;
  readonly code: string;
  readonly displayName: string;
  readonly jurisdiction: string;
  readonly conductingBody: string;
}

export type ExamErrorCode =
  | 'EXAM_ID_REQUIRED'
  | 'CODE_REQUIRED'
  | 'CODE_FORMAT_INVALID'
  | 'DISPLAY_NAME_REQUIRED'
  | 'JURISDICTION_REQUIRED'
  | 'CONDUCTING_BODY_REQUIRED'
  | 'ACADEMIC_YEAR_INVALID'
  | 'PROFILE_VERSION_ID_REQUIRED'
  | 'ACADEMIC_YEAR_ALREADY_ACTIVE'
  | 'ACADEMIC_YEAR_NOT_ACTIVE';

export interface ExamError {
  readonly kind: 'Validation' | 'RuleViolation';
  readonly code: ExamErrorCode;
  readonly message: string;
}

/** `JEE_MAIN`, `NEET_UG` — upper snake case, stable, never re-used. */
const CODE = /^[A-Z][A-Z0-9_]{2,31}$/u;
const ACADEMIC_YEAR = /^\d{4}(-\d{2})?$/u;

function validationError(code: ExamErrorCode, message: string): ExamError {
  return { kind: 'Validation', code, message };
}

function ruleViolation(code: ExamErrorCode, message: string): ExamError {
  return { kind: 'RuleViolation', code, message };
}

function requireText(value: string, field: string, code: ExamErrorCode): Result<string, ExamError> {
  const trimmed = value.trim();
  return trimmed.length === 0 ? err(validationError(code, `${field} must be non-empty`)) : ok(trimmed);
}

/**
 * The stable identity of an examination (D1). Profile versions hang off it;
 * exactly one may be active per academic year.
 */
export class Exam {
  readonly examId: ExamId;
  readonly code: string;
  readonly displayName: string;
  readonly jurisdiction: string;
  readonly conductingBody: string;
  /** academicYear → the profile version active for it. */
  readonly activeProfileVersions: ReadonlyMap<string, ExamProfileVersionId>;

  private constructor(
    props: Omit<CreateExamProps, 'code'> & {
      code: string;
      activeProfileVersions: ReadonlyMap<string, ExamProfileVersionId>;
    },
  ) {
    this.examId = props.examId;
    this.code = props.code;
    this.displayName = props.displayName;
    this.jurisdiction = props.jurisdiction;
    this.conductingBody = props.conductingBody;
    this.activeProfileVersions = new Map(props.activeProfileVersions);
    Object.freeze(this);
  }

  static create(props: CreateExamProps): Result<Exam, ExamError> {
    const examId = requireText(props.examId, 'examId', 'EXAM_ID_REQUIRED');
    if (!examId.ok) return examId;

    const code = requireText(props.code, 'code', 'CODE_REQUIRED');
    if (!code.ok) return code;
    if (!CODE.test(code.value)) {
      return err(
        validationError(
          'CODE_FORMAT_INVALID',
          `code must be 3-32 upper snake case characters, got "${props.code}"`,
        ),
      );
    }

    const displayName = requireText(props.displayName, 'displayName', 'DISPLAY_NAME_REQUIRED');
    if (!displayName.ok) return displayName;

    const jurisdiction = requireText(props.jurisdiction, 'jurisdiction', 'JURISDICTION_REQUIRED');
    if (!jurisdiction.ok) return jurisdiction;

    const conductingBody = requireText(props.conductingBody, 'conductingBody', 'CONDUCTING_BODY_REQUIRED');
    if (!conductingBody.ok) return conductingBody;

    return ok(
      new Exam({
        examId: examId.value,
        code: code.value,
        displayName: displayName.value,
        jurisdiction: jurisdiction.value,
        conductingBody: conductingBody.value,
        activeProfileVersions: new Map(),
      }),
    );
  }

  activeProfileVersionFor(academicYear: string): ExamProfileVersionId | undefined {
    return this.activeProfileVersions.get(academicYear);
  }

  /** Activates a profile version for a year. A second activation is rejected. */
  activateProfileVersion(
    academicYear: string,
    profileVersionId: ExamProfileVersionId,
  ): Result<Exam, ExamError> {
    if (!ACADEMIC_YEAR.test(academicYear.trim())) {
      return err(
        validationError('ACADEMIC_YEAR_INVALID', `academicYear must look like 2026 or 2026-27, got "${academicYear}"`),
      );
    }

    const versionId = requireText(profileVersionId, 'profileVersionId', 'PROFILE_VERSION_ID_REQUIRED');
    if (!versionId.ok) return versionId;

    const year = academicYear.trim();
    const active = this.activeProfileVersions.get(year);
    if (active !== undefined) {
      return err(
        ruleViolation(
          'ACADEMIC_YEAR_ALREADY_ACTIVE',
          `exam ${this.code} already has profile version ${active} active for ${year}`,
        ),
      );
    }

    return ok(this.with(new Map(this.activeProfileVersions).set(year, versionId.value)));
  }

  /** Deactivates the year's active version, so a successor may be activated. */
  deactivateProfileVersion(academicYear: string): Result<Exam, ExamError> {
    const year = academicYear.trim();
    if (!this.activeProfileVersions.has(year)) {
      return err(
        ruleViolation('ACADEMIC_YEAR_NOT_ACTIVE', `exam ${this.code} has no active profile version for ${year}`),
      );
    }

    const remaining = new Map(this.activeProfileVersions);
    remaining.delete(year);
    return ok(this.with(remaining));
  }

  private with(activeProfileVersions: ReadonlyMap<string, ExamProfileVersionId>): Exam {
    return new Exam({
      examId: this.examId,
      code: this.code,
      displayName: this.displayName,
      jurisdiction: this.jurisdiction,
      conductingBody: this.conductingBody,
      activeProfileVersions,
    });
  }
}
