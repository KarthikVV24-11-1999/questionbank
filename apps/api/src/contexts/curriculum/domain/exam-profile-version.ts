import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import type { ExamId, ExamProfileVersionId } from './exam.js';
import type { TaxonomyVersionId } from './taxonomy-version.js';
import { checkBlueprintConsistency, type SectionSpec } from './section-spec.js';
import { isLegalTransition, isMutable, type TaxonomyState } from './taxonomy-lifecycle.js';
import type { MarkingRuleSet } from './value-objects/marking-rule-set.js';
import { DEFAULT_AGGREGATION, type AggregationSpecData } from './value-objects/aggregation-spec.js';
import { hashMarkingRuleSet } from './value-objects/marking-rule-set-hash.js';
import type { NumericAnswerSpec } from './value-objects/numeric-answer-spec.js';
import type { TimingPolicy } from './value-objects/timing-policy.js';
import { checkDeliveryPoliciesCompatible, type NavigationPolicy } from './value-objects/navigation-policy.js';

/** Which item types a profile permits, and in which sections. */
export interface ItemTypeAllowance {
  readonly itemType: string;
  readonly sectionOrdinals: readonly number[];
}

/**
 * Populated by the M2 golden-set runner. M1 only requires the field to exist,
 * so that a profile can never be published without somewhere to record it.
 */
export interface GoldenSetValidation {
  readonly status: 'not_run' | 'passed' | 'failed';
  readonly runAt?: Date;
  readonly caseCount?: number;
}

export interface CreateExamProfileVersionProps {
  readonly profileVersionId: ExamProfileVersionId;
  readonly examId: ExamId;
  readonly academicYear: string;
  readonly taxonomyVersionId: TaxonomyVersionId;
  readonly sections: readonly SectionSpec[];
  readonly totalMarks: number;
  readonly timingPolicy: TimingPolicy;
  readonly navigationPolicy: NavigationPolicy;
  readonly markingRuleSet: MarkingRuleSet;
  readonly aggregation?: AggregationSpecData;
  readonly toleranceDefault?: NumericAnswerSpec;
  readonly itemTypeAllowances: readonly ItemTypeAllowance[];
  readonly goldenSetValidation?: GoldenSetValidation;
}

export type ExamProfileVersionErrorCode =
  | 'PROFILE_VERSION_ID_REQUIRED'
  | 'EXAM_ID_REQUIRED'
  | 'ACADEMIC_YEAR_INVALID'
  | 'TAXONOMY_VERSION_ID_REQUIRED'
  | 'TOTAL_MARKS_INVALID'
  | 'ITEM_TYPE_ALLOWANCES_REQUIRED'
  | 'DUPLICATE_ITEM_TYPE_ALLOWANCE'
  | 'ALLOWANCE_SECTION_UNKNOWN'
  | 'PROFILE_NOT_MUTABLE'
  | 'ILLEGAL_STATE_TRANSITION'
  | 'BLUEPRINT_INCONSISTENT'
  | 'CONTRADICTORY_DELIVERY_POLICIES'
  | 'ITEM_TYPE_WITHOUT_MARKING_RULE'
  | 'TAXONOMY_VERSION_NOT_PUBLISHED';

export interface ExamProfileVersionError {
  readonly kind: 'Validation' | 'RuleViolation';
  readonly code: ExamProfileVersionErrorCode;
  readonly message: string;
}

/** What publication needs to know about the world outside this aggregate. */
export interface PublicationContext {
  readonly taxonomyVersionIsPublished: boolean;
  readonly publishedBy: PrincipalRef;
  readonly publishedAt: Date;
}

interface ProfileSnapshot extends CreateExamProfileVersionProps {
  readonly state: TaxonomyState;
  readonly goldenSetValidation: GoldenSetValidation;
  readonly publishedAt?: Date;
  readonly publishedBy?: PrincipalRef;
  readonly markingRuleSetHash?: string;
}

const ACADEMIC_YEAR = /^\d{4}(-\d{2})?$/u;

function validationError(
  code: ExamProfileVersionErrorCode,
  message: string,
): ExamProfileVersionError {
  return { kind: 'Validation', code, message };
}

function ruleViolation(code: ExamProfileVersionErrorCode, message: string): ExamProfileVersionError {
  return { kind: 'RuleViolation', code, message };
}

