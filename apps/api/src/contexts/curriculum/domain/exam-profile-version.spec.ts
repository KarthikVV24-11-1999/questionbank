import { describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ExamProfileVersion, type PublicationContext } from './exam-profile-version.js';
import { SectionSpec } from './section-spec.js';
import { MarkingRuleSet } from './value-objects/marking-rule-set.js';
import { TimingPolicy } from './value-objects/timing-policy.js';
import { NavigationPolicy } from './value-objects/navigation-policy.js';
import { hashMarkingRuleSet } from './value-objects/marking-rule-set-hash.js';
import { JEE_ADVANCED_RULE_SET } from '../../../testing/marking-fixtures.js';
import {
  MCQ,
  NUMERIC,
  aJeeMainProfileDraft,
  aSection,
  jeeMainProfileProps,
  jeeMainSections,
} from '../../../testing/profile-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import goldenHashes from '../../../testing/golden/marking-rule-set-hashes.json' with { type: 'json' };

const publisher: PrincipalRef = { kind: 'human', id: 'usr_owner', roleContext: ['exam_owner'] };

const context: PublicationContext = {
  taxonomyVersionIsPublished: true,
  publishedBy: publisher,
  publishedAt: new Date('2026-08-05T12:00:00.000Z'),
};

function published(): ExamProfileVersion {
  return expectValue(aJeeMainProfileDraft().publish(context));
}

describe('ExamProfileVersion composition', () => {
  it('composes sections, policies, marking, tolerance, allowances and taxonomy reference', () => {
    const draft = aJeeMainProfileDraft();

    expect(draft.state).toBe('draft');
    expect(draft.sections).toHaveLength(3);
    expect(draft.totalMarks).toBe(300);
    expect(draft.timingPolicy.totalDurationMinutes).toBe(180);
    expect(draft.navigationPolicy.crossSectionNavigation).toBe(true);
    expect(draft.markingRuleSet.rules).toHaveLength(4);
    expect(draft.toleranceDefault?.comparisonMode).toBe('ABSOLUTE_TOLERANCE');
    expect(draft.itemTypeAllowances.map((allowance) => allowance.itemType)).toEqual([MCQ, NUMERIC]);
    expect(draft.taxonomyVersionId).toBe('tv_jee_main_2026');
  });

  it('always carries a goldenSetValidation field, defaulted to not_run', () => {
    expect(aJeeMainProfileDraft().goldenSetValidation).toEqual({ status: 'not_run' });
  });

  it('keeps sections in ordinal order regardless of input order', () => {
    const [first, second, third] = jeeMainSections();
    const draft = aJeeMainProfileDraft({ sections: [third, second, first] as SectionSpec[] });

    expect(draft.sections.map((section) => section.ordinal)).toEqual([1, 2, 3]);
    expect(draft.sectionByOrdinal(2)?.subject).toBe('chemistry');
  });

  it.each([
    ['a blank profile version id', { profileVersionId: ' ' }, 'PROFILE_VERSION_ID_REQUIRED'],
    ['a blank exam id', { examId: '' }, 'EXAM_ID_REQUIRED'],
    ['a malformed academic year', { academicYear: '26' }, 'ACADEMIC_YEAR_INVALID'],
    ['a blank taxonomy version id', { taxonomyVersionId: ' ' }, 'TAXONOMY_VERSION_ID_REQUIRED'],
    ['zero total marks', { totalMarks: 0 }, 'TOTAL_MARKS_INVALID'],
    ['no item type allowances', { itemTypeAllowances: [] }, 'ITEM_TYPE_ALLOWANCES_REQUIRED'],
  ])('rejects %s', (_case, overrides, code) => {
    expect(expectError(ExamProfileVersion.createDraft(jeeMainProfileProps(overrides))).code).toBe(code);
  });

  it('rejects a duplicated item type allowance', () => {
    expect(
      expectError(
        ExamProfileVersion.createDraft(
          jeeMainProfileProps({
            itemTypeAllowances: [
              { itemType: MCQ, sectionOrdinals: [1] },
              { itemType: MCQ, sectionOrdinals: [2] },
            ],
          }),
        ),
      ).code,
    ).toBe('DUPLICATE_ITEM_TYPE_ALLOWANCE');
  });

  it('rejects an allowance naming a section that does not exist', () => {
    expect(
      expectError(
        ExamProfileVersion.createDraft(
          jeeMainProfileProps({ itemTypeAllowances: [{ itemType: MCQ, sectionOrdinals: [9] }] }),
        ),
      ).code,
    ).toBe('ALLOWANCE_SECTION_UNKNOWN');
  });
});

