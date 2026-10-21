import { describe, expect, it } from 'vitest';
import { err, ok } from '../domain/result.js';
import { addAnchorPoolMember } from '../domain/anchor-pool.js';
import type { AnchorPoolRepository, ExposureLedger } from '../domain/repository-ports.js';
import { validationError } from '../domain/assessment-error.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import {
  ContentCorpus,
  type CatalogueEntry,
  type CatalogueHandler,
  type ContentContext,
  type DuplicatesHandler,
} from './content-corpus.js';

const CONTEXT: ContentContext = { principal: { kind: 'system', id: id(TAG.student, 9), roleContext: ['system'] }, correlationId: 'c' };
const v = (n: number) => id(TAG.itemVersion, n);

const entry = (n: number, overrides: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  itemId: id(TAG.item, n),
  itemVersionId: v(n),
  itemType: 'SINGLE_CORRECT_MCQ',
  difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)],
  ...overrides,
});

const failure = { ok: false as const, error: { kind: 'Unavailable', code: 'DOWN', message: 'secret detail' } };

class Pages implements CatalogueHandler {
  readonly seen: unknown[] = [];
  constructor(private readonly pages: readonly { entries: CatalogueEntry[]; nextCursor?: string }[] | 'fails') {}
  private index = 0;
  async handle(query: unknown) {
    this.seen.push(query);
    if (this.pages === 'fails') return failure;
    return { ok: true as const, value: this.pages[this.index++]! };
  }
}

type Groups = { exact?: number[]; skeleton?: number[]; trigram?: [number, number][] };
const duplicates = (byVersion: Record<string, Groups | 'unevaluated' | 'fails'>): DuplicatesHandler => ({
  async handle(query) {
    const spec = byVersion[query.itemVersionId] ?? {};
    if (spec === 'fails') return failure;
    if (spec === 'unevaluated') return { ok: true, value: { state: 'not_evaluated', exactMatches: [], skeletonMatches: [], trigramMatches: [] } };
    return {
      ok: true,
      value: {
        state: 'evaluated',
        exactMatches: (spec.exact ?? []).map((n) => ({ itemVersionId: v(n) })),
        skeletonMatches: (spec.skeleton ?? []).map((n) => ({ itemVersionId: v(n) })),
        trigramMatches: (spec.trigram ?? []).map(([n, similarity]) => ({ itemVersionId: v(n), similarity })),
      },
    };
  },
});

const anchors = (versions: [number, number][] | 'fails'): AnchorPoolRepository => ({
  async add() {
    throw new Error('not used');
  },
  async retire() {
    throw new Error('not used');
  },
  async listActive() {
    return versions === 'fails'
      ? err(validationError('PERSISTENCE_REJECTED', 'no'))
      : ok(versions.map(([n, cap]) => expectValue(addAnchorPoolMember({ itemVersionId: v(n), exposureCap: cap, addedAt: '2026-10-01T00:00:00.000Z' }))));
  },
});

const exposure = (counts: [number, number][] | 'fails'): ExposureLedger => ({
  async countsByItemVersion() {
    return counts === 'fails' ? err(validationError('PERSISTENCE_REJECTED', 'no')) : ok(new Map(counts.map(([n, c]) => [v(n), c])));
  },
  async entriesForForm() {
    throw new Error('not used');
  },
});

const corpus = (parts: Partial<ConstructorParameters<typeof ContentCorpus>[0]> & { catalogue: CatalogueHandler }) =>
  new ContentCorpus({ duplicates: duplicates({}), anchors: anchors([]), exposure: exposure([]), ...parts });

