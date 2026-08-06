import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ok, err, type Result } from '../domain/result.js';
import {
  ExamProfileVersion,
  type ExamProfileVersionError,
  type GoldenSetValidation,
  type ItemTypeAllowance,
} from '../domain/exam-profile-version.js';
import type { ExamProfileVersionId } from '../domain/exam.js';
import { SectionSpec, type ItemTypeMix } from '../domain/section-spec.js';
import type { TaxonomyState } from '../domain/taxonomy-lifecycle.js';
import { MarkingRuleSet, type MarkingRuleSetData } from '../domain/value-objects/marking-rule-set.js';
import { NumericAnswerSpec, type CreateNumericAnswerSpecProps } from '../domain/value-objects/numeric-answer-spec.js';
import { TimingPolicy, type CreateTimingPolicyProps } from '../domain/value-objects/timing-policy.js';
import { NavigationPolicy, type CreateNavigationPolicyProps } from '../domain/value-objects/navigation-policy.js';
import {
  conflict,
  corruptRow,
  notFound,
  type Persisted,
  type RepositoryError,
} from '../domain/repository-ports.js';
import { examProfileVersion, examSectionSpec } from './schema.js';

type ProfileRow = typeof examProfileVersion.$inferSelect;
type SectionRow = typeof examSectionSpec.$inferSelect;

/** The serialized form of a profile: exactly what lands in the JSONB columns. */
export interface ProfileJsonPayload {
  readonly profileVersionId: string;
  readonly examId: string;
  readonly academicYear: string;
  readonly state: TaxonomyState;
  readonly taxonomyVersionId: string;
  readonly totalMarks: number;
  readonly timingPolicy: unknown;
  readonly navigationPolicy: unknown;
  readonly markingRuleSet: unknown;
  readonly markingRuleSetHash: string | null;
  readonly toleranceDefaults: unknown | null;
  readonly itemTypeAllowances: unknown;
  readonly goldenSetValidation: unknown;
  readonly isActive: boolean;
  readonly publishedAt: Date | null;
  readonly publishedBy: PrincipalRef | null;
  readonly sections: ReadonlyArray<{
    readonly ordinal: number;
    readonly name: string;
    readonly subject: string;
    readonly itemCount: number;
    readonly itemTypeMix: ItemTypeMix;
    readonly maxMarks: number;
    readonly sectionTimingMinutes: number | null;
  }>;
}

function invalidJsonb(column: string, message: string): RepositoryError {
  return corruptRow(`${column} is not valid for its registered schema: ${message}`);
}

/**
 * Validates every JSONB payload against the type that owns it, before the write
 * reaches the database. The domain factory is the registered schema — there is
 * no second definition of these shapes to drift from.
 */
export function validateProfileJsonb(payload: ProfileJsonPayload): Result<true, RepositoryError> {
  const timing = TimingPolicy.create(payload.timingPolicy as CreateTimingPolicyProps);
  if (!timing.ok) return err(invalidJsonb('timing_policy', timing.error.message));

  const navigation = NavigationPolicy.create(payload.navigationPolicy as CreateNavigationPolicyProps);
  if (!navigation.ok) return err(invalidJsonb('navigation_policy', navigation.error.message));

  const ruleSet = MarkingRuleSet.create(payload.markingRuleSet as MarkingRuleSetData);
  if (!ruleSet.ok) return err(invalidJsonb('marking_rule_set', ruleSet.error.message));

  if (payload.toleranceDefaults !== null) {
    const tolerance = NumericAnswerSpec.create(payload.toleranceDefaults as CreateNumericAnswerSpecProps);
    if (!tolerance.ok) return err(invalidJsonb('tolerance_defaults', tolerance.error.message));
  }

  const allowances = payload.itemTypeAllowances;
  if (
    !Array.isArray(allowances) ||
    allowances.some(
      (allowance: unknown) =>
        typeof (allowance as ItemTypeAllowance)?.itemType !== 'string' ||
        !Array.isArray((allowance as ItemTypeAllowance)?.sectionOrdinals),
    )
  ) {
    return err(invalidJsonb('item_type_allowances', 'expected an array of { itemType, sectionOrdinals }'));
  }

  const status = (payload.goldenSetValidation as GoldenSetValidation | null)?.status;
  if (status !== 'not_run' && status !== 'passed' && status !== 'failed') {
    return err(invalidJsonb('golden_set_validation', `unknown status "${String(status)}"`));
  }

  return ok(true);
}

