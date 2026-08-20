import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  AUTHOR,
  itemVersionProps,
  numericSpec,
  PROVENANCE_CONTEXT,
} from '../../../testing/content-fixtures.js';
import { createItemVersion, deriveDraft, type ItemVersion } from './item-version.js';
import { LIFECYCLE_STATES, type LifecycleState } from './item-lifecycle.js';
import {
  addVersion,
  checkDeletable,
  createItem,
  isEditable,
  latestVersionOf,
  publishedVersionOf,
  publishVersion,
  reconstituteItem,
  replaceDraftVersion,
  transitionItem,
  type Item,
} from './item.js';

function version(overrides: Parameters<typeof itemVersionProps>[0] = {}): ItemVersion {
  return expectValue(createItemVersion(itemVersionProps(overrides), PROVENANCE_CONTEXT));
}

const V1 = version();
const V2 = expectValue(deriveDraft(V1, { versionId: 'version-2', authoredBy: AUTHOR, createdAt: '2026-08-10T09:00:00Z' }));

function draft(): Item {
  return expectValue(createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: V1 }));
}

/** An item parked in a given state, for the transition tests. */
function inState(state: LifecycleState, overrides: Partial<Parameters<typeof reconstituteItem>[0]> = {}): Item {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteItem({
      itemId: 'item-1',
      itemType: 'SINGLE_CORRECT_MCQ',
      lifecycleState: state,
      versions: [V1],
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: V1.versionId } : {}),
      ...overrides,
    }),
  );
}

describe('creation', () => {
  it('starts as a draft holding one version', () => {
    const item = draft();
    expect(item).toMatchObject({ itemId: 'item-1', lifecycleState: 'draft', aggregateVersion: 1 });
    expect(item.versions).toHaveLength(1);
  });

  it('publishes nothing yet', () => {
    expect(publishedVersionOf(draft())).toBeUndefined();
  });

  it('rejects a blank item id', () => {
    expect(
      expectError(createItem({ itemId: ' ', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: V1 })).code,
    ).toBe('ITEM_ID_REQUIRED');
  });

  it('rejects a blank item type', () => {
    expect(
      expectError(createItem({ itemId: 'item-1', itemType: '' as never, initialVersion: V1 })).code,
    ).toBe('ITEM_TYPE_REQUIRED');
  });

  // Changing it would invalidate the specification and re-interpret every
  // attempt already scored under it.
  it('rejects a first version typed differently from the item', () => {
    const numeric = version({ itemType: 'NUMERIC', responseSpec: numericSpec() });
    expect(
      expectError(createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: numeric })).code,
    ).toBe('VERSION_TYPE_MISMATCH');
  });

  it('rejects a first version that is not version 1', () => {
    expect(
      expectError(createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: V2 })).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('is frozen', () => {
    const item = draft();
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.versions)).toBe(true);
  });
});