function validateAllowances(
  allowances: readonly ItemTypeAllowance[],
  sections: readonly SectionSpec[],
): Result<readonly ItemTypeAllowance[], ExamProfileVersionError> {
  if (allowances.length === 0) {
    return err(
      validationError('ITEM_TYPE_ALLOWANCES_REQUIRED', 'a profile must allow at least one item type'),
    );
  }

  const itemTypes = allowances.map((allowance) => allowance.itemType);
  const duplicate = itemTypes.find((itemType, index) => itemTypes.indexOf(itemType) !== index);
  if (duplicate !== undefined) {
    return err(
      validationError('DUPLICATE_ITEM_TYPE_ALLOWANCE', `item type ${duplicate} is allowed more than once`),
    );
  }

  const ordinals = new Set(sections.map((section) => section.ordinal));
  const unknown = allowances.flatMap((allowance) =>
    allowance.sectionOrdinals.filter((ordinal) => !ordinals.has(ordinal)),
  );
  if (unknown.length > 0) {
    return err(
      validationError(
        'ALLOWANCE_SECTION_UNKNOWN',
        `item type allowance references unknown section ordinal(s): ${unknown.join(', ')}`,
      ),
    );
  }

  return ok(allowances.map((allowance) => Object.freeze({ ...allowance, sectionOrdinals: Object.freeze([...allowance.sectionOrdinals]) })));
}

/**
 * The multi-exam plugin contract (DOMAIN-MODEL §4): structure, timing,
 * navigation, permitted item types and marking, entirely as data. A new exam is
 * a new instance of this aggregate, never new code (EXT-01).
 */
export class ExamProfileVersion {
  readonly profileVersionId: ExamProfileVersionId;
  readonly examId: ExamId;
  readonly academicYear: string;
  readonly taxonomyVersionId: TaxonomyVersionId;
  readonly state: TaxonomyState;
  readonly sections: readonly SectionSpec[];
  readonly totalMarks: number;
  readonly timingPolicy: TimingPolicy;
  readonly navigationPolicy: NavigationPolicy;
  readonly markingRuleSet: MarkingRuleSet;
  /** How outcomes become totals (ADR-0006). Defaulted, never absent. */
  readonly aggregation: AggregationSpecData;
  readonly toleranceDefault?: NumericAnswerSpec;
  readonly itemTypeAllowances: readonly ItemTypeAllowance[];
  readonly goldenSetValidation: GoldenSetValidation;
  readonly publishedBy?: PrincipalRef;
  readonly markingRuleSetHash?: string;
  readonly #publishedAtMs: number | undefined;

  private constructor(snapshot: ProfileSnapshot) {
    this.profileVersionId = snapshot.profileVersionId;
    this.examId = snapshot.examId;
    this.academicYear = snapshot.academicYear;
    this.taxonomyVersionId = snapshot.taxonomyVersionId;
    this.state = snapshot.state;
    this.sections = Object.freeze(
      [...snapshot.sections].sort((left, right) => left.ordinal - right.ordinal),
    );
    this.totalMarks = snapshot.totalMarks;
    this.timingPolicy = snapshot.timingPolicy;
    this.navigationPolicy = snapshot.navigationPolicy;
    this.markingRuleSet = snapshot.markingRuleSet;
    this.aggregation = snapshot.aggregation ?? DEFAULT_AGGREGATION;
    if (snapshot.toleranceDefault !== undefined) this.toleranceDefault = snapshot.toleranceDefault;
    this.itemTypeAllowances = Object.freeze([...snapshot.itemTypeAllowances]);
    this.goldenSetValidation = Object.freeze({ ...snapshot.goldenSetValidation });
    if (snapshot.publishedBy !== undefined) this.publishedBy = snapshot.publishedBy;
    if (snapshot.markingRuleSetHash !== undefined) this.markingRuleSetHash = snapshot.markingRuleSetHash;
    this.#publishedAtMs = snapshot.publishedAt?.getTime();
    Object.freeze(this);
  }

