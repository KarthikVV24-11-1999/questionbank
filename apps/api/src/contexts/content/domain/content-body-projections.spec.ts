import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectValue } from '../../../testing/expect-result.js';
import { createContentBody, type Block, type Inline } from './content-body.js';
import {
  notationTerms,
  plainText,
  projectContentBody,
  referencedMediaIds,
} from './content-body-projections.js';

const DOMAIN_DIR = fileURLToPath(new URL('.', import.meta.url));

function text(value: string): Inline {
  return { kind: 'TEXT', value, marks: [] };
}

function paragraph(...inlines: Inline[]): Block {
  return { kind: 'PARAGRAPH', inlines };
}

function body(...blocks: Block[]) {
  return expectValue(createContentBody(blocks));
}

const MATH_INLINE: Inline = { kind: 'MATH_INLINE', latex: 'v_0 = 5', textAlternative: 'v naught equals five' };
const CHEM_INLINE: Inline = { kind: 'CHEM_INLINE', notation: 'H2SO4', textAlternative: 'sulfuric acid' };

describe('plainText — reading order for search and for screen readers', () => {
  it('joins paragraph inlines in document order', () => {
    expect(plainText(body(paragraph(text('A block'), text('slides down a ramp.'))))).toBe(
      'A block slides down a ramp.',
    );
  });

  it('puts each block on its own line', () => {
    expect(plainText(body(paragraph(text('first')), paragraph(text('second'))))).toBe('first\nsecond');
  });

  // The whole point: `\frac{1}{2}mv^2` in a search index matches nothing a
  // human types, and this string is the closest thing the model has to a
  // statement of reading order.
  it('renders a math block as its text alternative, never as its LaTeX', () => {
    const projected = plainText(
      body({ kind: 'MATH_BLOCK', latex: '\\frac{1}{2}mv^2', textAlternative: 'one half m v squared' }),
    );
    expect(projected).toBe('one half m v squared');
    expect(projected).not.toContain('frac');
  });

  it('renders a chem block as its text alternative, never as its notation', () => {
    const projected = plainText(
      body({ kind: 'CHEM_BLOCK', notation: '2H2 + O2 -> 2H2O', textAlternative: 'hydrogen burns' }),
    );
    expect(projected).toBe('hydrogen burns');
    expect(projected).not.toContain('->');
  });

  it('renders inline notation as its alternative, in place', () => {
    expect(plainText(body(paragraph(text('the speed'), MATH_INLINE, text('at the start'))))).toBe(
      'the speed v naught equals five at the start',
    );
  });

  it('renders an inline media reference as its alt-text override', () => {
    const media: Inline = { kind: 'MEDIA_REF', assetVersionId: 'a-1', altTextOverride: 'a labelled ramp' };
    expect(plainText(body(paragraph(text('see'), media)))).toBe('see a labelled ramp');
  });

  it('contributes nothing for a media reference with no override', () => {
    const media: Inline = { kind: 'MEDIA_REF', assetVersionId: 'a-1' };
    expect(plainText(body(paragraph(text('see'), media)))).toBe('see');
  });

  it('takes a media block’s caption and nothing else', () => {
    const block: Block = {
      kind: 'MEDIA_BLOCK',
      assetVersionId: 'a-1',
      sizeHint: 'FULL_WIDTH',
      caption: [text('Figure 1')],
    };
    expect(plainText(body(block))).toBe('Figure 1');
  });

  it('contributes nothing for a media block with no caption', () => {
    const block: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a-1', sizeHint: 'INLINE' };
    expect(plainText(body(block, paragraph(text('after'))))).toBe('after');
  });

  it('reads a list in item order, one line per block', () => {
    const list: Block = {
      kind: 'LIST',
      ordered: true,
      items: [[paragraph(text('first'))], [paragraph(text('second'))]],
    };
    expect(plainText(body(list))).toBe('first\nsecond');
  });

  it('reads a nested list depth-first, preserving order', () => {
    const inner: Block = { kind: 'LIST', ordered: false, items: [[paragraph(text('inner'))]] };
    const outer: Block = {
      kind: 'LIST',
      ordered: false,
      items: [[paragraph(text('outer')), inner], [paragraph(text('last'))]],
    };
    expect(plainText(body(outer))).toBe('outer\ninner\nlast');
  });

  it('reads a table header before its rows, cells left to right', () => {
    const table: Block = {
      kind: 'TABLE',
      header: [[text('Element')], [text('Symbol')]],
      rows: [[[text('Sodium')], [text('Na')]], [[text('Potassium')], [text('K')]]],
    };
    expect(plainText(body(table))).toBe('Element Symbol\nSodium Na\nPotassium K');
  });

  it('is deterministic across repeated calls', () => {
    const document = body(paragraph(text('a'), MATH_INLINE), CHEM_INLINE_BLOCK());
    const first = plainText(document);
    for (let run = 0; run < 100; run += 1) expect(plainText(document)).toBe(first);
  });
});

