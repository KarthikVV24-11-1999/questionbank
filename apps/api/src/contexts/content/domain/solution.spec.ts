import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT, textBody } from '../../../testing/content-fixtures.js';
import { LIFECYCLE_STATES, type LifecycleState } from './item-lifecycle.js';
import {
  addSolutionVersion,
  createSolution,
  createSolutionVersion,
  isComplete,
  latestSolutionVersionOf,
  publishedSolutionVersionOf,
  reconstituteSolution,
  transitionSolution,
  unanalysedDistractors,
  type CreateSolutionVersionProps,
  type FinalAnswerAssertion,
  type Solution,
  type SolutionStep,
  type SolutionVersion,
} from './solution.js';

function step(ordinal: number, value = `step ${ordinal}`): SolutionStep {
  return { ordinal, body: textBody(value), conceptRefs: ['concept-kinematics'] };
}

const OPTION_ANSWER: FinalAnswerAssertion = { kind: 'OPTION', optionId: 'b' };

function versionProps(overrides: Partial<CreateSolutionVersionProps> = {}): CreateSolutionVersionProps {
  return {
    versionId: 'solution-version-1',
    versionNo: 1,
    finalAnswerAssertion: OPTION_ANSWER,
    steps: [step(1), step(2)],
    authoredBy: AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}

function version(overrides: Partial<CreateSolutionVersionProps> = {}): SolutionVersion {
  return expectValue(createSolutionVersion(versionProps(overrides)));
}

const V1 = version();
const V2 = version({ versionId: 'solution-version-2', versionNo: 2 });

function draft(): Solution {
  return expectValue(
    createSolution({
      solutionId: 'solution-1',
      itemId: 'item-1',
      targetItemVersionId: 'version-1',
      initialVersion: V1,
    }),
  );
}

function inState(state: LifecycleState, versions: readonly SolutionVersion[] = [V1]): Solution {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteSolution({
      solutionId: 'solution-1',
      itemId: 'item-1',
      targetItemVersionId: 'version-1',
      lifecycleState: state,
      versions,
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: V1.versionId } : {}),
    }),
  );
}

describe('a solution version', () => {
  it('constructs with an assertion and steps', () => {
    expect(version()).toMatchObject({ versionId: 'solution-version-1', versionNo: 1 });
    expect(version().steps).toHaveLength(2);
  });

  it.each([
    ['an option', { kind: 'OPTION', optionId: 'b' }],
    ['an option set', { kind: 'OPTION_SET', optionIds: ['a', 'c'] }],
    ['a pairing', { kind: 'PAIRS', pairs: [{ left: 'l1', right: 'r2' }] }],
    ['a numeric value', { kind: 'NUMERIC', value: '9.81', unit: 'm/s^2' }],
  ] as const)('states a final answer as %s', (_label, finalAnswerAssertion) => {
    expect(version({ finalAnswerAssertion }).finalAnswerAssertion).toEqual(finalAnswerAssertion);
  });

  it('rejects an unknown final-answer kind', () => {
    const rogue = { kind: 'FREE_TEXT', value: 'x' } as unknown as FinalAnswerAssertion;
    expect(expectError(createSolutionVersion(versionProps({ finalAnswerAssertion: rogue }))).code).toBe(
      'FINAL_ANSWER_KIND_UNKNOWN',
    );
  });

  it.each([
    ['a blank option', { kind: 'OPTION', optionId: ' ' }],
    ['an empty option set', { kind: 'OPTION_SET', optionIds: [] }],
    ['an empty pairing', { kind: 'PAIRS', pairs: [] }],
    ['a blank numeric value', { kind: 'NUMERIC', value: '' }],
  ] as const)('rejects %s', (_label, finalAnswerAssertion) => {
    expect(expectError(createSolutionVersion(versionProps({ finalAnswerAssertion }))).code).toBe(
      'FINAL_ANSWER_REQUIRED',
    );
  });

  // M3-14 compares it through the item's own NumericAnswerSpec, so reading it
  // as a double here would decide agreement on a value nobody wrote.
  it('keeps a numeric assertion as the authored literal', () => {
    const assertion: FinalAnswerAssertion = { kind: 'NUMERIC', value: '9.8100' };
    const built = version({ finalAnswerAssertion: assertion });
    expect(built.finalAnswerAssertion).toEqual({ kind: 'NUMERIC', value: '9.8100' });
  });

  it('rejects a version with no steps', () => {
    expect(expectError(createSolutionVersion(versionProps({ steps: [] }))).code).toBe('STEPS_REQUIRED');
  });

  it('rejects a gap in the step ordinals', () => {
    expect(expectError(createSolutionVersion(versionProps({ steps: [step(1), step(3)] }))).code).toBe(
      'STEP_ORDINALS_NOT_CONTIGUOUS',
    );
  });

  it('accepts steps supplied out of order, so long as the set is contiguous', () => {
    expect(version({ steps: [step(2), step(1)] }).steps).toHaveLength(2);
  });

  it('rejects a blank version id', () => {
    expect(expectError(createSolutionVersion(versionProps({ versionId: '' }))).code).toBe(
      'VERSION_ID_REQUIRED',
    );
  });

  it.each([
    ['zero', 0],
    ['fractional', 2.5],
  ])('rejects a versionNo that is %s', (_label, versionNo) => {
    expect(expectError(createSolutionVersion(versionProps({ versionNo }))).code).toBe('VERSION_NO_INVALID');
  });

  it('requires an author (INV-02)', () => {
    expect(
      expectError(createSolutionVersion(versionProps({ authoredBy: { ...AUTHOR, id: '' } }))).code,
    ).toBe('AUTHORED_BY_REQUIRED');
  });

  it('rejects a malformed timestamp', () => {
    expect(expectError(createSolutionVersion(versionProps({ createdAt: 'yesterday' }))).code).toBe(
      'CREATED_AT_NOT_A_TIMESTAMP',
    );
  });
});