export function serializeProfile(profile: ExamProfileVersion, isActive = false): ProfileJsonPayload {
  return {
    profileVersionId: profile.profileVersionId,
    examId: profile.examId,
    academicYear: profile.academicYear,
    state: profile.state,
    taxonomyVersionId: profile.taxonomyVersionId,
    totalMarks: profile.totalMarks,
    timingPolicy: {
      totalDurationMinutes: profile.timingPolicy.totalDurationMinutes,
      sectionLocking: profile.timingPolicy.sectionLocking,
      warningThresholdsMinutes: [...profile.timingPolicy.warningThresholdsMinutes],
      autoSubmitOnExpiry: profile.timingPolicy.autoSubmitOnExpiry,
    },
    navigationPolicy: {
      crossSectionNavigation: profile.navigationPolicy.crossSectionNavigation,
      allowMarkForReview: profile.navigationPolicy.allowMarkForReview,
      allowAnswerChange: profile.navigationPolicy.allowAnswerChange,
      allowClearResponse: profile.navigationPolicy.allowClearResponse,
    },
    markingRuleSet: profile.markingRuleSet.toData(),
    markingRuleSetHash: profile.markingRuleSetHash ?? null,
    toleranceDefaults:
      profile.toleranceDefault === undefined
        ? null
        : {
            expectedValue: profile.toleranceDefault.expectedValue,
            comparisonMode: profile.toleranceDefault.comparisonMode,
            ...(profile.toleranceDefault.toleranceValue !== undefined
              ? { toleranceValue: profile.toleranceDefault.toleranceValue }
              : {}),
            ...(profile.toleranceDefault.significantFigures !== undefined
              ? { significantFigures: profile.toleranceDefault.significantFigures }
              : {}),
            ...(profile.toleranceDefault.rangeMin !== undefined
              ? { rangeMin: profile.toleranceDefault.rangeMin, rangeMax: profile.toleranceDefault.rangeMax }
              : {}),
            ...(profile.toleranceDefault.unit !== undefined ? { unit: profile.toleranceDefault.unit } : {}),
            acceptedForms: [...profile.toleranceDefault.acceptedForms],
            normalization: profile.toleranceDefault.normalization,
          },
    itemTypeAllowances: profile.itemTypeAllowances.map((allowance) => ({
      itemType: allowance.itemType,
      sectionOrdinals: [...allowance.sectionOrdinals],
    })),
    goldenSetValidation: profile.goldenSetValidation,
    isActive,
    publishedAt: profile.publishedAt ?? null,
    publishedBy: profile.publishedBy ?? null,
    sections: profile.sections.map((section) => ({
      ordinal: section.ordinal,
      name: section.name,
      subject: section.subject,
      itemCount: section.itemCount,
      itemTypeMix: section.itemTypeMix,
      maxMarks: section.maxMarks,
      sectionTimingMinutes: section.sectionTiming?.durationMinutes ?? null,
    })),
  };
}