function CHEM_INLINE_BLOCK(): Block {
  return { kind: 'CHEM_BLOCK', notation: 'NaCl', textAlternative: 'sodium chloride' };
}

describe('notationTerms — the symbolic search field', () => {
  it('tokenizes identifiers and numbers out of LaTeX', () => {
    expect(notationTerms(body(paragraph(MATH_INLINE)))).toEqual(['v', '0', '=', '5']);
  });

  it('drops backslashed commands, which match nothing a searcher types', () => {
    const terms = notationTerms(
      body({ kind: 'MATH_BLOCK', latex: '\\frac{1}{2}mv^2', textAlternative: 'half m v squared' }),
    );
    expect(terms).not.toContain('frac');
    expect(terms).toEqual(['1', '2', 'mv']);
  });

  // H2SO4 tokenizes as h2/so4 rather than h/2/so/4: a searcher typing the
  // formula tokenizes it the same way and matches, where splitting every
  // digit off its element would match half the periodic table.
  it('keeps chemical formulae as searchable terms', () => {
    expect(notationTerms(body(paragraph(CHEM_INLINE)))).toEqual(['h2', 'so4']);
  });

  it('keeps a reaction arrow', () => {
    const terms = notationTerms(
      body({ kind: 'CHEM_BLOCK', notation: 'A -> B', textAlternative: 'a yields b' }),
    );
    expect(terms).toEqual(['a', '->', 'b']);
  });

  it('lowercases so a query need not match the author’s casing', () => {
    expect(notationTerms(body(paragraph(CHEM_INLINE)))).toContain('so4');
  });

  it('deduplicates while keeping first-occurrence order', () => {
    const repeated: Inline = { kind: 'MATH_INLINE', latex: 'x + x + y', textAlternative: 'x plus x plus y' };
    expect(notationTerms(body(paragraph(repeated)))).toEqual(['x', '+', 'y']);
  });

  it('collects notation from every position it can appear in', () => {
    const inList: Block = { kind: 'LIST', ordered: false, items: [[paragraph(MATH_INLINE)]] };
    const inTable: Block = {
      kind: 'TABLE',
      header: [[CHEM_INLINE]],
      rows: [[[{ kind: 'MATH_INLINE', latex: 'z', textAlternative: 'z' }]]],
    };
    const inCaption: Block = {
      kind: 'MEDIA_BLOCK',
      assetVersionId: 'a-1',
      sizeHint: 'INLINE',
      caption: [{ kind: 'CHEM_INLINE', notation: 'CO2', textAlternative: 'carbon dioxide' }],
    };
    const terms = notationTerms(body(inList, inTable, inCaption));
    expect(terms).toEqual(expect.arrayContaining(['v', 'h2', 'so4', 'z', 'co2']));
  });

  it('is empty for a document with no notation', () => {
    expect(notationTerms(body(paragraph(text('plain prose only'))))).toEqual([]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(notationTerms(body(paragraph(MATH_INLINE))))).toBe(true);
  });

  it('is deterministic across repeated calls', () => {
    const document = body(paragraph(MATH_INLINE, CHEM_INLINE));
    const first = notationTerms(document);
    for (let run = 0; run < 100; run += 1) expect(notationTerms(document)).toEqual(first);
  });
});