describe('distractor analysis and alternate approaches', () => {
  it('carries an analysis per option', () => {
    const built = version({
      distractorAnalyses: [
        { optionId: 'a', misconception: textBody('confuses mass with weight') },
        { optionId: 'c', misconception: textBody('drops the factor of two') },
      ],
    });
    expect(built.distractorAnalyses).toHaveLength(2);
  });

  it('rejects the same option analysed twice', () => {
    expect(
      expectError(
        createSolutionVersion(
          versionProps({
            distractorAnalyses: [
              { optionId: 'a', misconception: textBody('one reason') },
              { optionId: 'a', misconception: textBody('another reason') },
            ],
          }),
        ),
      ).code,
    ).toBe('DISTRACTOR_OPTION_DUPLICATE');
  });

  it('defaults to no analyses and no approaches', () => {
    expect(version().distractorAnalyses).toEqual([]);
    expect(version().alternateApproaches).toEqual([]);
  });

  it('carries an alternate approach with its own steps', () => {
    const built = version({
      alternateApproaches: [
        { label: 'by energy conservation', steps: [step(1)], applicabilityNote: 'when friction is absent' },
      ],
    });
    expect(built.alternateApproaches[0]?.label).toBe('by energy conservation');
  });

  it('rejects an alternate approach with no label', () => {
    expect(
      expectError(
        createSolutionVersion(versionProps({ alternateApproaches: [{ label: '  ', steps: [step(1)] }] })),
      ).code,
    ).toBe('ALTERNATE_APPROACH_LABEL_REQUIRED');
  });

  it('validates an alternate approach’s own step ordinals', () => {
    expect(
      expectError(
        createSolutionVersion(
          versionProps({ alternateApproaches: [{ label: 'by symmetry', steps: [step(1), step(4)] }] }),
        ),
      ).code,
    ).toBe('STEP_ORDINALS_NOT_CONTIGUOUS');
  });

  it('rejects an alternate approach with no steps', () => {
    expect(
      expectError(
        createSolutionVersion(versionProps({ alternateApproaches: [{ label: 'by symmetry', steps: [] }] })),
      ).code,
    ).toBe('STEPS_REQUIRED');
  });
});

