import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT, textBody } from '../../../testing/content-fixtures.js';
import { LIFECYCLE_STATES, type LifecycleState } from './item-lifecycle.js';
import {
  addStimulusVersion,
  createStimulus,
  createStimulusVersion,
  latestStimulusVersionOf,
  publishedStimulusVersionOf,
  reconstituteStimulus,
  STIMULUS_TYPES,
  transitionStimulus,
  type CreateStimulusVersionProps,
  type Stimulus,
  type StimulusVersion,
} from './stimulus.js';

function versionProps(overrides: Partial<CreateStimulusVersionProps> = {}): CreateStimulusVersionProps {
  return {
    versionId: 'stimulus-version-1',
    versionNo: 1,
    body: textBody('A 200 kg trolley rolls along a level track without friction.'),
    licensing: { status: 'owned' },
    authoredBy: AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}

function version(overrides: Partial<CreateStimulusVersionProps> = {}): StimulusVersion {
  return expectValue(createStimulusVersion(versionProps(overrides)));
}

const V1 = version();
const V2 = version({ versionId: 'stimulus-version-2', versionNo: 2, body: textBody('A corrected passage.') });

function draft(): Stimulus {
  return expectValue(createStimulus({ stimulusId: 'stimulus-1', stimulusType: 'passage', initialVersion: V1 }));
}

function inState(state: LifecycleState, versions: readonly StimulusVersion[] = [V1]): Stimulus {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteStimulus({
      stimulusId: 'stimulus-1',
      stimulusType: 'passage',
      lifecycleState: state,
      versions,
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: V1.versionId } : {}),
    }),
  );
}

describe('a stimulus version', () => {
  it('constructs with a body, licensing and an author', () => {
    expect(version()).toMatchObject({ versionId: 'stimulus-version-1', versionNo: 1 });
  });

  it('defaults licensing to unresolved, as an item version does', () => {
    const props = versionProps();
    delete (props as { licensing?: unknown }).licensing;
    expect(expectValue(createStimulusVersion(props)).licensing).toEqual({ status: 'unresolved' });
  });

  it('rejects a blank version id', () => {
    expect(expectError(createStimulusVersion(versionProps({ versionId: ' ' }))).code).toBe(
      'VERSION_ID_REQUIRED',
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -2],
    ['fractional', 1.5],
  ])('rejects a versionNo that is %s', (_label, versionNo) => {
    expect(expectError(createStimulusVersion(versionProps({ versionNo }))).code).toBe('VERSION_NO_INVALID');
  });

  it('requires an author (INV-02)', () => {
    expect(
      expectError(createStimulusVersion(versionProps({ authoredBy: { ...AUTHOR, id: '' } }))).code,
    ).toBe('AUTHORED_BY_REQUIRED');
  });

  it('rejects a malformed timestamp', () => {
    expect(expectError(createStimulusVersion(versionProps({ createdAt: 'today' }))).code).toBe(
      'CREATED_AT_NOT_A_TIMESTAMP',
    );
  });

  it('propagates a licensing failure', () => {
    expect(
      expectError(createStimulusVersion(versionProps({ licensing: { status: 'licensed' } }))).code,
    ).toBe('LICENSE_REF_REQUIRED');
  });

  it('is frozen, including the author role context', () => {
    const built = version();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.authoredBy.roleContext)).toBe(true);
  });
});

