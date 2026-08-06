import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import type { PrincipalRef } from '@questionbank/domain-types';
import { Exam } from '../../apps/api/src/contexts/curriculum/domain/exam.js';
import {
  ExamProfileVersion,
  type ItemTypeAllowance,
} from '../../apps/api/src/contexts/curriculum/domain/exam-profile-version.js';
import { SectionSpec } from '../../apps/api/src/contexts/curriculum/domain/section-spec.js';
import { MarkingRuleSet, type MarkingRuleSetData } from '../../apps/api/src/contexts/curriculum/domain/value-objects/marking-rule-set.js';
import { NumericAnswerSpec, type CreateNumericAnswerSpecProps } from '../../apps/api/src/contexts/curriculum/domain/value-objects/numeric-answer-spec.js';
import { TimingPolicy, type CreateTimingPolicyProps } from '../../apps/api/src/contexts/curriculum/domain/value-objects/timing-policy.js';
import { NavigationPolicy, type CreateNavigationPolicyProps } from '../../apps/api/src/contexts/curriculum/domain/value-objects/navigation-policy.js';
import type { TaxonomyVersionRepository } from '../../apps/api/src/contexts/curriculum/domain/repository-ports.js';
import type { DrizzleExamRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/exam.repository.js';
import type { DrizzleExamProfileVersionRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/exam-profile-version.repository.js';
import type { LoadIssue } from './taxonomy-loader.js';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema/exam-profile.schema.json');

export interface ProfileFile {
  readonly schemaVersion: number;
  readonly exam: {
    readonly code: string;
    readonly displayName: string;
    readonly jurisdiction: string;
    readonly conductingBody: string;
  };
  readonly academicYear: string;
  readonly taxonomyFamily: string;
  readonly totalMarks: number;
  readonly sections: ReadonlyArray<{
    readonly ordinal: number;
    readonly name: string;
    readonly subject: string;
    readonly itemCount: number;
    readonly itemTypeMix: Readonly<Record<string, number>>;
    readonly maxMarks: number;
    readonly sectionTimingMinutes?: number;
  }>;
  readonly timingPolicy: CreateTimingPolicyProps;
  readonly navigationPolicy: CreateNavigationPolicyProps;
  readonly markingRuleSet: MarkingRuleSetData;
  readonly toleranceDefault?: CreateNumericAnswerSpecProps;
  readonly itemTypeAllowances: readonly ItemTypeAllowance[];
}

export interface ProfileLoadReport {
  readonly examId: string;
  readonly profileVersionId: string;
  readonly markingRuleSetHash: string;
  readonly unchanged: boolean;
}

export type ProfileLoadOutcome =
  | { readonly ok: true; readonly report: ProfileLoadReport }
  | { readonly ok: false; readonly issues: readonly LoadIssue[] };

export interface ProfileLoaderDependencies {
  readonly exams: Pick<DrizzleExamRepository, 'insert' | 'findById'>;
  readonly profiles: Pick<DrizzleExamProfileVersionRepository, 'insert' | 'findById'>;
  readonly versions: TaxonomyVersionRepository;
  readonly identifierFor: (kind: 'exam' | 'profile', key: string) => string;
  readonly publishedBy: PrincipalRef;
  readonly publishedAt: Date;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFile = ajv.compile<ProfileFile>(
  JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>,
);

function issue(path: string, message: string): LoadIssue {
  return { path, line: null, message };
}

export function parseProfileFile(
  contents: string,
): { ok: true; file: ProfileFile } | { ok: false; issues: readonly LoadIssue[] } {
  const document = parseDocument(contents);
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => ({
        path: '(document)',
        line: contents.slice(0, error.pos[0]).split('\n').length,
        message: error.message,
      })),
    };
  }

  const parsed = document.toJS() as ProfileFile;
  if (!validateFile(parsed)) {
    return {
      ok: false,
      issues: (validateFile.errors ?? []).map((error) =>
        issue(error.instancePath === '' ? '(root)' : error.instancePath, error.message ?? 'is invalid'),
      ),
    };
  }

  return { ok: true, file: parsed };
}

/**
 * Loads an exam profile file and publishes it against the published taxonomy
 * version of the same family and year. Adding an exam is inserts only: no table
 * is named after an exam and no column is exam-specific (EXT-01).
 */