describe('ExamProfileVersion publication', () => {
  it('publishes the JEE Main 2026 profile', () => {
    const profile = published();

    expect(profile.state).toBe('published');
    expect(profile.publishedBy).toEqual(publisher);
    expect(profile.publishedAt?.toISOString()).toBe('2026-08-05T12:00:00.000Z');
  });

  it('freezes the marking rule set hash at publication', () => {
    const profile = published();

    expect(profile.markingRuleSetHash).toBe(hashMarkingRuleSet(profile.markingRuleSet));
    expect(profile.markingRuleSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(aJeeMainProfileDraft().markingRuleSetHash).toBeUndefined();
  });

  it('moves published → superseded and rejects every other transition', () => {
    const profile = published();

    expect(expectValue(profile.supersede()).state).toBe('superseded');
    expect(expectError(profile.publish(context)).code).toBe('ILLEGAL_STATE_TRANSITION');
    expect(expectError(aJeeMainProfileDraft().supersede()).code).toBe('ILLEGAL_STATE_TRANSITION');
  });

  it('reports no precondition failures for a valid profile', () => {
    expect(aJeeMainProfileDraft().publicationPreconditions(true)).toEqual([]);
  });
});

describe('ExamProfileVersion publication preconditions', () => {
  it('blocks publication when the blueprint arithmetic is inconsistent', () => {
    const draft = aJeeMainProfileDraft({ totalMarks: 299 });

    const error = expectError(draft.publish(context));

    expect(error.code).toBe('BLUEPRINT_INCONSISTENT');
    expect(draft.state).toBe('draft');
  });

  it('blocks publication when section ordinals are not contiguous', () => {
    const sections = [aSection(), aSection({ ordinal: 3, name: 'Maths', subject: 'mathematics' })];
    const draft = aJeeMainProfileDraft({
      sections,
      totalMarks: 200,
      itemTypeAllowances: [
        { itemType: MCQ, sectionOrdinals: [1, 3] },
        { itemType: NUMERIC, sectionOrdinals: [1, 3] },
      ],
    });

    expect(expectError(draft.publish(context)).code).toBe('BLUEPRINT_INCONSISTENT');
  });

  it('blocks publication when timing and navigation contradict each other', () => {
    const timingPolicy = expectValue(
      TimingPolicy.create({
        totalDurationMinutes: 180,
        sectionLocking: true,
        warningThresholdsMinutes: [30],
        autoSubmitOnExpiry: true,
      }),
    );
    const sections = jeeMainSections().map((section) =>
      expectValue(
        SectionSpec.create({
          ordinal: section.ordinal,
          name: section.name,
          subject: section.subject,
          itemCount: section.itemCount,
          itemTypeMix: section.itemTypeMix,
          maxMarks: section.maxMarks,
          sectionTiming: { durationMinutes: 60 },
        }),
      ),
    );
    const draft = aJeeMainProfileDraft({ timingPolicy, sections });

    expect(expectError(draft.publish(context)).code).toBe('CONTRADICTORY_DELIVERY_POLICIES');
  });

  it('blocks publication when an allowed item type has no matching marking rule', () => {
    const draft = aJeeMainProfileDraft({
      itemTypeAllowances: [
        { itemType: MCQ, sectionOrdinals: [1, 2, 3] },
        { itemType: 'MATCHING', sectionOrdinals: [1] },
      ],
    });

    const error = expectError(draft.publish(context));

    expect(error.code).toBe('ITEM_TYPE_WITHOUT_MARKING_RULE');
    expect(error.message).toContain('MATCHING');
  });

  it('blocks publication when the referenced taxonomy version is not published', () => {
    const error = expectError(
      aJeeMainProfileDraft().publish({ ...context, taxonomyVersionIsPublished: false }),
    );

    expect(error.code).toBe('TAXONOMY_VERSION_NOT_PUBLISHED');
  });

  it('evaluates every precondition before any write', () => {
    const draft = aJeeMainProfileDraft({ totalMarks: 299 });

    const failures = draft.publicationPreconditions(false).map((failure) => failure.code);

    expect(failures).toEqual(['BLUEPRINT_INCONSISTENT', 'TAXONOMY_VERSION_NOT_PUBLISHED']);
    expect(draft.markingRuleSetHash).toBeUndefined();
    expect(draft.state).toBe('draft');
  });
});

describe('ExamProfileVersion immutability after publication', () => {
  const mutators = [
    ['replaceSections', (profile: ExamProfileVersion) => profile.replaceSections(jeeMainSections())],
    [
      'replaceMarkingRuleSet',
      (profile: ExamProfileVersion) =>
        profile.replaceMarkingRuleSet(expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET))),
    ],
    [
      'replaceItemTypeAllowances',
      (profile: ExamProfileVersion) =>
        profile.replaceItemTypeAllowances([{ itemType: MCQ, sectionOrdinals: [1] }]),
    ],
    [
      'recordGoldenSetValidation',
      (profile: ExamProfileVersion) => profile.recordGoldenSetValidation({ status: 'passed', caseCount: 10 }),
    ],
  ] as const;

  it.each(mutators)('rejects %s on a published profile', (_name, mutate) => {
    expect(expectError(mutate(published())).code).toBe('PROFILE_NOT_MUTABLE');
  });

  it.each(mutators)('rejects %s on a superseded profile', (_name, mutate) => {
    const superseded = expectValue(published().supersede());

    expect(expectError(mutate(superseded)).code).toBe('PROFILE_NOT_MUTABLE');
  });

  it.each(mutators)('accepts %s while the profile is a draft', (_name, mutate) => {
    expect(mutate(aJeeMainProfileDraft()).ok).toBe(true);
  });

  it('is frozen', () => {
    const profile = published();

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.sections)).toBe(true);
    expect(Object.isFrozen(profile.itemTypeAllowances)).toBe(true);
  });
});