  static createDraft(
    props: CreateExamProfileVersionProps,
  ): Result<ExamProfileVersion, ExamProfileVersionError> {
    if (props.profileVersionId.trim().length === 0) {
      return err(validationError('PROFILE_VERSION_ID_REQUIRED', 'profileVersionId must be non-empty'));
    }
    if (props.examId.trim().length === 0) {
      return err(validationError('EXAM_ID_REQUIRED', 'examId must be non-empty'));
    }
    if (!ACADEMIC_YEAR.test(props.academicYear.trim())) {
      return err(
        validationError('ACADEMIC_YEAR_INVALID', `academicYear must look like 2026 or 2026-27, got "${props.academicYear}"`),
      );
    }
    if (props.taxonomyVersionId.trim().length === 0) {
      return err(validationError('TAXONOMY_VERSION_ID_REQUIRED', 'taxonomyVersionId must be non-empty'));
    }
    if (!Number.isFinite(props.totalMarks) || props.totalMarks <= 0) {
      return err(
        validationError('TOTAL_MARKS_INVALID', `totalMarks must be greater than 0, got ${props.totalMarks}`),
      );
    }

    const allowances = validateAllowances(props.itemTypeAllowances, props.sections);
    if (!allowances.ok) return allowances;

    return ok(
      new ExamProfileVersion({
        ...props,
        profileVersionId: props.profileVersionId.trim(),
        examId: props.examId.trim(),
        academicYear: props.academicYear.trim(),
        taxonomyVersionId: props.taxonomyVersionId.trim(),
        itemTypeAllowances: allowances.value,
        state: 'draft',
        goldenSetValidation: props.goldenSetValidation ?? { status: 'not_run' },
      }),
    );
  }

  /** Rebuilds a stored profile, including its publication stamp and hash. */
  static reconstitute(
    props: CreateExamProfileVersionProps & {
      readonly state: TaxonomyState;
      readonly goldenSetValidation: GoldenSetValidation;
      readonly publishedAt?: Date;
      readonly publishedBy?: PrincipalRef;
      readonly markingRuleSetHash?: string;
    },
  ): Result<ExamProfileVersion, ExamProfileVersionError> {
    const draft = ExamProfileVersion.createDraft(props);
    if (!draft.ok) return draft;

    return ok(
      draft.value.with({
        state: props.state,
        goldenSetValidation: props.goldenSetValidation,
        ...(props.publishedAt !== undefined ? { publishedAt: props.publishedAt } : {}),
        ...(props.publishedBy !== undefined ? { publishedBy: props.publishedBy } : {}),
        ...(props.markingRuleSetHash !== undefined ? { markingRuleSetHash: props.markingRuleSetHash } : {}),
      }),
    );
  }

  get publishedAt(): Date | undefined {
    return this.#publishedAtMs === undefined ? undefined : new Date(this.#publishedAtMs);
  }

  get isMutable(): boolean {
    return isMutable(this.state);
  }

  sectionByOrdinal(ordinal: number): SectionSpec | undefined {
    return this.sections.find((section) => section.ordinal === ordinal);
  }

  /** Every reason this profile cannot be published right now. */
  publicationPreconditions(
    taxonomyVersionIsPublished: boolean,
  ): readonly ExamProfileVersionError[] {
    const failures: ExamProfileVersionError[] = [];

    const blueprint = checkBlueprintConsistency(this.sections, this.totalMarks, this.timingPolicy);
    if (!blueprint.ok) {
      failures.push(ruleViolation('BLUEPRINT_INCONSISTENT', blueprint.error.message));
    }

    const policies = checkDeliveryPoliciesCompatible(this.timingPolicy, this.navigationPolicy);
    if (!policies.ok) {
      failures.push(ruleViolation('CONTRADICTORY_DELIVERY_POLICIES', policies.error.message));
    }

    const unmatched = this.itemTypeAllowances.filter(
      (allowance) => this.markingRuleSet.rulesForItemType(allowance.itemType).length === 0,
    );
    if (unmatched.length > 0) {
      failures.push(
        ruleViolation(
          'ITEM_TYPE_WITHOUT_MARKING_RULE',
          `no marking rule matches allowed item type(s): ${unmatched.map((allowance) => allowance.itemType).join(', ')}`,
        ),
      );
    }

    if (!taxonomyVersionIsPublished) {
      failures.push(
        ruleViolation(
          'TAXONOMY_VERSION_NOT_PUBLISHED',
          `taxonomy version ${this.taxonomyVersionId} must be published before a profile referencing it`,
        ),
      );
    }

    return failures;
  }