describe('reconstitution', () => {
  it('restores an item in any state', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(inState(state).lifecycleState).toBe(state);
    }
  });

  it('rejects a blank item id', () => {
    expect(
      expectError(
        reconstituteItem({
          itemId: '',
          itemType: 'SINGLE_CORRECT_MCQ',
          lifecycleState: 'draft',
          versions: [V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('ITEM_ID_REQUIRED');
  });

  it('rejects an item holding no versions', () => {
    expect(
      expectError(
        reconstituteItem({
          itemId: 'item-1',
          itemType: 'SINGLE_CORRECT_MCQ',
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
        reconstituteItem({
          itemId: 'item-1',
          itemType: 'SINGLE_CORRECT_MCQ',
          lifecycleState: 'draft',
          versions: [V1, V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_ID_DUPLICATE');
  });

  it('rejects a version typed differently from the item', () => {
    const numeric = version({ versionId: 'version-9', itemType: 'NUMERIC', responseSpec: numericSpec() });
    expect(
      expectError(
        reconstituteItem({
          itemId: 'item-1',
          itemType: 'SINGLE_CORRECT_MCQ',
          lifecycleState: 'draft',
          versions: [V1, numeric],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_TYPE_MISMATCH');
  });

  it('rejects a gap in the version numbers', () => {
    const third = version({ versionId: 'version-3', versionNo: 3 });
    expect(
      expectError(
        reconstituteItem({
          itemId: 'item-1',
          itemType: 'SINGLE_CORRECT_MCQ',
          lifecycleState: 'draft',
          versions: [V1, third],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('rejects a published version reference the item does not hold', () => {
    expect(
      expectError(
        reconstituteItem({
          itemId: 'item-1',
          itemType: 'SINGLE_CORRECT_MCQ',
          lifecycleState: 'published',
          versions: [V1],
          currentPublishedVersionId: 'version-elsewhere',
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('PUBLISHED_VERSION_UNKNOWN');
  });

  // A record no query can answer correctly.
  it.each([['published'], ['suspended']] as const)(
    'rejects a %s item that names no published version',
    (lifecycleState) => {
      expect(
        expectError(
          reconstituteItem({
            itemId: 'item-1',
            itemType: 'SINGLE_CORRECT_MCQ',
            lifecycleState,
            versions: [V1],
            aggregateVersion: 1,
          }),
        ).code,
      ).toBe('PUBLISHED_VERSION_REQUIRED');
    },
  );

  it('carries retirement reason and replacement forward', () => {
    const retired = inState('retired', {
      retirementReason: 'superseded by a clearer phrasing',
      replacedByItemId: 'item-2',
    });
    expect(retired).toMatchObject({
      retirementReason: 'superseded by a clearer phrasing',
      replacedByItemId: 'item-2',
    });
  });

  it('omits absent optional keys rather than storing undefined', () => {
    const item = inState('draft');
    expect(Object.hasOwn(item, 'currentPublishedVersionId')).toBe(false);
    expect(Object.hasOwn(item, 'retirementReason')).toBe(false);
    expect(Object.hasOwn(item, 'replacedByItemId')).toBe(false);
  });
});

describe('adding a version', () => {
  it('appends and bumps the aggregate version', () => {
    const item = expectValue(addVersion(draft(), V2));
    expect(item.versions).toHaveLength(2);
    expect(item.aggregateVersion).toBe(2);
  });

  it('leaves the original item untouched', () => {
    const original = draft();
    expectValue(addVersion(original, V2));
    expect(original.versions).toHaveLength(1);
    expect(original.aggregateVersion).toBe(1);
  });

  it.each([['draft'], ['changes_requested'], ['rejected']] as const)(
    'accepts a new version while %s',
    (state) => {
      expect(expectValue(addVersion(inState(state), V2)).versions).toHaveLength(2);
    },
  );

  // FR-TCH-08 rule 1: submission locks the draft, so the reviewer is not
  // looking at something that changes underneath them.
  it.each([['in_review'], ['approved'], ['published'], ['suspended'], ['retired']] as const)(
    'refuses a new version while %s',
    (state) => {
      expect(expectError(addVersion(inState(state), V2)).code).toBe('VERSION_NOT_EDITABLE');
    },
  );

  it('refuses a version typed differently from the item', () => {
    const numeric = version({ versionId: 'version-2', versionNo: 2, itemType: 'NUMERIC', responseSpec: numericSpec() });
    expect(expectError(addVersion(draft(), numeric)).code).toBe('VERSION_TYPE_MISMATCH');
  });

  it('refuses a duplicate version id as a Conflict', () => {
    const failure = expectError(addVersion(draft(), V1));
    expect(failure.code).toBe('VERSION_ID_DUPLICATE');
    expect(failure.kind).toBe('Conflict');
  });

  it('refuses a version number that skips ahead', () => {
    const third = version({ versionId: 'version-3', versionNo: 3 });
    expect(expectError(addVersion(draft(), third)).code).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('reports the latest version, published or not', () => {
    expect(latestVersionOf(expectValue(addVersion(draft(), V2))).versionNo).toBe(2);
  });

  // Storage order is not version order unless a repository imposes it, and
  // "which version does the editor open" must not depend on that.
  it('reports the latest version even when they are held out of order', () => {
    const outOfOrder = expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'draft',
        versions: [V2, V1],
        aggregateVersion: 2,
      }),
    );
    expect(latestVersionOf(outOfOrder).versionNo).toBe(2);
  });
});

describe('transitions', () => {
  it('moves through the machine', () => {
    const submitted = expectValue(transitionItem(draft(), { transition: 'submit_for_review' }));
    expect(submitted.lifecycleState).toBe('in_review');
    expect(submitted.aggregateVersion).toBe(2);
  });

  it('leaves the original untouched', () => {
    const original = draft();
    expectValue(transitionItem(original, { transition: 'submit_for_review' }));
    expect(original.lifecycleState).toBe('draft');
  });

  it('refuses an illegal transition', () => {
    expect(expectError(transitionItem(draft(), { transition: 'approve' })).code).toBe('TRANSITION_ILLEGAL');
  });

  // Publication has preconditions, so it cannot be reached through the generic
  // path — otherwise INV-07 would be one forgotten argument away from bypassed.
  it('refuses to publish through the generic transition path', () => {
    const failure = expectError(transitionItem(inState('approved'), { transition: 'publish' }));
    expect(failure.code).toBe('PUBLICATION_NOT_PERMITTED');
    expect(failure.message).toContain('publishVersion');
  });

  it('requires a reason to retire (FR-QM-07 rule 3)', () => {
    expect(expectError(transitionItem(inState('published'), { transition: 'retire' })).code).toBe(
      'RETIREMENT_REASON_REQUIRED',
    );
  });

  it('rejects a blank retirement reason', () => {
    expect(
      expectError(transitionItem(inState('published'), { transition: 'retire', retirementReason: '  ' })).code,
    ).toBe('RETIREMENT_REASON_REQUIRED');
  });

  it('records the reason and the replacement', () => {
    const retired = expectValue(
      transitionItem(inState('published'), {
        transition: 'retire',
        retirementReason: 'wrong key confirmed',
        replacedByItemId: 'item-2',
      }),
    );
    expect(retired).toMatchObject({
      lifecycleState: 'retired',
      retirementReason: 'wrong key confirmed',
      replacedByItemId: 'item-2',
    });
  });

  it('refuses an item that replaces itself', () => {
    expect(
      expectError(
        transitionItem(inState('published'), {
          transition: 'retire',
          retirementReason: 'superseded',
          replacedByItemId: 'item-1',
        }),
      ).code,
    ).toBe('REPLACEMENT_IS_SELF');
  });

  it('retires without a replacement', () => {
    const retired = expectValue(
      transitionItem(inState('published'), { transition: 'retire', retirementReason: 'off syllabus' }),
    );
    expect(Object.hasOwn(retired, 'replacedByItemId')).toBe(false);
  });

  it('suspends and reinstates, keeping the published version', () => {
    const suspended = expectValue(transitionItem(inState('published'), { transition: 'suspend' }));
    expect(suspended.currentPublishedVersionId).toBe(V1.versionId);
    const reinstated = expectValue(transitionItem(suspended, { transition: 'reinstate' }));
    expect(reinstated.lifecycleState).toBe('published');
  });
});

describe('publication', () => {
  function approved(versions: readonly ItemVersion[] = [V1]): Item {
    return expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'approved',
        versions,
        aggregateVersion: 1,
      }),
    );
  }

  it('publishes an approved version whose preconditions hold', () => {
    const published = expectValue(
      publishVersion(approved(), { versionId: V1.versionId, preconditionsSatisfied: true }),
    );
    expect(published.lifecycleState).toBe('published');
    expect(published.currentPublishedVersionId).toBe(V1.versionId);
    expect(publishedVersionOf(published)?.versionId).toBe(V1.versionId);
  });

  // INV-07. The aggregate does not evaluate the preconditions — it refuses to
  // publish without a satisfied verdict, which is much harder to bypass than a
  // check a caller can forget to run.
  it('refuses when the preconditions are not satisfied', () => {
    const failure = expectError(
      publishVersion(approved(), { versionId: V1.versionId, preconditionsSatisfied: false }),
    );
    expect(failure.code).toBe('PUBLICATION_NOT_PERMITTED');
    expect(failure.kind).toBe('RuleViolation');
  });

  it('refuses a version the item does not hold', () => {
    expect(
      expectError(publishVersion(approved(), { versionId: 'version-elsewhere', preconditionsSatisfied: true })).code,
    ).toBe('VERSION_NOT_FOUND');
  });

  it.each(LIFECYCLE_STATES.filter((state) => state !== 'approved'))(
    'refuses to publish from %s',
    (state) => {
      expect(
        expectError(publishVersion(inState(state), { versionId: V1.versionId, preconditionsSatisfied: true })).code,
      ).toBe('TRANSITION_ILLEGAL');
    },
  );

  // One operation, so there is never a window with two current versions and no
  // way to end up with none while intending to swap.
  it('supersedes the previously published version in a single step', () => {
    const published = expectValue(
      publishVersion(approved(), { versionId: V1.versionId, preconditionsSatisfied: true }),
    );
    const withSecond = expectValue(
      reconstituteItem({
        itemId: published.itemId,
        itemType: published.itemType,
        lifecycleState: 'approved',
        versions: [V1, V2],
        currentPublishedVersionId: V1.versionId,
        aggregateVersion: published.aggregateVersion,
      }),
    );
    const republished = expectValue(
      publishVersion(withSecond, { versionId: V2.versionId, preconditionsSatisfied: true }),
    );
    expect(republished.currentPublishedVersionId).toBe(V2.versionId);
    expect(republished.versions).toHaveLength(2);
    expect(publishedVersionOf(republished)?.versionNo).toBe(2);
  });

  it('keeps the superseded version retrievable', () => {
    const withSecond = expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'approved',
        versions: [V1, V2],
        currentPublishedVersionId: V1.versionId,
        aggregateVersion: 2,
      }),
    );
    const republished = expectValue(
      publishVersion(withSecond, { versionId: V2.versionId, preconditionsSatisfied: true }),
    );
    expect(republished.versions.map((entry) => entry.versionId)).toEqual(['version-1', 'version-2']);
  });
});

describe('deletion', () => {
  it('permits discarding a draft that was never published', () => {
    expect(expectValue(checkDeletable(draft()))).toBe(true);
  });

  it.each(LIFECYCLE_STATES.filter((state) => state !== 'draft'))(
    'refuses to delete an item that is %s',
    (state) => {
      const failure = expectError(checkDeletable(inState(state)));
      expect(failure.code).toBe('ITEM_NOT_DELETABLE');
      expect(failure.kind).toBe('RuleViolation');
    },
  );

  it('refuses to delete a draft that has been published before', () => {
    const republishable = expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'draft',
        versions: [V1],
        currentPublishedVersionId: V1.versionId,
        aggregateVersion: 3,
      }),
    );
    expect(expectError(checkDeletable(republishable)).code).toBe('ITEM_NOT_DELETABLE');
  });
});

describe('replacing a draft version in place', () => {
  const edited = version({ difficultyEstimate: 'advanced' });

  it('replaces the content without adding a version', () => {
    const updated = expectValue(replaceDraftVersion(draft(), edited));
    expect(updated.versions).toHaveLength(1);
    expect(updated.versions[0]!.difficultyEstimate).toBe('advanced');
    expect(updated.aggregateVersion).toBe(2);
  });

  it('leaves the original aggregate untouched', () => {
    const original = draft();
    expectValue(replaceDraftVersion(original, edited));
    expect(original.versions[0]!.difficultyEstimate).toBe('moderate');
    expect(original.aggregateVersion).toBe(1);
  });

  it('replaces only the named version', () => {
    const twoVersions = expectValue(addVersion(draft(), V2));
    const replacement = expectValue(
      createItemVersion(
        itemVersionProps({ versionId: 'version-2', versionNo: 2, difficultyEstimate: 'advanced' }),
        PROVENANCE_CONTEXT,
      ),
    );
    const updated = expectValue(replaceDraftVersion(twoVersions, replacement));
    expect(updated.versions[0]!.difficultyEstimate).toBe('moderate');
    expect(updated.versions[1]!.difficultyEstimate).toBe('advanced');
  });

  it.each(['in_review', 'approved', 'published', 'suspended', 'retired'] as const)(
    'refuses an edit while the item is %s',
    (state) => {
      const failure = expectError(replaceDraftVersion(inState(state), edited));
      expect(failure.kind).toBe('RuleViolation');
      expect(failure.code).toBe('VERSION_NOT_EDITABLE');
    },
  );

  it('refuses to edit the published version even on an item that is editable again', () => {
    const republishable = expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'changes_requested',
        versions: [V1],
        currentPublishedVersionId: V1.versionId,
        aggregateVersion: 3,
      }),
    );
    expect(expectError(replaceDraftVersion(republishable, edited)).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('refuses a version the item does not hold', () => {
    const failure = expectError(replaceDraftVersion(draft(), V2));
    expect(failure.kind).toBe('Validation');
    expect(failure.code).toBe('VERSION_NOT_FOUND');
  });

  it('refuses a replacement of a different item type', () => {
    const numeric = version({ itemType: 'NUMERIC', responseSpec: numericSpec() });
    // Same identity, different type — the case that would score a key under
    // one type while presenting it under another.
    const disguised = { ...numeric, versionId: V1.versionId } as ItemVersion;
    expect(expectError(replaceDraftVersion(draft(), disguised)).code).toBe('VERSION_TYPE_MISMATCH');
  });

  it('refuses a replacement claiming a different version number', () => {
    const renumbered = { ...edited, versionNo: 7 } as ItemVersion;
    expect(expectError(replaceDraftVersion(draft(), renumbered)).code).toBe(
      'VERSION_NUMBERS_NOT_CONTIGUOUS',
    );
  });
});

// M4-13's addition. stateEnteredAt is optional and supplied, never a clock
// read here — every test above this point never mentions it, and stays
// green unchanged, which is the proof this is additive.
describe('stateEnteredAt (M4-13)', () => {
  const AT = '2026-08-19T09:00:00Z';
  const LATER = '2026-08-19T10:00:00Z';

  it('is absent when createItem is not given one — M3’s own call shape', () => {
    expect(draft().stateEnteredAt).toBeUndefined();
  });

  it('is carried by createItem when supplied', () => {
    const item = expectValue(
      createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: V1, stateEnteredAt: AT }),
    );
    expect(item.stateEnteredAt).toBe(AT);
  });

  it('refuses a createItem stateEnteredAt that is not an ISO instant', () => {
    const failure = expectError(
      createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: V1, stateEnteredAt: 'whenever' }),
    );
    expect(failure.code).toBe('STATE_ENTERED_AT_NOT_A_TIMESTAMP');
  });

  it('is carried by reconstituteItem when supplied, and absent when not', () => {
    const withIt = inState('draft', { stateEnteredAt: AT });
    expect(withIt.stateEnteredAt).toBe(AT);
    expect(inState('draft').stateEnteredAt).toBeUndefined();
  });

  it('refuses a reconstituteItem stateEnteredAt that is not an ISO instant', () => {
    const failure = expectError(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'draft',
        versions: [V1],
        aggregateVersion: 1,
        stateEnteredAt: 'whenever',
      }),
    );
    expect(failure.code).toBe('STATE_ENTERED_AT_NOT_A_TIMESTAMP');
  });

  it('is set on a transition when supplied', () => {
    const submitted = expectValue(
      transitionItem(draft(), { transition: 'submit_for_review', stateEnteredAt: AT }),
    );
    expect(submitted.stateEnteredAt).toBe(AT);
  });

  it('stays absent on a transition when not supplied — no silent default', () => {
    const submitted = expectValue(transitionItem(draft(), { transition: 'submit_for_review' }));
    expect(submitted.stateEnteredAt).toBeUndefined();
  });

  it('refuses a transition stateEnteredAt that is not an ISO instant', () => {
    const failure = expectError(
      transitionItem(draft(), { transition: 'submit_for_review', stateEnteredAt: 'whenever' }),
    );
    expect(failure.code).toBe('STATE_ENTERED_AT_NOT_A_TIMESTAMP');
  });

  it('moves forward on each successive transition, when supplied each time', () => {
    const submitted = expectValue(
      transitionItem(draft(), { transition: 'submit_for_review', stateEnteredAt: AT }),
    );
    const approved = expectValue(
      transitionItem(submitted, { transition: 'approve', stateEnteredAt: LATER }),
    );
    expect(approved.stateEnteredAt).toBe(LATER);
  });

  it('is set on publication when supplied', () => {
    const approved = inState('approved');
    const published = expectValue(
      publishVersion(approved, { versionId: V1.versionId, preconditionsSatisfied: true, stateEnteredAt: AT }),
    );
    expect(published.stateEnteredAt).toBe(AT);
  });

  it('stays absent on publication when not supplied', () => {
    const approved = inState('approved');
    const published = expectValue(
      publishVersion(approved, { versionId: V1.versionId, preconditionsSatisfied: true }),
    );
    expect(published.stateEnteredAt).toBeUndefined();
  });

  it('refuses a publication stateEnteredAt that is not an ISO instant', () => {
    const approved = inState('approved');
    const failure = expectError(
      publishVersion(approved, { versionId: V1.versionId, preconditionsSatisfied: true, stateEnteredAt: 'whenever' }),
    );
    expect(failure.code).toBe('STATE_ENTERED_AT_NOT_A_TIMESTAMP');
  });
});

describe('editability', () => {
  it.each([
    ['draft', true],
    ['changes_requested', true],
    ['rejected', true],
    ['in_review', false],
    ['approved', false],
    ['published', false],
    ['suspended', false],
    ['retired', false],
  ] as const)('reports %s as editable=%s', (state, expected) => {
    expect(isEditable(state)).toBe(expected);
  });
});
