import type { Block, ContentBody, Inline } from './content-body.js';

/**
 * The three projections DATA-ARCHITECTURE §2 requires be written at the same
 * time as the document: `plain_text` for full-text search, `notation_terms[]`
 * for symbolic search, and `referenced_media_ids[]`, which is normalized out
 * into `content_media_ref` so media usage is a real relationship rather than a
 * JSON scan.
 *
 * **Derived, never authored.** Nothing accepts them as input, and M3-21
 * asserts a stored projection equals a fresh recomputation — a drifted
 * projection is a silently wrong search index, which nobody notices until an
 * author swears an item exists and search disagrees.
 *
 * **Plain text renders notation as its `textAlternative`, never as its LaTeX.**
 * `\frac{1}{2}mv^2` in a search index matches nothing a human types, and this
 * string is also the closest thing the model has to a statement of reading
 * order — so it has to be the words, not the source.
 */

/** Reading order, with notation and media as their authored alternatives. */
export function plainText(body: ContentBody): string {
  return body.blocks
    .map(blockToText)
    .filter((line) => line.length > 0)
    .join('\n');
}

function inlineToText(inline: Inline): string {
  switch (inline.kind) {
    case 'TEXT':
      return inline.value;
    case 'MATH_INLINE':
    case 'CHEM_INLINE':
      return inline.textAlternative;
    case 'MEDIA_REF':
      return inline.altTextOverride ?? '';
  }
}

function inlinesToText(inlines: readonly Inline[]): string {
  return inlines
    .map(inlineToText)
    .filter((part) => part.trim().length > 0)
    .join(' ')
    .trim();
}

function blockToText(block: Block): string {
  switch (block.kind) {
    case 'PARAGRAPH':
      return inlinesToText(block.inlines);
    case 'MATH_BLOCK':
    case 'CHEM_BLOCK':
      return block.textAlternative;
    case 'MEDIA_BLOCK':
      // The asset's own alt text lives on `MediaAsset` and is joined in at
      // query time; the caption is the only text this document owns.
      return block.caption === undefined ? '' : inlinesToText(block.caption);
    case 'LIST':
      return block.items
        .map((item) => item.map(blockToText).filter((line) => line.length > 0).join('\n'))
        .filter((line) => line.length > 0)
        .join('\n');
    case 'TABLE':
      return [block.header, ...block.rows]
        .map((row) => row.map(inlinesToText).filter((cell) => cell.length > 0).join(' '))
        .filter((line) => line.length > 0)
        .join('\n');
  }
}

/**
 * The symbolic search field.
 *
 * Notation is tokenized rather than stored whole, so `v_0` and `v_{0}` and
 * `\frac{1}{2}` all reduce to terms a query can match. Structural LaTeX —
 * braces, backslashed command names, alignment — carries no meaning to a
 * searcher and is dropped; what survives is identifiers, numbers and the
 * operators an author would actually search for.
 *
 * Order is document order, and duplicates are removed while keeping the first
 * occurrence, so the field is deterministic rather than set-ordered.
 */
export function notationTerms(body: ContentBody): readonly string[] {
  const terms: string[] = [];
  for (const source of collectNotation(body)) {
    for (const term of tokenizeNotation(source)) {
      if (!terms.includes(term)) terms.push(term);
    }
  }
  return Object.freeze(terms);
}

function collectNotation(body: ContentBody): string[] {
  const found: string[] = [];

  function fromInlines(inlines: readonly Inline[]): void {
    for (const inline of inlines) {
      if (inline.kind === 'MATH_INLINE') found.push(inline.latex);
      else if (inline.kind === 'CHEM_INLINE') found.push(inline.notation);
    }
  }

  function fromBlock(block: Block): void {
    switch (block.kind) {
      case 'PARAGRAPH':
        fromInlines(block.inlines);
        return;
      case 'MATH_BLOCK':
        found.push(block.latex);
        return;
      case 'CHEM_BLOCK':
        found.push(block.notation);
        return;
      case 'MEDIA_BLOCK':
        if (block.caption !== undefined) fromInlines(block.caption);
        return;
      case 'LIST':
        for (const item of block.items) for (const nested of item) fromBlock(nested);
        return;
      case 'TABLE':
        for (const cell of block.header) fromInlines(cell);
        for (const row of block.rows) for (const cell of row) fromInlines(cell);
        return;
    }
  }

  for (const block of body.blocks) fromBlock(block);
  return found;
}

/** Identifiers, numbers and the operators worth searching for. */
const NOTATION_TOKEN = /[A-Za-z]+\d*|\d+(?:\.\d+)?|->|<-|<=>|[+\-=<>]/gu;

/** Backslashed command names are structure, not content — `\frac` matches nothing. */
const LATEX_COMMAND = /\\[A-Za-z]+/gu;

function tokenizeNotation(source: string): string[] {
  const withoutCommands = source.replaceAll(LATEX_COMMAND, ' ');
  return [...withoutCommands.matchAll(NOTATION_TOKEN)].map((match) => match[0].toLowerCase());
}

/**
 * Every media asset version the document references, deduplicated, in document
 * order. An asset used twice is one edge in `content_media_ref` — a usage graph
 * that counts references rather than relationships answers "is this asset in
 * use?" wrongly the moment somebody edits a caption.
 */
export function referencedMediaIds(body: ContentBody): readonly string[] {
  const ids: string[] = [];

  function fromInlines(inlines: readonly Inline[]): void {
    for (const inline of inlines) {
      if (inline.kind === 'MEDIA_REF' && !ids.includes(inline.assetVersionId)) {
        ids.push(inline.assetVersionId);
      }
    }
  }

  function fromBlock(block: Block): void {
    switch (block.kind) {
      case 'PARAGRAPH':
        fromInlines(block.inlines);
        return;
      case 'MEDIA_BLOCK':
        if (!ids.includes(block.assetVersionId)) ids.push(block.assetVersionId);
        if (block.caption !== undefined) fromInlines(block.caption);
        return;
      case 'LIST':
        for (const item of block.items) for (const nested of item) fromBlock(nested);
        return;
      case 'TABLE':
        for (const cell of block.header) fromInlines(cell);
        for (const row of block.rows) for (const cell of row) fromInlines(cell);
        return;
      case 'MATH_BLOCK':
      case 'CHEM_BLOCK':
        return;
    }
  }

  for (const block of body.blocks) fromBlock(block);
  return Object.freeze(ids);
}

export interface ContentBodyProjections {
  readonly plainText: string;
  readonly notationTerms: readonly string[];
  readonly referencedMediaIds: readonly string[];
}

/** All three at once, which is how the repository writes them (M3-21). */
export function projectContentBody(body: ContentBody): ContentBodyProjections {
  return Object.freeze({
    plainText: plainText(body),
    notationTerms: notationTerms(body),
    referencedMediaIds: referencedMediaIds(body),
  });
}