describe('the completeness grade is computed, never asserted (FR-TCH-04 rule 2)', () => {
  const INCORRECT = ['a', 'c', 'd'];

  // A grade an author can claim is a grade an author will claim.
  it('is complete when every incorrect option is analysed', () => {
    const built = version({
      distractorAnalyses: INCORRECT.map((optionId) => ({ optionId, misconception: textBody('why') })),
    });
    expect(isComplete(built, INCORRECT)).toBe(true);
    expect(unanalysedDistractors(built, INCORRECT)).toEqual([]);
  });

  it('is incomplete when one is missing, and names which', () => {
    const built = version({
      distractorAnalyses: [
        { optionId: 'a', misconception: textBody('why') },
        { optionId: 'c', misconception: textBody('why') },
      ],
    });
    expect(isComplete(built, INCORRECT)).toBe(false);
    expect(unanalysedDistractors(built, INCORRECT)).toEqual(['d']);
  });

  it('is incomplete with no analyses at all', () => {
    expect(isComplete(version(), INCORRECT)).toBe(false);
    expect(unanalysedDistractors(version(), INCORRECT)).toEqual(INCORRECT);
  });

  it('is complete for an item type with no distractors', () => {
    expect(isComplete(version(), [])).toBe(true);
  });

  it('returns a frozen list', () => {
    expect(Object.isFrozen(unanalysedDistractors(version(), INCORRECT))).toBe(true);
  });
});

