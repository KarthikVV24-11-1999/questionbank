import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  AI_AGENT,
  AUTHOR,
  AUTHORED_AT,
  aiProvenance,
  itemVersionProps,
  mathBody,
  numericSpec,
  PROVENANCE_CONTEXT,
  singleCorrectSpec,
  tags,
  textBody,
} from '../../../testing/content-fixtures.js';
import { filesMatching } from '../../../fitness/source-scan.js';
import { fileURLToPath } from 'node:url';
import {
  createItemVersion,
  deriveDraft,
  DIFFICULTY_BANDS,
  pinStimulusVersion,
  stimulusVersionOf,
  type ItemVersion,
} from './item-version.js';

const DOMAIN_DIR = fileURLToPath(new URL('.', import.meta.url));

function build(overrides: Parameters<typeof itemVersionProps>[0] = {}): ItemVersion {
  return expectValue(createItemVersion(itemVersionProps(overrides), PROVENANCE_CONTEXT));
}

describe('construction', () => {
  it('builds a complete version', () => {
    const version = build();
    expect(version).toMatchObject({
      versionId: 'version-1',
      versionNo: 1,
      itemType: 'SINGLE_CORRECT_MCQ',
      difficultyEstimate: 'moderate',
      createdAt: AUTHORED_AT,
    });
  });

  it('carries a stem that can hold notation', () => {
    const version = build({ stem: mathBody('a = \\frac{F}{m}', 'a equals F over m') });
    expect(version.stem.blocks[0]).toMatchObject({ kind: 'MATH_BLOCK' });
  });

  it('builds a numeric item', () => {
    const version = build({ itemType: 'NUMERIC', responseSpec: numericSpec() });
    expect(version.responseSpec.itemType).toBe('NUMERIC');
  });

  it.each([['versionId', { versionId: '  ' }, 'VERSION_ID_REQUIRED']] as const)(
    'rejects a blank %s',
    (_field, overrides, code) => {
      expect(expectError(createItemVersion(itemVersionProps(overrides), PROVENANCE_CONTEXT)).code).toBe(code);
    },
  );

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a versionNo that is %s', (_label, versionNo) => {
    expect(expectError(createItemVersion(itemVersionProps({ versionNo }), PROVENANCE_CONTEXT)).code).toBe(
      'VERSION_NO_INVALID',
    );
  });

  // The same fact recorded twice; letting them differ means the key is scored
  // under one type and presented under another.
  it('rejects a version whose item type disagrees with its specification', () => {
    const props = itemVersionProps({ itemType: 'NUMERIC', responseSpec: singleCorrectSpec() });
    expect(expectError(createItemVersion(props, PROVENANCE_CONTEXT)).code).toBe('ITEM_TYPE_MISMATCH');
  });

  it('accepts every difficulty band', () => {
    for (const difficultyEstimate of DIFFICULTY_BANDS) {
      expect(build({ difficultyEstimate }).difficultyEstimate).toBe(difficultyEstimate);
    }
  });

  it('rejects an unknown difficulty band', () => {
    const props = itemVersionProps({ difficultyEstimate: 'impossible' as never });
    expect(expectError(createItemVersion(props, PROVENANCE_CONTEXT)).code).toBe('DIFFICULTY_BAND_UNKNOWN');
  });

  it('requires a principal to have authored it (INV-02)', () => {
    const props = itemVersionProps({ authoredBy: { ...AUTHOR, id: '  ' } });
    expect(expectError(createItemVersion(props, PROVENANCE_CONTEXT)).code).toBe('AUTHORED_BY_REQUIRED');
  });

  it('rejects an unknown principal kind', () => {
    const props = itemVersionProps({ authoredBy: { ...AUTHOR, kind: 'daemon' as never } });
    expect(expectError(createItemVersion(props, PROVENANCE_CONTEXT)).code).toBe('AUTHORED_BY_KIND_UNKNOWN');
  });

  // D10: humans and machines are attributed by the same mechanism.
  it('records a machine author the same way as a human one', () => {
    const version = build({ authoredBy: AI_AGENT, provenance: aiProvenance() });
    expect(version.authoredBy).toMatchObject({ kind: 'ai_agent', id: 'model-7' });
  });

  it.each([
    ['a bare date', '2026-08-09'],
    ['a local time', '2026-08-09T10:00:00'],
    ['prose', 'this morning'],
  ])('rejects a createdAt that is %s', (_label, createdAt) => {
    expect(expectError(createItemVersion(itemVersionProps({ createdAt }), PROVENANCE_CONTEXT)).code).toBe(
      'CREATED_AT_NOT_A_TIMESTAMP',
    );
  });

  it('propagates a response-specification failure with its location', () => {
    const props = itemVersionProps({ responseSpec: singleCorrectSpec({ correctOptionId: 'z' }) });
    const failure = expectError(createItemVersion(props, PROVENANCE_CONTEXT));
    expect(failure.code).toBe('CORRECT_OPTION_UNKNOWN');
    expect(failure.location).toBe('version.responseSpec');
  });

  it('propagates a tag failure with its location', () => {
    const props = itemVersionProps({ taxonomyTags: [] });
    const failure = expectError(createItemVersion(props, PROVENANCE_CONTEXT));
    expect(failure.code).toBe('TAGS_REQUIRED');
    expect(failure.location).toBe('version.taxonomyTags');
  });

  it('propagates a provenance failure with its location', () => {
    const props = itemVersionProps({ provenance: { sourceType: 'licensed' } });
    const failure = expectError(createItemVersion(props, PROVENANCE_CONTEXT));
    expect(failure.code).toBe('ATTRIBUTION_AUTHOR_REQUIRED');
    expect(failure.location).toBe('version.provenance');
  });

  it('propagates a licensing failure with its location', () => {
    const props = itemVersionProps({ licensing: { status: 'licensed' } });
    const failure = expectError(createItemVersion(props, PROVENANCE_CONTEXT));
    expect(failure.code).toBe('LICENSE_REF_REQUIRED');
    expect(failure.location).toBe('version.licensing');
  });
});

