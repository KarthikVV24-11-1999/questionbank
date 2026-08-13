import { describe, expect, it } from 'vitest';
import {
  BLOCK_KINDS as RENDERER_BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION as RENDERER_SCHEMA_VERSION,
  INLINE_KINDS as RENDERER_INLINE_KINDS,
  MEDIA_SIZE_HINTS as RENDERER_SIZE_HINTS,
  TEXT_MARKS as RENDERER_TEXT_MARKS,
  type Block as RendererBlock,
  type ContentBody as RendererContentBody,
  type Inline as RendererInline,
} from '@questionbank/content-renderer/content-body';
import {
  BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION,
  INLINE_KINDS,
  MEDIA_SIZE_HINTS,
  TEXT_MARKS,
  type Block as DomainBlock,
  type ContentBody as DomainContentBody,
  type Inline as DomainInline,
} from './domain/content-body.js';

/**
 * The content → renderer seam.
 *
 * The renderer declares the node vocabulary itself: a package cannot import an
 * app, and `domain/` imports nothing (§9 rule 2), so there is no direction in
 * which one definition serves both. What keeps them honest is this file — a
 * kind added on one side and not the other fails the build here, which is the
 * same instrument the M2→M3 answer-key seam uses and the same reason.
 *
 * Without it, a new node kind ships as a fallback box on a student's screen
 * and nobody finds out until a mark is disputed.
 *
 * The import is the **vocabulary subpath**, not the package barrel: this file
 * checks the node kinds, not the component that draws them, so it never
 * needs the `.tsx` import chain `render-validator.adapter.ts` does (M0-09,
 * ADR-0016). The API can type-check JSX since M0-09 — that adapter is the
 * one file with a reason to — but this seam spec still has none of its own.
 */

describe('the node vocabulary is the same on both sides (DEC-2)', () => {
  it('agrees on the block kinds', () => {
    expect([...RENDERER_BLOCK_KINDS]).toEqual([...BLOCK_KINDS]);
  });

  it('agrees on the inline kinds', () => {
    expect([...RENDERER_INLINE_KINDS]).toEqual([...INLINE_KINDS]);
  });

  it('agrees on the text marks', () => {
    expect([...RENDERER_TEXT_MARKS]).toEqual([...TEXT_MARKS]);
  });

  it('agrees on the media size hints', () => {
    expect([...RENDERER_SIZE_HINTS]).toEqual([...MEDIA_SIZE_HINTS]);
  });

  // A document written under one schema version and rendered under another is
  // exactly the divergence the sibling `*_schema_version` column exists to
  // catch at rest; this catches it in the code path.
  it('agrees on the schema version', () => {
    expect(RENDERER_SCHEMA_VERSION).toBe(CONTENT_BODY_SCHEMA_VERSION);
  });

  it('checks a vocabulary that is not empty', () => {
    expect(RENDERER_BLOCK_KINDS.length).toBeGreaterThan(0);
    expect(RENDERER_INLINE_KINDS.length).toBeGreaterThan(0);
  });
});

/**
 * The kind lists above are the vocabulary's *names*. They said nothing about
 * the *shape* of a `MEDIA_BLOCK` or a `MEDIA_REF`, which is exactly how a
 * caption typed `string` on one side and `readonly Inline[]` on the other
 * survived a milestone undetected — both lists still matched. This section
 * closes that hole two ways: a compile-time check that neither `ContentBody`
 * can hold a document the other would reject, and a runtime check a reader
 * can actually see the comparison being made in.
 */

/**
 * Type-level mutual assignability. Never called — tsc still checks a
 * function body it never executes, which is what makes this inert at
 * runtime and load-bearing at compile time. If any variant's field
 * diverges, in name, type or optionality, one of these two assignments
 * fails to compile: a real document built to one `ContentBody` must also be
 * a valid instance of the other, and vice versa.
 */
function assertMutualAssignability(): void {
  const aDomainBody = {} as DomainContentBody;
  const aRendererBody = {} as RendererContentBody;
  const domainBodySatisfiesRenderer: RendererContentBody = aDomainBody;
  const rendererBodySatisfiesDomain: DomainContentBody = aRendererBody;
  void domainBodySatisfiesRenderer;
  void rendererBodySatisfiesDomain;
}
void assertMutualAssignability;

/**
 * One representative literal per kind, per side, each checked with
 * `satisfies` against its own type — every optional field is filled in, so
 * `Object.keys` reports the *complete* field set for that variant rather
 * than whatever a sparser example happened to include.
 */