describe('EXT-01: a differently shaped exam is configuration, not code', () => {
  it('publishes a NEET-shaped profile — 180 items, 720 marks, 200 minutes', () => {
    const sections = [
      aSection({ ordinal: 1, name: 'Physics', subject: 'physics', itemCount: 45, itemTypeMix: { [MCQ]: 45 }, maxMarks: 180 }),
      aSection({ ordinal: 2, name: 'Chemistry', subject: 'chemistry', itemCount: 45, itemTypeMix: { [MCQ]: 45 }, maxMarks: 180 }),
      aSection({ ordinal: 3, name: 'Biology', subject: 'biology', itemCount: 90, itemTypeMix: { [MCQ]: 90 }, maxMarks: 360 }),
    ];
    const timingPolicy = expectValue(
      TimingPolicy.create({
        totalDurationMinutes: 200,
        sectionLocking: false,
        warningThresholdsMinutes: [30, 5],
        autoSubmitOnExpiry: true,
      }),
    );

    const profile = expectValue(
      expectValue(
        ExamProfileVersion.createDraft(
          jeeMainProfileProps({
            profileVersionId: 'epv_neet_ug_2026',
            examId: 'ex_neet_ug',
            sections,
            totalMarks: 720,
            timingPolicy,
            itemTypeAllowances: [{ itemType: MCQ, sectionOrdinals: [1, 2, 3] }],
          }),
        ),
      ).publish(context),
    );

    expect(profile.state).toBe('published');
    expect(profile.sections.reduce((total, section) => total + section.itemCount, 0)).toBe(180);
    expect(profile.totalMarks).toBe(720);
  });

  it('publishes a JEE Advanced-shaped profile with the seven-rule set and no code change', () => {
    const markingRuleSet = expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET));
    const sections = [
      aSection({ ordinal: 1, itemCount: 18, itemTypeMix: { MULTIPLE_CORRECT_MCQ: 18 }, maxMarks: 60 }),
    ];
    const navigationPolicy = expectValue(
      NavigationPolicy.create({
        crossSectionNavigation: true,
        allowMarkForReview: true,
        allowAnswerChange: true,
        allowClearResponse: false,
      }),
    );

    const profile = expectValue(
      expectValue(
        ExamProfileVersion.createDraft(
          jeeMainProfileProps({
            profileVersionId: 'epv_jee_advanced_2026',
            examId: 'ex_jee_advanced',
            sections,
            totalMarks: 60,
            markingRuleSet,
            navigationPolicy,
            itemTypeAllowances: [{ itemType: 'MULTIPLE_CORRECT_MCQ', sectionOrdinals: [1] }],
          }),
        ),
      ).publish(context),
    );

    expect(profile.state).toBe('published');
    expect(profile.markingRuleSet.rules).toHaveLength(7);
    expect(profile.markingRuleSetHash).toBe(goldenHashes.jeeAdvanced);
  });
});