describe('licensing defaults to unresolved', () => {
  // The permissive statement has to be made deliberately (FR-QM-05 rule 4).
  it('leaves a version with no stated licensing unpublishable', () => {
    const props = itemVersionProps();
    const withoutLicensing: typeof props = { ...props };
    delete (withoutLicensing as { licensing?: unknown }).licensing;
    expect(expectValue(createItemVersion(withoutLicensing, PROVENANCE_CONTEXT)).licensing).toEqual({
      status: 'unresolved',
    });
  });
});

describe('stimulus association pins a version, not a stimulus', () => {
  // FR-TCH-03 rule 2. A shared passage edited under an item would silently
  // change what that item asked, including for attempts already sat.
  it('records the stimulus version it was authored against', () => {
    expect(stimulusVersionOf(build({ stimulusVersionRef: 'stimulus-version-3' }))).toBe('stimulus-version-3');
  });

  it('records nothing when the item stands alone', () => {
    expect(stimulusVersionOf(build())).toBeUndefined();
  });

  it('omits the key entirely rather than storing undefined', () => {
    expect(Object.hasOwn(build(), 'stimulusVersionRef')).toBe(false);
  });

  it('rejects a blank reference, which is neither an association nor its absence', () => {
    const props = itemVersionProps({ stimulusVersionRef: '   ' });
    expect(expectError(createItemVersion(props, PROVENANCE_CONTEXT)).code).toBe(
      'STIMULUS_VERSION_REF_BLANK',
    );
  });
});

describe('there is no mutator — an edit derives a successor', () => {
  const NEXT = { versionId: 'version-2', authoredBy: AUTHOR, createdAt: '2026-08-10T09:00:00Z' };

  it('increments the version number', () => {
    expect(expectValue(deriveDraft(build(), NEXT)).versionNo).toBe(2);
  });

  it('returns a new object and leaves the original untouched (INV-03)', () => {
    const original = build();
    const derived = expectValue(deriveDraft(original, NEXT));
    expect(derived).not.toBe(original);
    expect(original.versionNo).toBe(1);
    expect(original.versionId).toBe('version-1');
    expect(original.createdAt).toBe(AUTHORED_AT);
  });

  // An edit that silently dropped these would produce a version failing
  // publication for reasons the author never touched.
  it('carries forward stem, specification, tags, provenance and licensing', () => {
    const original = build({ stimulusVersionRef: 'stimulus-version-3' });
    const derived = expectValue(deriveDraft(original, NEXT));
    expect(derived.stem).toEqual(original.stem);
    expect(derived.responseSpec).toEqual(original.responseSpec);
    expect(derived.taxonomyTags).toEqual(original.taxonomyTags);
    expect(derived.provenance).toEqual(original.provenance);
    expect(derived.licensing).toEqual(original.licensing);
    expect(derived.stimulusVersionRef).toBe('stimulus-version-3');
  });

  // The audit trail follows the change, not the lineage.
  it('records the principal making this edit, not the original author', () => {
    const original = build();
    const derived = expectValue(
      deriveDraft(original, { ...NEXT, authoredBy: { ...AUTHOR, id: 'author-2' } }),
    );
    expect(derived.authoredBy.id).toBe('author-2');
    expect(original.authoredBy.id).toBe('author-1');
  });

  it('chains, so version 3 follows version 2', () => {
    const second = expectValue(deriveDraft(build(), NEXT));
    const third = expectValue(
      deriveDraft(second, { versionId: 'version-3', authoredBy: AUTHOR, createdAt: '2026-08-11T09:00:00Z' }),
    );
    expect(third.versionNo).toBe(3);
  });

  it('rejects a derived version with no id of its own', () => {
    expect(expectError(deriveDraft(build(), { ...NEXT, versionId: '' })).code).toBe('VERSION_ID_REQUIRED');
  });

  it('rejects a derived version with no author', () => {
    expect(
      expectError(deriveDraft(build(), { ...NEXT, authoredBy: { ...AUTHOR, id: '' } })).code,
    ).toBe('AUTHORED_BY_REQUIRED');
  });

  it('rejects a derived version with an unknown principal kind', () => {
    expect(
      expectError(deriveDraft(build(), { ...NEXT, authoredBy: { ...AUTHOR, kind: 'daemon' as never } })).code,
    ).toBe('AUTHORED_BY_KIND_UNKNOWN');
  });

  it('rejects a derived version with a malformed timestamp', () => {
    expect(expectError(deriveDraft(build(), { ...NEXT, createdAt: 'tomorrow' })).code).toBe(
      'CREATED_AT_NOT_A_TIMESTAMP',
    );
  });

  it('declares no setter or mutating method on the type', () => {
    const version = build() as unknown as Record<string, unknown>;
    const mutators = Object.keys(version).filter((key) => typeof version[key] === 'function');
    expect(mutators).toEqual([]);
  });
});