describe('referencedMediaIds — the usage graph’s edge set', () => {
  it('collects a media block’s asset', () => {
    const block: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a-1', sizeHint: 'INLINE' };
    expect(referencedMediaIds(body(block))).toEqual(['a-1']);
  });

  it('collects an inline media reference', () => {
    const media: Inline = { kind: 'MEDIA_REF', assetVersionId: 'a-2' };
    expect(referencedMediaIds(body(paragraph(media)))).toEqual(['a-2']);
  });

  // One edge per relationship, not per mention: a usage graph that counts
  // mentions answers "is this asset in use?" wrongly as soon as a caption
  // is edited.
  it('yields one id for an asset referenced twice', () => {
    const first: Inline = { kind: 'MEDIA_REF', assetVersionId: 'a-1' };
    const second: Inline = { kind: 'MEDIA_REF', assetVersionId: 'a-1' };
    expect(referencedMediaIds(body(paragraph(first, second)))).toEqual(['a-1']);
  });

  it('deduplicates a block and an inline naming the same asset', () => {
    const block: Block = {
      kind: 'MEDIA_BLOCK',
      assetVersionId: 'a-1',
      sizeHint: 'INLINE',
      caption: [{ kind: 'MEDIA_REF', assetVersionId: 'a-1' }],
    };
    expect(referencedMediaIds(body(block))).toEqual(['a-1']);
  });

  it('preserves document order across blocks', () => {
    const first: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a-1', sizeHint: 'INLINE' };
    const second: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a-2', sizeHint: 'INLINE' };
    expect(referencedMediaIds(body(second, first))).toEqual(['a-2', 'a-1']);
  });

  it('descends into list items', () => {
    const media: Inline = { kind: 'MEDIA_REF', assetVersionId: 'a-3' };
    const list: Block = { kind: 'LIST', ordered: false, items: [[paragraph(media)]] };
    expect(referencedMediaIds(body(list))).toEqual(['a-3']);
  });

  it('descends into table header and body cells', () => {
    const table: Block = {
      kind: 'TABLE',
      header: [[{ kind: 'MEDIA_REF', assetVersionId: 'a-4' }]],
      rows: [[[{ kind: 'MEDIA_REF', assetVersionId: 'a-5' }]]],
    };
    expect(referencedMediaIds(body(table))).toEqual(['a-4', 'a-5']);
  });

  it('ignores notation blocks, which reference nothing', () => {
    const math: Block = { kind: 'MATH_BLOCK', latex: 'x^2', textAlternative: 'x squared' };
    expect(referencedMediaIds(body(math, CHEM_INLINE_BLOCK()))).toEqual([]);
  });

  it('is empty for a document with no media', () => {
    expect(referencedMediaIds(body(paragraph(text('prose'))))).toEqual([]);
  });

  it('is frozen', () => {
    const block: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a-1', sizeHint: 'INLINE' };
    expect(Object.isFrozen(referencedMediaIds(body(block)))).toBe(true);
  });
});

describe('projectContentBody', () => {
  it('returns all three projections at once, frozen', () => {
    const media: Block = {
      kind: 'MEDIA_BLOCK',
      assetVersionId: 'a-1',
      sizeHint: 'INLINE',
      caption: [text('Figure 1')],
    };
    const projections = projectContentBody(body(paragraph(text('stem'), MATH_INLINE), media));
    expect(projections).toEqual({
      plainText: 'stem v naught equals five\nFigure 1',
      notationTerms: ['v', '0', '=', '5'],
      referencedMediaIds: ['a-1'],
    });
    expect(Object.isFrozen(projections)).toBe(true);
  });

  it('is byte-identical across repeated calls on the same document', () => {
    const document = body(paragraph(text('a'), MATH_INLINE, CHEM_INLINE));
    const first = JSON.stringify(projectContentBody(document));
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(projectContentBody(document))).toBe(first);
    }
  });
});

describe('projections are derived, never authored', () => {
  // A projection that can be supplied is a projection that can disagree with
  // the document it claims to summarize.
  it('exposes no constructor, setter or input type accepting a projection', () => {
    const sources = readdirSync(DOMAIN_DIR)
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      // The projections module is where they are produced; everywhere else
      // they must be recomputed, never accepted.
      .filter((entry) => entry !== 'content-body-projections.ts')
      .map((entry) => readFileSync(join(DOMAIN_DIR, entry), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/readonly\s+(plainText|notationTerms|referencedMediaIds)\s*[?]?\s*:/u);
    }
  });
});
