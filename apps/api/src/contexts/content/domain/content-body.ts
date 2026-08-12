import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';

/**
 * `ContentBody` — structured, renderer-agnostic markup (DOMAIN-MODEL §5).
 *
 * **Never rendered markup, never an image of text.** That sentence is INV-14
 * and ACC-02 in one: a stem stored as HTML renders differently on four
 * surfaces, and a stem stored as a picture of an equation is unreadable to a
 * screen reader and unsearchable to everyone. Both are refused at construction
 * rather than caught at review.
 *
 * **The vocabulary is closed** (DEC-2). A renderer that meets a node kind it
 * does not know cannot render it, and INV-14 promises deterministic rendering
 * across web, mobile, offline and print. Adding a node is a reviewed code
 * change in this file *and* in the renderer, plus a `schemaVersion` bump —
 * never a data change. This is the same argument scoring uses for its item-type
 * vocabulary, and it holds for the same reason.
 *
 * **`textAlternative` is mandatory on every notation node.** ACC-02 requires
 * reading order to be verified per notation class against real screen readers,
 * which is impossible if the alternative is optional: a node that can exist
 * without one will eventually reach a student without one. It is enforced here,
 * in the constructor — not at publication, where it would only catch the items
 * somebody remembered to publish through the checked path.
 */

/** The document schema version. Bumped only alongside a vocabulary change. */
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
      readonly sizeHint: MediaSizeHint;
      readonly caption?: readonly Inline[];
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

export type ContentBodyErrorCode =
  | 'BODY_EMPTY'
  | 'BLOCK_KIND_UNKNOWN'
  | 'INLINE_KIND_UNKNOWN'
  | 'PARAGRAPH_EMPTY'
  | 'TEXT_VALUE_EMPTY'
  | 'TEXT_MARK_UNKNOWN'
  | 'RENDERED_MARKUP_PRESENT'
  | 'NOTATION_EMPTY'
  | 'TEXT_ALTERNATIVE_REQUIRED'
  | 'MEDIA_REFERENCE_EMPTY'
  | 'MEDIA_SIZE_HINT_UNKNOWN'
  | 'LIST_EMPTY'
  | 'LIST_ITEM_EMPTY'
  | 'LIST_NESTING_TOO_DEEP'
  | 'TABLE_HEADER_EMPTY'
  | 'TABLE_ROWS_EMPTY'
  | 'TABLE_ROW_RAGGED';

export type ContentBodyError = ContentError<ContentBodyErrorCode>;

/**
 * A list nested deeper than this is unreadable on a 360 px screen and is
 * almost always a mis-authored table. The bound also makes recursion here
 * provably terminating rather than argued to be.
 */
export const MAX_LIST_DEPTH = 3;

/**
 * Rendered markup, caught by shape rather than by intent.
 *
 * A stem carrying `<sup>2</sup>` is HTML that happens to be stored in a
 * structured field, and it renders as literal text on print and as markup on
 * web — the exact divergence INV-14 exists to prevent. Marks express emphasis;
 * `MATH_INLINE` expresses an exponent.
 */
const MARKUP_PATTERN = /<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/iu;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: ContentBodyErrorCode, message: string, location: string): ContentBodyError {
  return validationError(code, message, location);
}

function checkNotation(
  kind: 'MATH' | 'CHEM',
  notation: string,
  textAlternative: string,
  location: string,
): ContentBodyError | undefined {
  if (isBlank(notation)) {
    return invalid('NOTATION_EMPTY', `a ${kind.toLowerCase()} node requires notation`, location);
  }
  if (isBlank(textAlternative)) {
    return invalid(
      'TEXT_ALTERNATIVE_REQUIRED',
      `a ${kind.toLowerCase()} node requires an authored textAlternative — ACC-02 is not solved by a rendering library`,
      location,
    );
  }
  return undefined;
}

function checkInline(inline: Inline, location: string): ContentBodyError | undefined {
  if (!(INLINE_KINDS as readonly string[]).includes(inline.kind)) {
    return invalid(
      'INLINE_KIND_UNKNOWN',
      `unknown inline kind "${String((inline as { kind: string }).kind)}"`,
      location,
    );
  }

  switch (inline.kind) {
    case 'TEXT': {
      if (isBlank(inline.value)) {
        return invalid('TEXT_VALUE_EMPTY', 'a text node requires a value', location);
      }
      if (MARKUP_PATTERN.test(inline.value)) {
        return invalid(
          'RENDERED_MARKUP_PRESENT',
          'a text value carries rendered markup; use marks or a notation node instead (INV-14)',
          location,
        );
      }
      const unknownMark = inline.marks.find((mark) => !(TEXT_MARKS as readonly string[]).includes(mark));
      if (unknownMark !== undefined) {
        return invalid('TEXT_MARK_UNKNOWN', `unknown text mark "${unknownMark}"`, location);
      }
      return undefined;
    }

    case 'MATH_INLINE':
      return checkNotation('MATH', inline.latex, inline.textAlternative, location);

    case 'CHEM_INLINE':
      return checkNotation('CHEM', inline.notation, inline.textAlternative, location);

    case 'MEDIA_REF':
      return isBlank(inline.assetVersionId)
        ? invalid('MEDIA_REFERENCE_EMPTY', 'a media reference requires an assetVersionId', location)
        : undefined;
  }
}