describe('gathering the corpus', () => {
  it('maps a catalogue entry to a candidate, field by field, marking pool members as anchors with their cap', async () => {
    const loaded = expectValue(
      await corpus({
        catalogue: new Pages([{ entries: [entry(1, { stimulusVersionId: id(TAG.stimulus, 1), difficultyBand: 'advanced' }), entry(2)] }]),
        anchors: anchors([[1, 7]]),
        exposure: exposure([[1, 3]]),
      }).load({}, CONTEXT),
    );
    const [first, second] = loaded.candidates;
    expect(first!.itemId).toBe(id(TAG.item, 1));
    expect(first!.itemVersionId).toBe(v(1));
    expect(first!.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(first!.difficultyBand).toBe('advanced');
    expect(first!.conceptIdentityIds).toEqual([id(0xc0, 1)]);
    expect(first!.stimulusVersionId).toBe(id(TAG.stimulus, 1));
    expect(first!.isPublished).toBe(true);
    expect(first!.isAnchor).toBe(true);
    expect(first!.anchorExposureCap).toBe(7);
    expect(second!.stimulusVersionId).toBeNull();
    expect(second!.isAnchor).toBe(false);
    expect(second!.anchorExposureCap).toBeNull();
    expect(loaded.exposure.get(v(1))).toBe(3);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it('reads every page of the catalogue, passing the cursor and the filters it was given', async () => {
    const pages = new Pages([{ entries: [entry(1)], nextCursor: 'c1' }, { entries: [entry(2)], nextCursor: 'c2' }, { entries: [entry(3)] }]);
    const loaded = expectValue(await corpus({ catalogue: pages }).load({ subject: 'physics', itemTypes: ['NUMERIC'] }, CONTEXT));
    expect(loaded.candidates.map((c) => c.itemVersionId)).toEqual([v(1), v(2), v(3)]);
    expect(pages.seen).toEqual([
      { subject: 'physics', itemTypes: ['NUMERIC'], limit: 200 },
      { subject: 'physics', itemTypes: ['NUMERIC'], cursor: 'c1', limit: 200 },
      { subject: 'physics', itemTypes: ['NUMERIC'], cursor: 'c2', limit: 200 },
    ]);
  });

  it('asks content for nothing it was not given: no filters means none are passed', async () => {
    const pages = new Pages([{ entries: [] }]);
    expectValue(await corpus({ catalogue: pages }).load({}, CONTEXT));
    expect(pages.seen).toEqual([{ limit: 200 }]);
  });
});

describe('near-duplicates are content\'s detection, with assembly choosing only which groups disqualify', () => {
  const load = async (groups: Groups, threshold?: number) =>
    expectValue(
      await corpus({
        catalogue: new Pages([{ entries: [entry(1), entry(2), entry(3), entry(4)] }]),
        duplicates: duplicates({ [v(1)]: groups }),
        ...(threshold === undefined ? {} : { trigramThreshold: threshold }),
      }).load({}, CONTEXT),
    );

  it('treats exact and skeleton matches as near-duplicates always', async () => {
    const loaded = await load({ exact: [2], skeleton: [3] });
    expect([...loaded.nearDuplicates.get(v(1))!].sort()).toEqual([v(2), v(3)]);
  });

  it('treats a merely-similar match as one only at or above the threshold (0.8 by default)', async () => {
    const loaded = await load({ trigram: [[2, 0.8], [3, 0.79], [4, 0.95]] });
    expect([...loaded.nearDuplicates.get(v(1))!].sort()).toEqual([v(2), v(4)]);
  });

  it('honours a threshold it was given', async () => {
    const loaded = await load({ trigram: [[2, 0.5], [3, 0.4]] }, 0.5);
    expect([...loaded.nearDuplicates.get(v(1))!]).toEqual([v(2)]);
  });

  it('counts a match with no similarity as not similar enough', async () => {
    const handler: DuplicatesHandler = {
      async handle() {
        return { ok: true, value: { state: 'evaluated', exactMatches: [], skeletonMatches: [], trigramMatches: [{ itemVersionId: v(2) }] } };
      },
    };
    const loaded = expectValue(await corpus({ catalogue: new Pages([{ entries: [entry(1)] }]), duplicates: handler }).load({}, CONTEXT));
    expect([...loaded.nearDuplicates.get(v(1))!]).toEqual([]);
  });

  it('leaves out a version content has not evaluated, and says so, rather than certifying it duplicate-free (D55)', async () => {
    const loaded = expectValue(
      await corpus({
        catalogue: new Pages([{ entries: [entry(1), entry(2)] }]),
        duplicates: duplicates({ [v(2)]: 'unevaluated' }),
      }).load({}, CONTEXT),
    );
    expect(loaded.candidates.map((c) => c.itemVersionId)).toEqual([v(1)]);
    expect(loaded.unevaluated).toEqual([v(2)]);
    expect(loaded.nearDuplicates.has(v(2))).toBe(false);
  });
});

describe('when something cannot be read', () => {
  const FAILING: readonly (readonly [string, Partial<ConstructorParameters<typeof ContentCorpus>[0]>])[] = [
    ['the published catalogue', { catalogue: new Pages('fails') }],
    ['the anchor pool', { anchors: anchors('fails') }],
    ['the exposure ledger', { exposure: exposure('fails') }],
    ['content\'s duplicate detection', { duplicates: duplicates({ [v(1)]: 'fails' }) }],
  ];

  it.each(FAILING)('names %s and says nothing of the cause beyond its code', async (what, override) => {
    const failed = expectError(await corpus({ catalogue: new Pages([{ entries: [entry(1)] }]), ...override }).load({}, CONTEXT));
    expect(failed.code).toBe('CORPUS_UNAVAILABLE');
    expect(failed.kind).toBe('PreconditionFailed');
    expect(failed.message).toContain(what);
    expect(failed.message).not.toContain('secret detail');
  });
});