const DOMAIN_BLOCK_FIXTURES: Record<DomainBlock['kind'], DomainBlock> = {
  PARAGRAPH: { kind: 'PARAGRAPH', inlines: [] } satisfies DomainBlock,
  MATH_BLOCK: { kind: 'MATH_BLOCK', latex: 'x', textAlternative: 'x' } satisfies DomainBlock,
  CHEM_BLOCK: { kind: 'CHEM_BLOCK', notation: 'x', textAlternative: 'x' } satisfies DomainBlock,
  MEDIA_BLOCK: {
    kind: 'MEDIA_BLOCK',
    assetVersionId: 'a',
    sizeHint: 'INLINE',
    caption: [],
  } satisfies DomainBlock,
  LIST: { kind: 'LIST', ordered: true, items: [] } satisfies DomainBlock,
  TABLE: { kind: 'TABLE', header: [], rows: [] } satisfies DomainBlock,
};

const RENDERER_BLOCK_FIXTURES: Record<RendererBlock['kind'], RendererBlock> = {
  PARAGRAPH: { kind: 'PARAGRAPH', inlines: [] } satisfies RendererBlock,
  MATH_BLOCK: { kind: 'MATH_BLOCK', latex: 'x', textAlternative: 'x' } satisfies RendererBlock,
  CHEM_BLOCK: { kind: 'CHEM_BLOCK', notation: 'x', textAlternative: 'x' } satisfies RendererBlock,
  MEDIA_BLOCK: {
    kind: 'MEDIA_BLOCK',
    assetVersionId: 'a',
    sizeHint: 'INLINE',
    caption: [],
  } satisfies RendererBlock,
  LIST: { kind: 'LIST', ordered: true, items: [] } satisfies RendererBlock,
  TABLE: { kind: 'TABLE', header: [], rows: [] } satisfies RendererBlock,
};

const DOMAIN_INLINE_FIXTURES: Record<DomainInline['kind'], DomainInline> = {
  TEXT: { kind: 'TEXT', value: 'x', marks: [] } satisfies DomainInline,
  MATH_INLINE: { kind: 'MATH_INLINE', latex: 'x', textAlternative: 'x' } satisfies DomainInline,
  CHEM_INLINE: { kind: 'CHEM_INLINE', notation: 'x', textAlternative: 'x' } satisfies DomainInline,
  MEDIA_REF: { kind: 'MEDIA_REF', assetVersionId: 'a', altTextOverride: 'x' } satisfies DomainInline,
};

const RENDERER_INLINE_FIXTURES: Record<RendererInline['kind'], RendererInline> = {
  TEXT: { kind: 'TEXT', value: 'x', marks: [] } satisfies RendererInline,
  MATH_INLINE: { kind: 'MATH_INLINE', latex: 'x', textAlternative: 'x' } satisfies RendererInline,
  CHEM_INLINE: { kind: 'CHEM_INLINE', notation: 'x', textAlternative: 'x' } satisfies RendererInline,
  MEDIA_REF: { kind: 'MEDIA_REF', assetVersionId: 'a', altTextOverride: 'x' } satisfies RendererInline,
};

function fieldNames(value: object): string[] {
  return Object.keys(value).sort();
}

describe('the node vocabulary is the same shape on both sides, field by field', () => {
  for (const kind of BLOCK_KINDS) {
    it(`${kind} has the same fields on both sides`, () => {
      const domainFields = fieldNames(DOMAIN_BLOCK_FIXTURES[kind]);
      const rendererFields = fieldNames(RENDERER_BLOCK_FIXTURES[kind]);
      expect(rendererFields).toEqual(domainFields);
    });
  }

  for (const kind of INLINE_KINDS) {
    it(`${kind} has the same fields on both sides`, () => {
      const domainFields = fieldNames(DOMAIN_INLINE_FIXTURES[kind]);
      const rendererFields = fieldNames(RENDERER_INLINE_FIXTURES[kind]);
      expect(rendererFields).toEqual(domainFields);
    });
  }

  it('every block kind and every inline kind has a fixture on both sides', () => {
    expect(Object.keys(DOMAIN_BLOCK_FIXTURES).sort()).toEqual([...BLOCK_KINDS].sort());
    expect(Object.keys(RENDERER_BLOCK_FIXTURES).sort()).toEqual([...BLOCK_KINDS].sort());
    expect(Object.keys(DOMAIN_INLINE_FIXTURES).sort()).toEqual([...INLINE_KINDS].sort());
    expect(Object.keys(RENDERER_INLINE_FIXTURES).sort()).toEqual([...INLINE_KINDS].sort());
  });
});