describe('creation', () => {
  it('starts as a draft holding one version', () => {
    expect(draft()).toMatchObject({ lifecycleState: 'draft', aggregateVersion: 1 });
  });

  it('accepts every stimulus type', () => {
    for (const stimulusType of STIMULUS_TYPES) {
      expect(
        expectValue(createStimulus({ stimulusId: 's', stimulusType, initialVersion: V1 })).stimulusType,
      ).toBe(stimulusType);
    }
  });

  it('rejects an unknown stimulus type', () => {
    expect(
      expectError(
        createStimulus({ stimulusId: 's', stimulusType: 'video' as never, initialVersion: V1 }),
      ).code,
    ).toBe('STIMULUS_TYPE_UNKNOWN');
  });

  it('rejects a blank stimulus id', () => {
    expect(
      expectError(createStimulus({ stimulusId: '  ', stimulusType: 'passage', initialVersion: V1 })).code,
    ).toBe('STIMULUS_ID_REQUIRED');
  });

  it('rejects a first version that is not version 1', () => {
    expect(
      expectError(createStimulus({ stimulusId: 's', stimulusType: 'passage', initialVersion: V2 })).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });
});

describe('reconstitution', () => {
  it('restores a stimulus in any state', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(inState(state).lifecycleState).toBe(state);
    }
  });

  it('rejects a blank id', () => {
    expect(
      expectError(
        reconstituteStimulus({
          stimulusId: '',
          stimulusType: 'passage',
          lifecycleState: 'draft',
          versions: [V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('STIMULUS_ID_REQUIRED');
  });

  it('rejects an empty version list', () => {
    expect(
      expectError(
        reconstituteStimulus({
          stimulusId: 's',
          stimulusType: 'passage',
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
        reconstituteStimulus({
          stimulusId: 's',
          stimulusType: 'passage',
          lifecycleState: 'draft',
          versions: [V1, V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_ID_DUPLICATE');
  });

  it('rejects a gap in the version numbers', () => {
    const third = version({ versionId: 'stimulus-version-3', versionNo: 3 });
    expect(
      expectError(
        reconstituteStimulus({
          stimulusId: 's',
          stimulusType: 'passage',
          lifecycleState: 'draft',
          versions: [V1, third],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('rejects a published reference the stimulus does not hold', () => {
    expect(
      expectError(
        reconstituteStimulus({
          stimulusId: 's',
          stimulusType: 'passage',
          lifecycleState: 'published',
          versions: [V1],
          currentPublishedVersionId: 'elsewhere',
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('PUBLISHED_VERSION_UNKNOWN');
  });

  it.each([['published'], ['suspended']] as const)(
    'rejects a %s stimulus naming no published version',
    (lifecycleState) => {
      expect(
        expectError(
          reconstituteStimulus({
            stimulusId: 's',
            stimulusType: 'passage',
            lifecycleState,
            versions: [V1],
            aggregateVersion: 1,
          }),
        ).code,
      ).toBe('PUBLISHED_VERSION_REQUIRED');
    },
  );

  it('carries a retirement reason forward', () => {
    const retired = expectValue(
      reconstituteStimulus({
        stimulusId: 's',
        stimulusType: 'passage',
        lifecycleState: 'retired',
        versions: [V1],
        retirementReason: 'source licence lapsed',
        aggregateVersion: 4,
      }),
    );
    expect(retired.retirementReason).toBe('source licence lapsed');
  });

  it('omits absent optional keys', () => {
    const stimulus = inState('draft');
    expect(Object.hasOwn(stimulus, 'currentPublishedVersionId')).toBe(false);
    expect(Object.hasOwn(stimulus, 'retirementReason')).toBe(false);
  });
});

describe('editing a published stimulus creates a new version (FR-TCH-03 rule 2)', () => {
  it('appends a version and bumps the aggregate version', () => {
    const updated = expectValue(addStimulusVersion(draft(), V2));
    expect(updated.versions).toHaveLength(2);
    expect(updated.aggregateVersion).toBe(2);
  });

  // Unlike an item: editing a published passage is ordinary, and refusing it
  // would push authors back to pasting the passage per item — the error the
  // aggregate exists to prevent.
  it('permits a new version while published', () => {
    const published = inState('published');
    expect(expectValue(addStimulusVersion(published, V2)).versions).toHaveLength(2);
  });

  it('permits a new version while in review or suspended', () => {
    for (const state of ['in_review', 'suspended'] as const) {
      expect(expectValue(addStimulusVersion(inState(state), V2)).versions).toHaveLength(2);
    }
  });

  it('refuses a new version on a retired stimulus', () => {
    expect(expectError(addStimulusVersion(inState('retired'), V2)).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('refuses a duplicate version id as a Conflict', () => {
    const failure = expectError(addStimulusVersion(draft(), V1));
    expect(failure.code).toBe('VERSION_ID_DUPLICATE');
    expect(failure.kind).toBe('Conflict');
  });

  it('refuses a version number that skips ahead', () => {
    const third = version({ versionId: 'stimulus-version-3', versionNo: 3 });
    expect(expectError(addStimulusVersion(draft(), third)).code).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  // The whole reason the aggregate exists: an item sat by a candidate must
  // still ask what it asked.
  it('leaves the previously published version in place, so existing associations still resolve', () => {
    const published = inState('published');
    const updated = expectValue(addStimulusVersion(published, V2));
    expect(updated.currentPublishedVersionId).toBe(V1.versionId);
    expect(publishedStimulusVersionOf(updated)?.versionId).toBe(V1.versionId);
    expect(updated.versions.map((entry) => entry.versionId)).toContain(V1.versionId);
  });

  it('does not move an association until the new version is published deliberately', () => {
    const published = inState('published');
    const withSecond = expectValue(addStimulusVersion(published, V2));
    const republished = expectValue(
      transitionStimulus(
        expectValue(
          reconstituteStimulus({
            stimulusId: withSecond.stimulusId,
            stimulusType: withSecond.stimulusType,
            lifecycleState: 'approved',
            versions: withSecond.versions,
            currentPublishedVersionId: V1.versionId,
            aggregateVersion: withSecond.aggregateVersion,
          }),
        ),
        { transition: 'publish', versionId: V2.versionId },
      ),
    );
    expect(republished.currentPublishedVersionId).toBe(V2.versionId);
    expect(republished.versions).toHaveLength(2);
  });

  it('reports the latest version when held in order', () => {
    expect(latestStimulusVersionOf(expectValue(addStimulusVersion(draft(), V2))).versionNo).toBe(2);
  });

  it('reports the latest version even when held out of order', () => {
    const outOfOrder = expectValue(
      reconstituteStimulus({
        stimulusId: 's',
        stimulusType: 'passage',
        lifecycleState: 'draft',
        versions: [V2, V1],
        aggregateVersion: 2,
      }),
    );
    expect(latestStimulusVersionOf(outOfOrder).versionNo).toBe(2);
  });

  it('reports no published version before publication', () => {
    expect(publishedStimulusVersionOf(draft())).toBeUndefined();
  });
});

describe('transitions', () => {
  it('uses the item lifecycle unchanged', () => {
    expect(expectValue(transitionStimulus(draft(), { transition: 'submit_for_review' })).lifecycleState).toBe(
      'in_review',
    );
  });

  it('refuses an illegal transition', () => {
    expect(expectError(transitionStimulus(draft(), { transition: 'approve' })).code).toBe(
      'TRANSITION_ILLEGAL',
    );
  });

  it('publishes a named version', () => {
    const published = expectValue(
      transitionStimulus(inState('approved'), { transition: 'publish', versionId: V1.versionId }),
    );
    expect(published.lifecycleState).toBe('published');
    expect(published.currentPublishedVersionId).toBe(V1.versionId);
  });

  it('refuses publication naming no version', () => {
    expect(expectError(transitionStimulus(inState('approved'), { transition: 'publish' })).code).toBe(
      'VERSION_NOT_FOUND',
    );
  });

  it('refuses publication naming a version it does not hold', () => {
    expect(
      expectError(
        transitionStimulus(inState('approved'), { transition: 'publish', versionId: 'elsewhere' }),
      ).code,
    ).toBe('VERSION_NOT_FOUND');
  });
});

describe('retirement while referenced (FR-TCH-03 rule 3)', () => {
  it('retires when nothing published references it', () => {
    const retired = expectValue(
      transitionStimulus(inState('published'), {
        transition: 'retire',
        retirementReason: 'off syllabus',
        referencingPublishedItemCount: 0,
      }),
    );
    expect(retired.lifecycleState).toBe('retired');
    expect(retired.retirementReason).toBe('off syllabus');
  });

  // Retiring a referenced stimulus leaves published items pointing at content
  // that is no longer supposed to circulate — and they would still render it,
  // because they pin a version.
  it('refuses while published items reference it, naming the count', () => {
    const failure = expectError(
      transitionStimulus(inState('published'), {
        transition: 'retire',
        retirementReason: 'off syllabus',
        referencingPublishedItemCount: 3,
      }),
    );
    expect(failure.code).toBe('STILL_REFERENCED');
    expect(failure.kind).toBe('RuleViolation');
    expect(failure.message).toContain('3');
  });

  // Not knowing is not the same as zero, and defaulting it to zero would make
  // the rule advisory.
  it('refuses when the reference count was not resolved at all', () => {
    expect(
      expectError(
        transitionStimulus(inState('published'), {
          transition: 'retire',
          retirementReason: 'off syllabus',
        }),
      ).code,
    ).toBe('STILL_REFERENCED');
  });

  it('requires a reason', () => {
    expect(
      expectError(
        transitionStimulus(inState('published'), {
          transition: 'retire',
          referencingPublishedItemCount: 0,
        }),
      ).code,
    ).toBe('RETIREMENT_REASON_REQUIRED');
  });

  it('rejects a blank reason', () => {
    expect(
      expectError(
        transitionStimulus(inState('published'), {
          transition: 'retire',
          retirementReason: '   ',
          referencingPublishedItemCount: 0,
        }),
      ).code,
    ).toBe('RETIREMENT_REASON_REQUIRED');
  });

  it('retires from suspended too', () => {
    expect(
      expectValue(
        transitionStimulus(inState('suspended'), {
          transition: 'retire',
          retirementReason: 'replaced',
          referencingPublishedItemCount: 0,
        }),
      ).lifecycleState,
    ).toBe('retired');
  });
});

describe('immutability', () => {
  it('freezes the stimulus and its version list', () => {
    const stimulus = draft();
    expect(Object.isFrozen(stimulus)).toBe(true);
    expect(Object.isFrozen(stimulus.versions)).toBe(true);
  });

  it('leaves the original untouched when a version is added', () => {
    const original = draft();
    expectValue(addStimulusVersion(original, V2));
    expect(original.versions).toHaveLength(1);
  });

  it('leaves the original untouched when transitioned', () => {
    const original = draft();
    expectValue(transitionStimulus(original, { transition: 'submit_for_review' }));
    expect(original.lifecycleState).toBe('draft');
  });
});