function toProfileRow(payload: ProfileJsonPayload): typeof examProfileVersion.$inferInsert {
  return {
    profileVersionId: payload.profileVersionId,
    examId: payload.examId,
    academicYear: payload.academicYear,
    state: payload.state,
    taxonomyVersionId: payload.taxonomyVersionId,
    totalMarks: payload.totalMarks.toFixed(2),
    timingPolicy: payload.timingPolicy,
    navigationPolicy: payload.navigationPolicy,
    markingRuleSet: payload.markingRuleSet,
    markingRuleSetHash: payload.markingRuleSetHash,
    toleranceDefaults: payload.toleranceDefaults,
    itemTypeAllowances: payload.itemTypeAllowances,
    goldenSetValidation: payload.goldenSetValidation,
    isActive: payload.isActive,
    publishedAt: payload.publishedAt,
    publishedByKind: payload.publishedBy?.kind ?? null,
    publishedById: payload.publishedBy?.id ?? null,
  };
}

function toSectionSpec(row: SectionRow): Result<SectionSpec, RepositoryError> {
  const section = SectionSpec.create({
    ordinal: row.ordinal,
    name: row.name,
    subject: row.subject,
    itemCount: row.itemCount,
    itemTypeMix: row.itemTypeMix as ItemTypeMix,
    maxMarks: Number(row.maxMarks),
    ...(row.sectionTimingMinutes !== null
      ? { sectionTiming: { durationMinutes: row.sectionTimingMinutes } }
      : {}),
  });

  return section.ok
    ? ok(section.value)
    : err(corruptRow(`exam_section_spec ${row.sectionSpecId} cannot be loaded: ${section.error.message}`));
}

export class DrizzleExamProfileVersionRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(
    profile: ExamProfileVersion,
    isActive = false,
  ): Promise<Result<Persisted<ExamProfileVersion>, RepositoryError>> {
    const payload = serializeProfile(profile, isActive);
    const valid = validateProfileJsonb(payload);
    if (!valid.ok) return valid;

    await this.db.transaction(async (tx) => {
      // Section rows are frozen once the parent is published, so the parent row
      // starts as a draft and is moved to its real state after the children
      // land — the same order a real profile goes through.
      const row = toProfileRow(payload);
      await tx.insert(examProfileVersion).values({
        ...row,
        state: 'draft',
        markingRuleSetHash: null,
        isActive: false,
        publishedAt: null,
        publishedByKind: null,
        publishedById: null,
        aggregateVersion: 1,
      });
      await this.writeSections(tx, payload);

      if (payload.state !== 'draft' || payload.isActive) {
        await tx
          .update(examProfileVersion)
          .set(row)
          .where(eq(examProfileVersion.profileVersionId, payload.profileVersionId));
      }
    });

    return ok({ aggregate: profile, aggregateVersion: 1 });
  }

  async update(
    profile: ExamProfileVersion,
    expectedAggregateVersion: number,
    isActive = false,
  ): Promise<Result<Persisted<ExamProfileVersion>, RepositoryError>> {
    const payload = serializeProfile(profile, isActive);
    const valid = validateProfileJsonb(payload);
    if (!valid.ok) return valid;

    const nextVersion = expectedAggregateVersion + 1;
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(examProfileVersion)
        .set({ ...toProfileRow(payload), aggregateVersion: nextVersion })
        .where(
          and(
            eq(examProfileVersion.profileVersionId, profile.profileVersionId),
            eq(examProfileVersion.aggregateVersion, expectedAggregateVersion),
          ),
        )
        .returning();

      if (rows.length === 0) return false;

      if (profile.state === 'draft') {
        await tx
          .delete(examSectionSpec)
          .where(eq(examSectionSpec.profileVersionId, profile.profileVersionId));
        await this.writeSections(tx, payload);
      }

      return true;
    });

    return updated
      ? ok({ aggregate: profile, aggregateVersion: nextVersion })
      : err(
          conflict(
            `exam profile version ${profile.profileVersionId} was modified by someone else: expected aggregate version ${expectedAggregateVersion}`,
          ),
        );
  }

  async findById(
    profileVersionId: ExamProfileVersionId,
  ): Promise<Result<Persisted<ExamProfileVersion>, RepositoryError>> {
    const rows = await this.db
      .select()
      .from(examProfileVersion)
      .where(eq(examProfileVersion.profileVersionId, profileVersionId));

    const row = rows[0];
    if (row === undefined) return err(notFound(`exam profile version ${profileVersionId} not found`));

    const sectionRows = await this.db
      .select()
      .from(examSectionSpec)
      .where(eq(examSectionSpec.profileVersionId, profileVersionId))
      .orderBy(asc(examSectionSpec.ordinal));

    const sections: SectionSpec[] = [];
    for (const sectionRow of sectionRows) {
      const section = toSectionSpec(sectionRow);
      if (!section.ok) return section;
      sections.push(section.value);
    }

    const profile = this.hydrate(row, sections);
    return profile.ok ? ok({ aggregate: profile.value, aggregateVersion: row.aggregateVersion }) : profile;
  }

  private hydrate(
    row: ProfileRow,
    sections: readonly SectionSpec[],
  ): Result<ExamProfileVersion, RepositoryError> {
    const timing = TimingPolicy.create(row.timingPolicy as CreateTimingPolicyProps);
    const navigation = NavigationPolicy.create(row.navigationPolicy as CreateNavigationPolicyProps);
    const ruleSet = MarkingRuleSet.create(row.markingRuleSet as MarkingRuleSetData);
    if (!timing.ok) return err(invalidJsonb('timing_policy', timing.error.message));
    if (!navigation.ok) return err(invalidJsonb('navigation_policy', navigation.error.message));
    if (!ruleSet.ok) return err(invalidJsonb('marking_rule_set', ruleSet.error.message));

    let tolerance: NumericAnswerSpec | undefined;
    if (row.toleranceDefaults !== null) {
      const parsed = NumericAnswerSpec.create(row.toleranceDefaults as CreateNumericAnswerSpecProps);
      if (!parsed.ok) return err(invalidJsonb('tolerance_defaults', parsed.error.message));
      tolerance = parsed.value;
    }

    const profile = ExamProfileVersion.reconstitute({
      profileVersionId: row.profileVersionId,
      examId: row.examId,
      academicYear: row.academicYear,
      taxonomyVersionId: row.taxonomyVersionId,
      state: row.state as TaxonomyState,
      sections,
      totalMarks: Number(row.totalMarks),
      timingPolicy: timing.value,
      navigationPolicy: navigation.value,
      markingRuleSet: ruleSet.value,
      ...(tolerance !== undefined ? { toleranceDefault: tolerance } : {}),
      itemTypeAllowances: row.itemTypeAllowances as readonly ItemTypeAllowance[],
      goldenSetValidation: row.goldenSetValidation as GoldenSetValidation,
      ...(row.publishedAt !== null ? { publishedAt: row.publishedAt } : {}),
      ...(row.publishedById !== null && row.publishedByKind !== null
        ? {
            publishedBy: {
              kind: row.publishedByKind as PrincipalRef['kind'],
              id: row.publishedById,
              roleContext: [],
            },
          }
        : {}),
      ...(row.markingRuleSetHash !== null ? { markingRuleSetHash: row.markingRuleSetHash } : {}),
    });

    return profile.ok
      ? ok(profile.value)
      : err(corruptRow(`exam profile version ${row.profileVersionId} cannot be loaded: ${(profile.error as ExamProfileVersionError).message}`));
  }

  private async writeSections(
    tx: Pick<NodePgDatabase, 'insert'>,
    payload: ProfileJsonPayload,
  ): Promise<void> {
    if (payload.sections.length === 0) return;

    await tx.insert(examSectionSpec).values(
      payload.sections.map((section) => ({
        profileVersionId: payload.profileVersionId,
        ordinal: section.ordinal,
        name: section.name,
        subject: section.subject,
        itemCount: section.itemCount,
        itemTypeMix: section.itemTypeMix,
        maxMarks: section.maxMarks.toFixed(2),
        sectionTimingMinutes: section.sectionTimingMinutes,
      })),
    );
  }
}