function checkInlines(inlines: readonly Inline[], location: string): ContentBodyError | undefined {
  for (const [index, inline] of inlines.entries()) {
    const failure = checkInline(inline, `${location}.inlines[${index}]`);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function checkBlock(block: Block, location: string, depth: number): ContentBodyError | undefined {
  if (!(BLOCK_KINDS as readonly string[]).includes(block.kind)) {
    return invalid(
      'BLOCK_KIND_UNKNOWN',
      `unknown block kind "${String((block as { kind: string }).kind)}"`,
      location,
    );
  }

  switch (block.kind) {
    case 'PARAGRAPH':
      return block.inlines.length === 0
        ? invalid('PARAGRAPH_EMPTY', 'a paragraph requires at least one inline', location)
        : checkInlines(block.inlines, location);

    case 'MATH_BLOCK':
      return checkNotation('MATH', block.latex, block.textAlternative, location);

    case 'CHEM_BLOCK':
      return checkNotation('CHEM', block.notation, block.textAlternative, location);

    case 'MEDIA_BLOCK': {
      if (isBlank(block.assetVersionId)) {
        return invalid('MEDIA_REFERENCE_EMPTY', 'a media block requires an assetVersionId', location);
      }
      if (!(MEDIA_SIZE_HINTS as readonly string[]).includes(block.sizeHint)) {
        return invalid('MEDIA_SIZE_HINT_UNKNOWN', `unknown size hint "${block.sizeHint}"`, location);
      }
      return block.caption === undefined ? undefined : checkInlines(block.caption, location);
    }

    case 'LIST': {
      if (depth >= MAX_LIST_DEPTH) {
        return invalid(
          'LIST_NESTING_TOO_DEEP',
          `a list may nest ${MAX_LIST_DEPTH} deep; deeper is unreadable at the 360 px floor`,
          location,
        );
      }
      if (block.items.length === 0) {
        return invalid('LIST_EMPTY', 'a list requires at least one item', location);
      }
      for (const [index, item] of block.items.entries()) {
        const itemLocation = `${location}.items[${index}]`;
        if (item.length === 0) {
          return invalid('LIST_ITEM_EMPTY', 'a list item requires at least one block', itemLocation);
        }
        for (const [blockIndex, nested] of item.entries()) {
          const failure = checkBlock(nested, `${itemLocation}.blocks[${blockIndex}]`, depth + 1);
          if (failure !== undefined) return failure;
        }
      }
      return undefined;
    }

    case 'TABLE': {
      if (block.header.length === 0) {
        return invalid('TABLE_HEADER_EMPTY', 'a table requires a header row', location);
      }
      if (block.rows.length === 0) {
        return invalid('TABLE_ROWS_EMPTY', 'a table requires at least one body row', location);
      }
      for (const [index, cell] of block.header.entries()) {
        const failure = checkInlines(cell, `${location}.header[${index}]`);
        if (failure !== undefined) return failure;
      }
      for (const [rowIndex, row] of block.rows.entries()) {
        if (row.length !== block.header.length) {
          return invalid(
            'TABLE_ROW_RAGGED',
            `row ${rowIndex} has ${row.length} cells; the header has ${block.header.length}`,
            `${location}.rows[${rowIndex}]`,
          );
        }
        for (const [cellIndex, cell] of row.entries()) {
          const failure = checkInlines(cell, `${location}.rows[${rowIndex}][${cellIndex}]`);
          if (failure !== undefined) return failure;
        }
      }
      return undefined;
    }
  }
}

function freezeInline(inline: Inline): Inline {
  return inline.kind === 'TEXT'
    ? Object.freeze({ ...inline, marks: Object.freeze([...inline.marks]) })
    : Object.freeze({ ...inline });
}

function freezeInlines(inlines: readonly Inline[]): readonly Inline[] {
  return Object.freeze(inlines.map(freezeInline));
}

function freezeBlock(block: Block): Block {
  switch (block.kind) {
    case 'PARAGRAPH':
      return Object.freeze({ ...block, inlines: freezeInlines(block.inlines) });
    case 'MEDIA_BLOCK':
      return Object.freeze(
        block.caption === undefined ? { ...block } : { ...block, caption: freezeInlines(block.caption) },
      );
    case 'LIST':
      return Object.freeze({
        ...block,
        items: Object.freeze(block.items.map((item) => Object.freeze(item.map(freezeBlock)))),
      });
    case 'TABLE':
      return Object.freeze({
        ...block,
        header: Object.freeze(block.header.map(freezeInlines)),
        rows: Object.freeze(block.rows.map((row) => Object.freeze(row.map(freezeInlines)))),
      });
    case 'MATH_BLOCK':
    case 'CHEM_BLOCK':
      return Object.freeze({ ...block });
  }
}

/**
 * The only way a `ContentBody` comes into existence. Construction is total: an
 * invalid document returns the first failure with its location, and no
 * partially-built body escapes.
 */
export function createContentBody(blocks: readonly Block[]): Result<ContentBody, ContentBodyError> {
  if (blocks.length === 0) {
    return err(invalid('BODY_EMPTY', 'a content body requires at least one block', 'blocks'));
  }

  for (const [index, block] of blocks.entries()) {
    const failure = checkBlock(block, `blocks[${index}]`, 0);
    if (failure !== undefined) return err(failure);
  }

  return ok(
    Object.freeze({
      schemaVersion: CONTENT_BODY_SCHEMA_VERSION,
      blocks: Object.freeze(blocks.map(freezeBlock)),
    }),
  );
}

export function isBlockKind(kind: string): kind is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(kind);
}

export function isInlineKind(kind: string): kind is InlineKind {
  return (INLINE_KINDS as readonly string[]).includes(kind);
}
