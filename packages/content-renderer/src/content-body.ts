/**
 * The node vocabulary the renderer draws (DEC-2).
 *
 * **Declared here rather than imported from the content context.** A package
 * cannot import an app, and the content domain imports nothing (§9 rule 2), so
 * there is no direction in which one definition could serve both. What keeps
 * them honest is a seam spec on the API side — `apps/api` may import this
 * package — asserting that `BLOCK_KINDS` and `INLINE_KINDS` are the same lists
 * on both sides. A kind added to one and not the other fails the build, which
 * is the same instrument the M2→M3 answer-key seam uses.
 *
 * The renderer reads these shapes and never constructs one: a `ContentBody`
 * that reaches here has already been through the domain constructor, which is
 * the only thing entitled to decide whether a document is valid.
 */

export const CONTENT_BODY_SCHEMA_VERSION = 1;

export const BLOCK_KINDS = [
  'PARAGRAPH',
  'MATH_BLOCK',
  'CHEM_BLOCK',
  'MEDIA_BLOCK',
  'LIST',
  'TABLE',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const INLINE_KINDS = ['TEXT', 'MATH_INLINE', 'CHEM_INLINE', 'MEDIA_REF'] as const;
export type InlineKind = (typeof INLINE_KINDS)[number];

export const TEXT_MARKS = ['BOLD', 'ITALIC', 'SUBSCRIPT', 'SUPERSCRIPT'] as const;
export type TextMark = (typeof TEXT_MARKS)[number];

export const MEDIA_SIZE_HINTS = ['INLINE', 'HALF_WIDTH', 'FULL_WIDTH'] as const;
export type MediaSizeHint = (typeof MEDIA_SIZE_HINTS)[number];

export type Inline =
  | { readonly kind: 'TEXT'; readonly value: string; readonly marks: readonly TextMark[] }
  | { readonly kind: 'MATH_INLINE'; readonly latex: string; readonly textAlternative: string }
  | { readonly kind: 'CHEM_INLINE'; readonly notation: string; readonly textAlternative: string }
  | { readonly kind: 'MEDIA_REF'; readonly assetVersionId: string; readonly altTextOverride?: string };

export type Block =
  | { readonly kind: 'PARAGRAPH'; readonly inlines: readonly Inline[] }
  | { readonly kind: 'MATH_BLOCK'; readonly latex: string; readonly textAlternative: string }
  | { readonly kind: 'CHEM_BLOCK'; readonly notation: string; readonly textAlternative: string }
  | {
      readonly kind: 'MEDIA_BLOCK';
      readonly assetVersionId: string;
      /** Authored content, not a string — a caption can carry notation, on the same argument M3-07 makes for option bodies (INV-14). */
      readonly caption?: readonly Inline[];
      readonly sizeHint: MediaSizeHint;
    }
  | { readonly kind: 'LIST'; readonly ordered: boolean; readonly items: readonly (readonly Block[])[] }
  | {
      readonly kind: 'TABLE';
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

export interface ContentBody {
  readonly schemaVersion: number;
  readonly blocks: readonly Block[];
}

export function isBlockKind(kind: string): kind is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(kind);
}

export function isInlineKind(kind: string): kind is InlineKind {
  return (INLINE_KINDS as readonly string[]).includes(kind);
}
