import { SectionSpec, type CreateSectionSpecProps } from '../contexts/curriculum/domain/section-spec.js';
import { MarkingRuleSet } from '../contexts/curriculum/domain/value-objects/marking-rule-set.js';
import { TimingPolicy } from '../contexts/curriculum/domain/value-objects/timing-policy.js';
import { NavigationPolicy } from '../contexts/curriculum/domain/value-objects/navigation-policy.js';
import { NumericAnswerSpec } from '../contexts/curriculum/domain/value-objects/numeric-answer-spec.js';
import {
  ExamProfileVersion,
  type CreateExamProfileVersionProps,
} from '../contexts/curriculum/domain/exam-profile-version.js';
import { JEE_MAIN_RULE_SET } from './marking-fixtures.js';
import { expectValue } from './expect-result.js';

export const MCQ = 'SINGLE_CORRECT_MCQ';
export const NUMERIC = 'NUMERIC';

/** The JEE Main rule set extended to cover numeric items as well as MCQ. */
export const JEE_MAIN_FULL_RULE_SET = {
  schemaVersion: JEE_MAIN_RULE_SET.schemaVersion,
  rules: JEE_MAIN_RULE_SET.rules.map((rule) => ({
    ...rule,
    appliesTo: { itemTypes: [MCQ, NUMERIC] },
  })),
};

export function aSection(overrides: Partial<CreateSectionSpecProps> = {}): SectionSpec {
  return expectValue(
    SectionSpec.create({
      ordinal: 1,
      name: 'Physics',
      subject: 'physics',
      itemCount: 25,
      itemTypeMix: { [MCQ]: 20, [NUMERIC]: 5 },
      maxMarks: 100,
      ...overrides,
    }),
  );
}

/** Physics, Chemistry, Mathematics — 25 items and 100 marks each. */
export function jeeMainSections(): SectionSpec[] {
  return [
    aSection(),
    aSection({ ordinal: 2, name: 'Chemistry', subject: 'chemistry' }),
    aSection({ ordinal: 3, name: 'Mathematics', subject: 'mathematics' }),
  ];
}

export function jeeMainTiming(): TimingPolicy {
  return expectValue(
    TimingPolicy.create({
      totalDurationMinutes: 180,
      sectionLocking: false,
      warningThresholdsMinutes: [30, 10, 5],
      autoSubmitOnExpiry: true,
    }),
  );
}

export function jeeMainNavigation(): NavigationPolicy {
  return expectValue(
    NavigationPolicy.create({
      crossSectionNavigation: true,
      allowMarkForReview: true,
      allowAnswerChange: true,
      allowClearResponse: true,
    }),
  );
}

export function jeeMainToleranceDefault(): NumericAnswerSpec {
  return expectValue(
    NumericAnswerSpec.create({
      expectedValue: '0',
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      toleranceValue: '0.01',
      acceptedForms: ['DECIMAL', 'SCIENTIFIC'],
    }),
  );
}

export function jeeMainProfileProps(
  overrides: Partial<CreateExamProfileVersionProps> = {},
): CreateExamProfileVersionProps {
  return {
    profileVersionId: 'epv_jee_main_2026',
    examId: 'ex_jee_main',
    academicYear: '2026',
    taxonomyVersionId: 'tv_jee_main_2026',
    sections: jeeMainSections(),
    totalMarks: 300,
    timingPolicy: jeeMainTiming(),
    navigationPolicy: jeeMainNavigation(),
    markingRuleSet: expectValue(MarkingRuleSet.create(JEE_MAIN_FULL_RULE_SET)),
    toleranceDefault: jeeMainToleranceDefault(),
    itemTypeAllowances: [
      { itemType: MCQ, sectionOrdinals: [1, 2, 3] },
      { itemType: NUMERIC, sectionOrdinals: [1, 2, 3] },
    ],
    ...overrides,
  };
}

export function aJeeMainProfileDraft(
  overrides: Partial<CreateExamProfileVersionProps> = {},
): ExamProfileVersion {
  return expectValue(ExamProfileVersion.createDraft(jeeMainProfileProps(overrides)));
}