  /** draft → published. All preconditions are evaluated before anything changes. */
  publish(context: PublicationContext): Result<ExamProfileVersion, ExamProfileVersionError> {
    if (!isLegalTransition(this.state, 'published')) {
      return err(
        ruleViolation(
          'ILLEGAL_STATE_TRANSITION',
          `profile version ${this.profileVersionId} cannot move from ${this.state} to published`,
        ),
      );
    }

    const failure = this.publicationPreconditions(context.taxonomyVersionIsPublished)[0];
    if (failure !== undefined) return err(failure);

    return ok(
      this.with({
        state: 'published',
        publishedAt: new Date(context.publishedAt.getTime()),
        publishedBy: context.publishedBy,
        markingRuleSetHash: hashMarkingRuleSet(this.markingRuleSet),
      }),
    );
  }

  supersede(): Result<ExamProfileVersion, ExamProfileVersionError> {
    if (!isLegalTransition(this.state, 'superseded')) {
      return err(
        ruleViolation(
          'ILLEGAL_STATE_TRANSITION',
          `profile version ${this.profileVersionId} cannot move from ${this.state} to superseded`,
        ),
      );
    }

    return ok(this.with({ state: 'superseded' }));
  }

  replaceSections(sections: readonly SectionSpec[]): Result<ExamProfileVersion, ExamProfileVersionError> {
    const mutable = this.requireMutable('replaceSections');
    if (!mutable.ok) return mutable;

    // Allowances name section ordinals, so they must still resolve afterwards.
    const allowances = validateAllowances(this.itemTypeAllowances, sections);
    if (!allowances.ok) return allowances;

    return ok(this.with({ sections }));
  }

  replaceMarkingRuleSet(markingRuleSet: MarkingRuleSet): Result<ExamProfileVersion, ExamProfileVersionError> {
    const mutable = this.requireMutable('replaceMarkingRuleSet');
    if (!mutable.ok) return mutable;

    return ok(this.with({ markingRuleSet }));
  }

  replaceItemTypeAllowances(
    itemTypeAllowances: readonly ItemTypeAllowance[],
  ): Result<ExamProfileVersion, ExamProfileVersionError> {
    const mutable = this.requireMutable('replaceItemTypeAllowances');
    if (!mutable.ok) return mutable;

    const allowances = validateAllowances(itemTypeAllowances, this.sections);
    if (!allowances.ok) return allowances;

    return ok(this.with({ itemTypeAllowances: allowances.value }));
  }

  recordGoldenSetValidation(
    goldenSetValidation: GoldenSetValidation,
  ): Result<ExamProfileVersion, ExamProfileVersionError> {
    const mutable = this.requireMutable('recordGoldenSetValidation');
    if (!mutable.ok) return mutable;

    return ok(this.with({ goldenSetValidation }));
  }

  private requireMutable(operation: string): Result<ExamProfileVersion, ExamProfileVersionError> {
    return this.isMutable
      ? ok(this)
      : err(
          ruleViolation(
            'PROFILE_NOT_MUTABLE',
            `${operation} rejected: profile version ${this.profileVersionId} is ${this.state}`,
          ),
        );
  }

  private snapshot(): ProfileSnapshot {
    return {
      profileVersionId: this.profileVersionId,
      examId: this.examId,
      academicYear: this.academicYear,
      taxonomyVersionId: this.taxonomyVersionId,
      state: this.state,
      sections: this.sections,
      totalMarks: this.totalMarks,
      timingPolicy: this.timingPolicy,
      navigationPolicy: this.navigationPolicy,
      markingRuleSet: this.markingRuleSet,
      aggregation: this.aggregation,
      ...(this.toleranceDefault !== undefined ? { toleranceDefault: this.toleranceDefault } : {}),
      itemTypeAllowances: this.itemTypeAllowances,
      goldenSetValidation: this.goldenSetValidation,
      ...(this.publishedAt !== undefined ? { publishedAt: this.publishedAt } : {}),
      ...(this.publishedBy !== undefined ? { publishedBy: this.publishedBy } : {}),
      ...(this.markingRuleSetHash !== undefined ? { markingRuleSetHash: this.markingRuleSetHash } : {}),
    };
  }

  private with(changes: Partial<ProfileSnapshot>): ExamProfileVersion {
    return new ExamProfileVersion({ ...this.snapshot(), ...changes });
  }
}
