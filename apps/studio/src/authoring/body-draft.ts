import type { Block, ContentBody, Inline } from '@questionbank/content-renderer';

/**
 * The authored-body model every Studio editor shares — the item stem, an
 * option, a passage, a solution step.
 *
 * **One model, for the same reason there is one `ContentRenderer`** (§9 rule
 * 13 / F20). Three editors with three body models would drift, and the drift
 * would show up as a stimulus that accepts notation the item editor refuses —
 * or worse, as two ways of spelling the same document. The DEC-2 vocabulary is
 * closed; the draft that maps onto it should be too.
 */

/* ------------------------------------------------------------------ *
 * Dual-mode notation input (UX §10.1)
 * ------------------------------------------------------------------ */

export const NOTATION_MODES = ['latex', 'palette'] as const;
export type NotationMode = (typeof NOTATION_MODES)[number];

export function isNotationMode(value: string): value is NotationMode {
  return (NOTATION_MODES as readonly string[]).includes(value);
}

export interface PaletteEntry {
  readonly id: string;
  readonly label: string;
  /** The LaTeX the entry contributes. */
  readonly snippet: string;
  /** Where the caret lands inside the snippet, so the next keystroke is in the numerator. */
  readonly caretOffset: number;
}

/**
 * The visual palette, for the subject experts who do not write LaTeX. Forcing
 * LaTeX excludes most of them; forcing a palette insults the fluent ones
 * (UX §10.1), so both edit the same string and neither is the primary.
 */
export const NOTATION_PALETTE: readonly PaletteEntry[] = Object.freeze([
  { id: 'fraction', label: 'Fraction', snippet: '\\frac{}{}', caretOffset: 6 },
  { id: 'superscript', label: 'Superscript', snippet: '^{}', caretOffset: 2 },
  { id: 'subscript', label: 'Subscript', snippet: '_{}', caretOffset: 2 },
  { id: 'square-root', label: 'Square root', snippet: '\\sqrt{}', caretOffset: 6 },
  { id: 'integral', label: 'Integral', snippet: '\\int_{}^{}', caretOffset: 6 },
  { id: 'sum', label: 'Sum', snippet: '\\sum_{}^{}', caretOffset: 6 },
  { id: 'theta', label: 'Theta', snippet: '\\theta', caretOffset: 6 },
  { id: 'lambda', label: 'Lambda', snippet: '\\lambda', caretOffset: 7 },
  { id: 'times', label: 'Multiplication sign', snippet: '\\times', caretOffset: 6 },
]);

export function paletteEntryById(id: string): PaletteEntry | undefined {
  return NOTATION_PALETTE.find((entry) => entry.id === id);
}

/** Inserts a palette entry at the caret and reports where the caret lands. */
export function insertPaletteEntry(
  latex: string,
  caret: number,
  entry: PaletteEntry,
): { readonly latex: string; readonly caret: number } {
  const at = Math.max(0, Math.min(caret, latex.length));
  return {
    latex: `${latex.slice(0, at)}${entry.snippet}${latex.slice(at)}`,
    caret: at + entry.caretOffset,
  };
}

export interface NotationSegment {
  readonly kind: 'PALETTE' | 'LITERAL';
  /** Present only on a `PALETTE` segment. */
  readonly entryId?: string;
  readonly text: string;
}

/**
 * The palette's *view* of an expression: which spans it recognises as its own
 * and which are text the author typed.
 *
 * **Unrecognised text stays as a `LITERAL` segment rather than being dropped.**
 * That is the whole of what makes the mode switch lossless — the LaTeX string
 * is the one representation, and the palette is a reading of it, so switching
 * cannot lose what the palette does not understand. An editor that kept a
 * second model behind the palette is the one that loses half an equation the
 * first time an author types something the palette has no button for.
 */
export function segmentForPalette(latex: string): readonly NotationSegment[] {
  const segments: NotationSegment[] = [];
  let literal = '';
  let index = 0;

  const flush = (): void => {
    if (literal.length > 0) {
      segments.push({ kind: 'LITERAL', text: literal });
      literal = '';
    }
  };

  while (index < latex.length) {
    const entry = NOTATION_PALETTE.find((candidate) => latex.startsWith(candidate.snippet, index));
    if (entry === undefined) {
      literal += latex.charAt(index);
      index += 1;
      continue;
    }
    flush();
    segments.push({ kind: 'PALETTE', entryId: entry.id, text: entry.snippet });
    index += entry.snippet.length;
  }

  flush();
  return segments;
}

