import { describe, expect, it } from 'vitest';
import {
  NOTATION_PALETTE,
  emptyBody,
  insertPaletteEntry,
  joinSegments,
  paletteEntryById,
  segmentForPalette,
  toContentBody,
} from './body-draft.js';

describe('the notation palette is an insertion device over the LaTeX (UX §10.1)', () => {
  it('inserts at the caret and leaves the caret inside the snippet', () => {
    const fraction = paletteEntryById('fraction');
    expect(fraction).toBeDefined();

    const inserted = insertPaletteEntry('v = t', 4, fraction as NonNullable<typeof fraction>);
    expect(inserted.latex).toBe('v = \\frac{}{}t');
    expect(inserted.caret).toBe(4 + 6);
  });

  it('clamps a caret outside the string rather than producing a hole', () => {
    const theta = paletteEntryById('theta') as NonNullable<ReturnType<typeof paletteEntryById>>;
    expect(insertPaletteEntry('ab', 99, theta).latex).toBe('ab\\theta');
    expect(insertPaletteEntry('ab', -5, theta).latex).toBe('\\thetaab');
  });

  it('has no entry the palette cannot look up', () => {
    expect(NOTATION_PALETTE.length).toBeGreaterThan(0);
    for (const entry of NOTATION_PALETTE) {
      expect(paletteEntryById(entry.id), entry.id).toBe(entry);
      expect(entry.label.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.caretOffset, entry.id).toBeLessThanOrEqual(entry.snippet.length);
    }
  });
});

describe('the palette reading of an expression loses nothing', () => {
  const expressions = [
    '',
    'x + 1',
    '\\frac{}{}',
    'E = mc^{}',
    'v = \\frac{}{} + \\theta - 9.81',
    '\\unknowncommand{q}',
  ];

  it('round-trips every expression through segmentation', () => {
    let checked = 0;
    for (const latex of expressions) {
      expect(joinSegments(segmentForPalette(latex)), latex).toBe(latex);
      checked += 1;
    }
    // A round-trip check over nothing passes just as well as a correct one.
    expect(checked).toBe(expressions.length);
  });

  it('keeps text the palette does not recognise as a literal segment', () => {
    const segments = segmentForPalette('v = \\frac{}{} + \\theta');
    expect(segments.filter((segment) => segment.kind === 'PALETTE').map((s) => s.entryId)).toEqual([
      'fraction',
      'theta',
    ]);
    expect(segments.filter((segment) => segment.kind === 'LITERAL').map((s) => s.text)).toEqual([
      'v = ',
      ' + ',
    ]);
  });

  // The instrument is shown to fail before it is trusted: a segmenter that
  // kept only what the palette understands is exactly the bug this guards.
  it('the round trip fails on a segmenter that dropped the literals', () => {
    const latex = 'v = \\frac{}{}';
    const lossy = segmentForPalette(latex).filter((segment) => segment.kind === 'PALETTE');
    expect(joinSegments(lossy)).not.toBe(latex);
  });
});

describe('the draft becomes the closed node vocabulary (DEC-2)', () => {
  it('maps text, mathematics and chemistry onto their block kinds', () => {
    const body = toContentBody({
      blocks: [
        { kind: 'TEXT', value: 'Balance the equation.' },
        { kind: 'MATH', latex: 'x^{2}', textAlternative: 'x squared' },
        { kind: 'CHEM', notation: 'H2O', textAlternative: 'water' },
      ],
    });
    expect(body.schemaVersion).toBe(1);
    expect(body.blocks.map((block) => block.kind)).toEqual(['PARAGRAPH', 'MATH_BLOCK', 'CHEM_BLOCK']);
  });

  it('drops a blank text block rather than emitting a paragraph with nothing in it', () => {
    expect(toContentBody({ blocks: [{ kind: 'TEXT', value: '   ' }] }).blocks).toEqual([]);
    expect(toContentBody(emptyBody()).blocks).toEqual([]);
  });
});