describe('immutability', () => {
  it('freezes the version', () => {
    expect(Object.isFrozen(build())).toBe(true);
  });

  it('freezes the author reference and its role context', () => {
    const version = build();
    expect(Object.isFrozen(version.authoredBy)).toBe(true);
    expect(Object.isFrozen(version.authoredBy.roleContext)).toBe(true);
  });

  it('freezes tags, provenance, licensing and the specification', () => {
    const version = build();
    expect(Object.isFrozen(version.taxonomyTags)).toBe(true);
    expect(Object.isFrozen(version.taxonomyTags[0])).toBe(true);
    expect(Object.isFrozen(version.provenance)).toBe(true);
    expect(Object.isFrozen(version.licensing)).toBe(true);
    expect(Object.isFrozen(version.responseSpec)).toBe(true);
  });

  it('does not alias the caller’s role context array', () => {
    const roleContext = ['author'];
    const version = build({ authoredBy: { kind: 'human', id: 'author-1', roleContext } });
    roleContext.push('admin');
    expect(version.authoredBy.roleContext).toEqual(['author']);
  });

  it('freezes the derived version too', () => {
    const derived = expectValue(
      deriveDraft(build(), { versionId: 'version-2', authoredBy: AUTHOR, createdAt: '2026-08-10T09:00:00Z' }),
    );
    expect(Object.isFrozen(derived)).toBe(true);
    expect(Object.isFrozen(derived.authoredBy)).toBe(true);
  });
});

describe('the domain reads no clock', () => {
  // Same discipline as F45. A version whose identity depends on when the
  // process ran is not reproducible, and the repository round-trip would be
  // asserting against a moving target.
  it('takes createdAt from the caller everywhere under domain/', () => {
    expect(filesMatching(DOMAIN_DIR, /\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/u)).toEqual([]);
  });

  it('builds two versions with the same supplied instant', () => {
    expect(build().createdAt).toBe(build().createdAt);
  });
});

describe('localeVariants is modeled at M3-16, not half-shipped here', () => {
  // A field nothing populates is a field that acquires a wrong default.
  it('declares no locale field yet', () => {
    expect(Object.hasOwn(build(), 'localeVariants')).toBe(false);
  });

  it('still carries a stem that a translation could target', () => {
    expect(build({ stem: textBody('a translatable stem') }).stem.blocks).toHaveLength(1);
  });
});

describe('pinning a stimulus version (FR-TCH-03 rule 2)', () => {
  it('records the version the association was made against', () => {
    const pinned = expectValue(pinStimulusVersion(build(), 'stimulus-version-1'));
    expect(pinned.stimulusVersionRef).toBe('stimulus-version-1');
  });

  it('returns a new object and leaves the original unpinned', () => {
    const original = build();
    const pinned = expectValue(pinStimulusVersion(original, 'stimulus-version-1'));
    expect(original.stimulusVersionRef).toBeUndefined();
    expect(pinned).not.toBe(original);
  });

  it('re-points an existing association only when asked', () => {
    const first = expectValue(pinStimulusVersion(build(), 'stimulus-version-1'));
    expect(expectValue(pinStimulusVersion(first, 'stimulus-version-2')).stimulusVersionRef).toBe(
      'stimulus-version-2',
    );
  });

  it('refuses a blank reference rather than storing an association to nothing', () => {
    const failure = expectError(pinStimulusVersion(build(), '   '));
    expect(failure.code).toBe('STIMULUS_VERSION_REF_BLANK');
    expect(failure.location).toBe('version.stimulusVersionRef');
  });
});