/** The inverse of `segmentForPalette`. Their composition is the identity. */
export function joinSegments(segments: readonly NotationSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/* ------------------------------------------------------------------ *
 * The body draft
 * ------------------------------------------------------------------ */

export const BODY_BLOCK_KINDS = ['TEXT', 'MATH', 'CHEM'] as const;
export type BodyBlockKind = (typeof BODY_BLOCK_KINDS)[number];

export type BodyBlockDraft =
  | { readonly kind: 'TEXT'; readonly value: string }
  | { readonly kind: 'MATH'; readonly latex: string; readonly textAlternative: string }
  | { readonly kind: 'CHEM'; readonly notation: string; readonly textAlternative: string };

export interface BodyDraft {
  readonly blocks: readonly BodyBlockDraft[];
}

export function emptyBody(): BodyDraft {
  return { blocks: [{ kind: 'TEXT', value: '' }] };
}

/**
 * Turns the draft into the closed vocabulary the renderer draws (DEC-2).
 *
 * Blank text blocks are dropped rather than emitted: a `Paragraph` with an
 * empty inline is a document the domain constructor refuses, and an author
 * who has not finished typing has not authored a defect. The resulting
 * document may still be empty, which `itemEditorFormErrors` reports as a
 * field problem — that is a different message from a rejected save.
 */
export function toContentBody(draft: BodyDraft): ContentBody {
  const blocks: Block[] = [];

  for (const block of draft.blocks) {
    if (block.kind === 'TEXT') {
      if (block.value.trim().length === 0) continue;
      const inline: Inline = { kind: 'TEXT', value: block.value, marks: [] };
      blocks.push({ kind: 'PARAGRAPH', inlines: [inline] });
      continue;
    }
    if (block.kind === 'MATH') {
      blocks.push({
        kind: 'MATH_BLOCK',
        latex: block.latex,
        textAlternative: block.textAlternative,
      });
      continue;
    }
    blocks.push({
      kind: 'CHEM_BLOCK',
      notation: block.notation,
      textAlternative: block.textAlternative,
    });
  }

  return { schemaVersion: 1, blocks };
}

/** The blocks that carry notation, and therefore a mandatory alternative. */
export type NotationBlockDraft = Exclude<BodyBlockDraft, { kind: 'TEXT' }>;

export function isNotationBlock(block: BodyBlockDraft): block is NotationBlockDraft {
  return block.kind !== 'TEXT';
}

/** The notation source of a block, whichever notation class it is. */
export function notationSourceOf(block: NotationBlockDraft): string {
  return block.kind === 'MATH' ? block.latex : block.notation;
}

/** Replaces the notation source in place, keeping the block's own kind. */
export function withNotationSource(block: NotationBlockDraft, source: string): NotationBlockDraft {
  return block.kind === 'MATH' ? { ...block, latex: source } : { ...block, notation: source };
}


/* ------------------------------------------------------------------ *
 * Field errors over a body
 * ------------------------------------------------------------------ */

/**
 * A problem with a field, as against a finding about the item.
 *
 * The code stays a type parameter so each editor keeps its own closed set: a
 * shared open vocabulary is how two surfaces come to spell the same problem
 * two ways.
 */
export interface FieldError<C extends string = string> {
  readonly code: C;
  readonly message: string;
  /** Where the problem is, in the draft's own terms (`body.blocks[1]`). */
  readonly location: string;
  /** The DOM id of the field to move focus to, so an error summary can link. */
  readonly fieldId: string;
}

/** True when nothing in the draft survives into the document. */
export function bodyIsEmpty(body: BodyDraft): boolean {
  return toContentBody(body).blocks.length === 0;
}

/**
 * ACC-02 at the field: an expression with no authored alternative is one a
 * screen reader cannot read, however good the MathML is.
 */
export function notationAlternativeErrors<C extends string>(
  body: BodyDraft,
  code: C,
  locationPrefix: string,
  fieldPrefix: string,
): FieldError<C>[] {
  const errors: FieldError<C>[] = [];
  body.blocks.forEach((block, index) => {
    if (!isNotationBlock(block) || block.textAlternative.trim().length > 0) return;
    errors.push({
      code,
      message: 'Describe this expression in words — a screen reader reads the description, not the LaTeX.',
      location: `${locationPrefix}.blocks[${index}]`,
      fieldId: `${fieldPrefix}-alt-${index}`,
    });
  });
  return errors;
}
