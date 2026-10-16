import { describe, expect, it } from 'vitest';
import { sweep, type SweepResult } from '../../../testing/mutation-sweep.js';
import { FOUR_OPTIONS, aiProvenance, numericSpec, singleCorrectSpec, tags, textBody } from '../../../testing/content-fixtures.js';
import { createContentBody } from './content-body.js';
import { createItemVersion } from './item-version.js';

/**
 * **Debt D41: a domain constructor returns a value for input of the wrong
 * shape; it does not raise.**
 *
 * ENGINEERING-HANDBOOK §8 has expected failures as values. The domain's own
 * guard reads for the `throw` *keyword*, so a `TypeError` from dereferencing
 * something that is not there was invisible to it — and nothing had ever handed
 * these constructors anything their types did not allow, until a model's
 * proposal arrived as untyped JSON.
 *
 * This is the guard that can see it: every constructor on the proposal path is
 * run against every single-point malformation of a valid document, enumerated
 * (see `mutation-sweep.ts`), and may not raise on any.
 */

const MATCHING_MEMBER = (memberId: string, ordinal: number) => ({ memberId, ordinal, body: textBody(`member ${memberId}`) });
const SPECS = {
  SINGLE_CORRECT_MCQ: singleCorrectSpec(),
  MULTIPLE_CORRECT_MCQ: { itemType: 'MULTIPLE_CORRECT_MCQ', options: FOUR_OPTIONS, correctOptionIds: ['a', 'b'] },
  NUMERIC: numericSpec(),
  MATCHING: {
    itemType: 'MATCHING',
    left: [MATCHING_MEMBER('l1', 1), MATCHING_MEMBER('l2', 2)],
    right: [MATCHING_MEMBER('r1', 1), MATCHING_MEMBER('r2', 2)],
    pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }],
  },
} as const;

const AUTHOR = { kind: 'human', id: 'author-1', roleContext: ['author'] } as const;

function documentFor(itemType: keyof typeof SPECS): Record<string, unknown> {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: SPECS[itemType],
    taxonomyTags: tags(),
    difficultyEstimate: 'moderate',
    provenance: aiProvenance(),
    licensing: { status: 'owned' },
    stimulusVersionRef: 'stimulus-version-1',
  };
}

/** Everything the proposal path constructs from a content document, run on whatever shape arrived. */
function constructEverything(itemType: keyof typeof SPECS, mutated: unknown): void {
  const document = (typeof mutated === 'object' && mutated !== null ? mutated : {}) as Record<string, any>;
  createItemVersion(
    { versionId: 'v', versionNo: 1, itemType, authoredBy: AUTHOR, createdAt: '2026-01-01T00:00:00Z', ...document } as never,
    { latestPlausibleYear: 2026 },
  );
  createContentBody(document['stem']?.blocks as never);
  const spec = document['responseSpec'];
  for (const holder of [spec?.options, spec?.left, spec?.right]) {
    if (Array.isArray(holder)) for (const member of holder) createContentBody(member?.body?.blocks as never);
  }
}

const explained = (result: SweepResult): string[] => result.raised.map((entry) => `${entry.path} (${entry.how}): ${entry.message}`);

/** A body using every kind of block and inline there is, so no branch of the shape check is out of the sweep's reach. */
const text = (value: string, marks: string[] = []) => ({ kind: 'TEXT', value, marks });
const RICH_BODY = {
  blocks: [
    {
      kind: 'PARAGRAPH',
      inlines: [
        text('plain', ['BOLD']),
        { kind: 'MATH_INLINE', latex: 'x^2', textAlternative: 'x squared' },
        { kind: 'CHEM_INLINE', notation: 'H2O', textAlternative: 'water' },
        { kind: 'MEDIA_REF', assetVersionId: 'asset-1' },
      ],
    },
    { kind: 'MATH_BLOCK', latex: 'E = mc^2', textAlternative: 'E equals m c squared' },
    { kind: 'CHEM_BLOCK', notation: 'CH4', textAlternative: 'methane' },
    { kind: 'MEDIA_BLOCK', assetVersionId: 'asset-2', sizeHint: 'FULL_WIDTH', caption: [text('a caption')] },
    { kind: 'LIST', ordered: false, items: [[{ kind: 'PARAGRAPH', inlines: [text('item one')] }], [{ kind: 'PARAGRAPH', inlines: [text('item two')] }]] },
    { kind: 'TABLE', header: [[text('h1')], [text('h2')]], rows: [[[text('a')], [text('b')]]] },
  ],
};

describe('D41 — the constructors on the proposal path return a value for any single-point malformation', () => {
  for (const itemType of Object.keys(SPECS) as (keyof typeof SPECS)[]) {
    it(`a ${itemType} item, broken at every position in every way`, () => {
      const result = sweep(documentFor(itemType), (mutated) => constructEverything(itemType, mutated));
      expect(result.tried).toBeGreaterThan(200);
      expect(explained(result)).toEqual([]);
    });
  }

  it('and the stem on its own, which `createItemVersion` never looks inside', () => {
    const result = sweep(textBody('A stem with a list.'), (mutated) => {
      createContentBody((mutated as { blocks?: never } | null)?.blocks as never);
    });
    expect(result.tried).toBeGreaterThan(20);
    expect(explained(result)).toEqual([]);
  });

  it('and a body using every kind of block and inline, which the sweep above must be able to reach', () => {
    expect(createContentBody(RICH_BODY.blocks as never).ok).toBe(true);
    const result = sweep(RICH_BODY, (mutated) => {
      createContentBody((mutated as { blocks?: never } | null)?.blocks as never);
    });
    expect(result.tried).toBeGreaterThan(400);
    expect(explained(result)).toEqual([]);
  });

  it('while still accepting the valid documents they started from', () => {
    for (const itemType of Object.keys(SPECS) as (keyof typeof SPECS)[]) {
      const built = createItemVersion(
        { versionId: 'v', versionNo: 1, itemType, authoredBy: AUTHOR, createdAt: '2026-01-01T00:00:00Z', ...documentFor(itemType) } as never,
        { latestPlausibleYear: 2026 },
      );
      expect(built.ok, itemType).toBe(true);
    }
  });
});