describe('a solution targets an item version, not an item (FR-TCH-04 rule 3)', () => {
  it('records the target version', () => {
    expect(draft().targetItemVersionId).toBe('version-1');
  });

  // A solution for version 1 says nothing about version 2, whose key may
  // differ. This is what lets an explanation be rewritten a year later
  // without any attempt's meaning changing.
  it('refuses a solution that names no target version', () => {
    expect(
      expectError(
        createSolution({
          solutionId: 's',
          itemId: 'item-1',
          targetItemVersionId: '  ',
          initialVersion: V1,
        }),
      ).code,
    ).toBe('TARGET_ITEM_VERSION_REQUIRED');
  });

  it('refuses a solution that names no item', () => {
    expect(
      expectError(
        createSolution({ solutionId: 's', itemId: '', targetItemVersionId: 'v', initialVersion: V1 }),
      ).code,
    ).toBe('ITEM_ID_REQUIRED');
  });

  it('refuses a blank solution id', () => {
    expect(
      expectError(
        createSolution({ solutionId: ' ', itemId: 'i', targetItemVersionId: 'v', initialVersion: V1 }),
      ).code,
    ).toBe('SOLUTION_ID_REQUIRED');
  });

  it('refuses a first version that is not version 1', () => {
    expect(
      expectError(
        createSolution({ solutionId: 's', itemId: 'i', targetItemVersionId: 'v', initialVersion: V2 }),
      ).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });
});

describe('reconstitution', () => {
  it('restores a solution in any state', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(inState(state).lifecycleState).toBe(state);
    }
  });

  it('rejects a blank id', () => {
    expect(
      expectError(
        reconstituteSolution({
          solutionId: '',
          itemId: 'i',
          targetItemVersionId: 'v',
          lifecycleState: 'draft',
          versions: [V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('SOLUTION_ID_REQUIRED');
  });

  it('rejects an empty version list', () => {
    expect(
      expectError(
        reconstituteSolution({
          solutionId: 's',
          itemId: 'i',
          targetItemVersionId: 'v',
          lifecycleState: 'draft',
          versions: [],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSIONS_REQUIRED');
  });

  it('rejects a duplicate version id', () => {
    expect(
      expectError(
        reconstituteSolution({
          solutionId: 's',
          itemId: 'i',
          targetItemVersionId: 'v',
          lifecycleState: 'draft',
          versions: [V1, V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_ID_DUPLICATE');
  });

  it('rejects a gap in the version numbers', () => {
    const third = version({ versionId: 'solution-version-3', versionNo: 3 });
    expect(
      expectError(
        reconstituteSolution({
          solutionId: 's',
          itemId: 'i',
          targetItemVersionId: 'v',
          lifecycleState: 'draft',
          versions: [V1, third],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('rejects a published reference it does not hold', () => {
    expect(
      expectError(
        reconstituteSolution({
          solutionId: 's',
          itemId: 'i',
          targetItemVersionId: 'v',
          lifecycleState: 'published',
          versions: [V1],
          currentPublishedVersionId: 'elsewhere',
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('PUBLISHED_VERSION_UNKNOWN');
  });

  it.each([['published'], ['suspended']] as const)(
    'rejects a %s solution naming no published version',
    (lifecycleState) => {
      expect(
        expectError(
          reconstituteSolution({
            solutionId: 's',
            itemId: 'i',
            targetItemVersionId: 'v',
            lifecycleState,
            versions: [V1],
            aggregateVersion: 1,
          }),
        ).code,
      ).toBe('PUBLISHED_VERSION_REQUIRED');
    },
  );

  it('omits an absent published reference', () => {
    expect(Object.hasOwn(inState('draft'), 'currentPublishedVersionId')).toBe(false);
  });
});

describe('correcting an explanation is the case D5 exists to make cheap', () => {
  it('appends a version and bumps the aggregate version', () => {
    const updated = expectValue(addSolutionVersion(draft(), V2));
    expect(updated.versions).toHaveLength(2);
    expect(updated.aggregateVersion).toBe(2);
  });

  it('permits a new version while published', () => {
    expect(expectValue(addSolutionVersion(inState('published'), V2)).versions).toHaveLength(2);
  });

  it('refuses a new version on a retired solution', () => {
    expect(expectError(addSolutionVersion(inState('retired'), V2)).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('refuses a duplicate version id as a Conflict', () => {
    const failure = expectError(addSolutionVersion(draft(), V1));
    expect(failure.code).toBe('VERSION_ID_DUPLICATE');
    expect(failure.kind).toBe('Conflict');
  });

  it('refuses a version number that skips ahead', () => {
    const third = version({ versionId: 'solution-version-3', versionNo: 3 });
    expect(expectError(addSolutionVersion(draft(), third)).code).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  // The target version never moves, which is what keeps historical attempts
  // interpretable while the explanation improves.
  it('leaves the target item version unchanged across a correction', () => {
    expect(expectValue(addSolutionVersion(draft(), V2)).targetItemVersionId).toBe('version-1');
  });

  it('reports the latest version in order and out of order', () => {
    expect(latestSolutionVersionOf(expectValue(addSolutionVersion(draft(), V2))).versionNo).toBe(2);
    const outOfOrder = expectValue(
      reconstituteSolution({
        solutionId: 's',
        itemId: 'i',
        targetItemVersionId: 'v',
        lifecycleState: 'draft',
        versions: [V2, V1],
        aggregateVersion: 2,
      }),
    );
    expect(latestSolutionVersionOf(outOfOrder).versionNo).toBe(2);
  });
});

describe('transitions', () => {
  it('uses the item lifecycle unchanged', () => {
    expect(expectValue(transitionSolution(draft(), { transition: 'submit_for_review' })).lifecycleState).toBe(
      'in_review',
    );
  });

  it('refuses an illegal transition', () => {
    expect(expectError(transitionSolution(draft(), { transition: 'publish' })).code).toBe(
      'TRANSITION_ILLEGAL',
    );
  });

  it('publishes a named version', () => {
    const published = expectValue(
      transitionSolution(inState('approved'), { transition: 'publish', versionId: V1.versionId }),
    );
    expect(published.currentPublishedVersionId).toBe(V1.versionId);
    expect(publishedSolutionVersionOf(published)?.versionId).toBe(V1.versionId);
  });

  it('refuses publication naming no version', () => {
    expect(expectError(transitionSolution(inState('approved'), { transition: 'publish' })).code).toBe(
      'VERSION_NOT_FOUND',
    );
  });

  it('refuses publication naming a version it does not hold', () => {
    expect(
      expectError(
        transitionSolution(inState('approved'), { transition: 'publish', versionId: 'elsewhere' }),
      ).code,
    ).toBe('VERSION_NOT_FOUND');
  });

  it('reports no published version before publication', () => {
    expect(publishedSolutionVersionOf(draft())).toBeUndefined();
  });
});

describe('immutability', () => {
  it('freezes the version, its steps and their concept references', () => {
    const built = version();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.steps)).toBe(true);
    expect(Object.isFrozen(built.steps[0])).toBe(true);
    expect(Object.isFrozen(built.steps[0]?.conceptRefs)).toBe(true);
  });

  it('freezes analyses and approaches, including nested steps', () => {
    const built = version({
      distractorAnalyses: [{ optionId: 'a', misconception: textBody('why') }],
      alternateApproaches: [{ label: 'by energy', steps: [step(1)] }],
    });
    expect(Object.isFrozen(built.distractorAnalyses[0])).toBe(true);
    expect(Object.isFrozen(built.alternateApproaches[0])).toBe(true);
    expect(Object.isFrozen(built.alternateApproaches[0]?.steps)).toBe(true);
  });

  it('freezes the solution and leaves the original untouched on change', () => {
    const original = draft();
    expect(Object.isFrozen(original)).toBe(true);
    expectValue(addSolutionVersion(original, V2));
    expectValue(transitionSolution(original, { transition: 'submit_for_review' }));
    expect(original.versions).toHaveLength(1);
    expect(original.lifecycleState).toBe('draft');
  });
});