export async function loadProfileFile(
  contents: string,
  deps: ProfileLoaderDependencies,
): Promise<ProfileLoadOutcome> {
  const parsed = parseProfileFile(contents);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const file = parsed.file;
  const examId = deps.identifierFor('exam', file.exam.code);
  const profileVersionId = deps.identifierFor('profile', `${file.exam.code}:${file.academicYear}`);

  const alreadyLoaded = await deps.profiles.findById(profileVersionId);
  if (alreadyLoaded.ok) {
    return {
      ok: true,
      report: {
        examId,
        profileVersionId,
        markingRuleSetHash: alreadyLoaded.value.aggregate.markingRuleSetHash ?? '',
        unchanged: true,
      },
    };
  }

  const existingExam = await deps.exams.findById(examId);
  if (!existingExam.ok) {
    const exam = Exam.create({ examId, ...file.exam });
    if (!exam.ok) return { ok: false, issues: [issue('/exam', exam.error.message)] };

    const stored = await deps.exams.insert(exam.value);
    if (!stored.ok) return { ok: false, issues: [issue('/exam', stored.error.message)] };
  }

  const taxonomy = (await deps.versions.listByExamFamily(file.taxonomyFamily)).find(
    (candidate) =>
      candidate.aggregate.academicYear === file.academicYear &&
      candidate.aggregate.state === 'published',
  );
  if (taxonomy === undefined) {
    return {
      ok: false,
      issues: [
        issue(
          '/taxonomyFamily',
          `no published taxonomy version for ${file.taxonomyFamily} ${file.academicYear}; load and publish the taxonomy first`,
        ),
      ],
    };
  }

  const sections: SectionSpec[] = [];
  for (const section of file.sections) {
    const created = SectionSpec.create({
      ordinal: section.ordinal,
      name: section.name,
      subject: section.subject,
      itemCount: section.itemCount,
      itemTypeMix: section.itemTypeMix,
      maxMarks: section.maxMarks,
      ...(section.sectionTimingMinutes !== undefined
        ? { sectionTiming: { durationMinutes: section.sectionTimingMinutes } }
        : {}),
    });
    if (!created.ok) return { ok: false, issues: [issue(`/sections/${section.ordinal}`, created.error.message)] };
    sections.push(created.value);
  }

  const timing = TimingPolicy.create(file.timingPolicy);
  if (!timing.ok) return { ok: false, issues: [issue('/timingPolicy', timing.error.message)] };

  const navigation = NavigationPolicy.create(file.navigationPolicy);
  if (!navigation.ok) return { ok: false, issues: [issue('/navigationPolicy', navigation.error.message)] };

  const ruleSet = MarkingRuleSet.create(file.markingRuleSet);
  if (!ruleSet.ok) return { ok: false, issues: [issue('/markingRuleSet', ruleSet.error.message)] };

  let tolerance: NumericAnswerSpec | undefined;
  if (file.toleranceDefault !== undefined) {
    const created = NumericAnswerSpec.create(file.toleranceDefault);
    if (!created.ok) return { ok: false, issues: [issue('/toleranceDefault', created.error.message)] };
    tolerance = created.value;
  }

  const draft = ExamProfileVersion.createDraft({
    profileVersionId,
    examId,
    academicYear: file.academicYear,
    taxonomyVersionId: taxonomy.aggregate.taxonomyVersionId,
    sections,
    totalMarks: file.totalMarks,
    timingPolicy: timing.value,
    navigationPolicy: navigation.value,
    markingRuleSet: ruleSet.value,
    ...(tolerance !== undefined ? { toleranceDefault: tolerance } : {}),
    itemTypeAllowances: file.itemTypeAllowances,
  });
  if (!draft.ok) return { ok: false, issues: [issue('(root)', draft.error.message)] };

  const published = draft.value.publish({
    taxonomyVersionIsPublished: true,
    publishedBy: deps.publishedBy,
    publishedAt: deps.publishedAt,
  });
  if (!published.ok) return { ok: false, issues: [issue('(root)', published.error.message)] };

  const stored = await deps.profiles.insert(published.value, true);
  if (!stored.ok) return { ok: false, issues: [issue('(root)', stored.error.message)] };

  return {
    ok: true,
    report: {
      examId,
      profileVersionId,
      markingRuleSetHash: published.value.markingRuleSetHash ?? '',
      unchanged: false,
    },
  };
}
