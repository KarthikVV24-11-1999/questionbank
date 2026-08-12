import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION,
  createContentBody,
  INLINE_KINDS,
  isBlockKind,
  isInlineKind,
  MAX_LIST_DEPTH,
  MEDIA_SIZE_HINTS,
  TEXT_MARKS,
  type TextMark,
  type Block,
  type Inline,
} from './content-body.js';

const MODULE_SOURCE = readFileSync(fileURLToPath(new URL('./content-body.ts', import.meta.url)), 'utf8');

function text(value: string, marks: readonly TextMark[] = []): Inline {
  return { kind: 'TEXT', value, marks };
}

function paragraph(...inlines: Inline[]): Block {
  return { kind: 'PARAGRAPH', inlines };
}

const MATH: Block = {
  kind: 'MATH_BLOCK',
  latex: '\\frac{1}{2}mv^2',
  textAlternative: 'one half m v squared',
};

const CHEM: Block = {
  kind: 'CHEM_BLOCK',
  notation: '2H2 + O2 -> 2H2O',
  textAlternative: 'two H two plus O two yields two H two O',
};

describe('the vocabulary', () => {
  it('is the closed set of six block kinds', () => {
    expect([...BLOCK_KINDS]).toEqual([
      'PARAGRAPH',
      'MATH_BLOCK',
      'CHEM_BLOCK',
      'MEDIA_BLOCK',
      'LIST',
      'TABLE',
    ]);
  });

  it('is the closed set of four inline kinds', () => {
    expect([...INLINE_KINDS]).toEqual(['TEXT', 'MATH_INLINE', 'CHEM_INLINE', 'MEDIA_REF']);
  });

  it('recognises each block kind and rejects anything else', () => {
    for (const kind of BLOCK_KINDS) expect(isBlockKind(kind)).toBe(true);
    expect(isBlockKind('HTML')).toBe(false);
  });

  it('recognises each inline kind and rejects anything else', () => {
    for (const kind of INLINE_KINDS) expect(isInlineKind(kind)).toBe(true);
    expect(isInlineKind('RAW')).toBe(false);
  });

  it('carries the schema version on every document it builds', () => {
    const body = expectValue(createContentBody([paragraph(text('a stem'))]));
    expect(body.schemaVersion).toBe(CONTENT_BODY_SCHEMA_VERSION);
  });

  // INV-14: no representation in the model is rendered or an image of text.
  // A field named for a rendering is how that gets in.
  it('declares no field that could hold rendered markup or an image of text', () => {
    expect(MODULE_SOURCE).not.toMatch(/readonly\s+(html|rendered|svg|imageUrl|markup)\b/iu);
  });
});

describe('every node kind constructs', () => {
  it('builds a paragraph of text', () => {
    const body = expectValue(createContentBody([paragraph(text('A block slides down a ramp.'))]));
    expect(body.blocks).toHaveLength(1);
  });

  it('builds a math block', () => {
    expect(expectValue(createContentBody([MATH])).blocks[0]).toMatchObject({ kind: 'MATH_BLOCK' });
  });

  it('builds a chem block', () => {
    expect(expectValue(createContentBody([CHEM])).blocks[0]).toMatchObject({ kind: 'CHEM_BLOCK' });
  });

  it('builds inline math inside a paragraph', () => {
    const inline: Inline = { kind: 'MATH_INLINE', latex: 'v_0', textAlternative: 'v naught' };
    expect(expectValue(createContentBody([paragraph(text('the speed '), inline)])).blocks).toHaveLength(1);
  });

  it('builds inline chemistry inside a paragraph', () => {
    const inline: Inline = { kind: 'CHEM_INLINE', notation: 'H2SO4', textAlternative: 'sulfuric acid' };
    expect(expectValue(createContentBody([paragraph(inline)])).blocks).toHaveLength(1);
  });

  it('builds a media block with a caption', () => {
    const block: Block = {
      kind: 'MEDIA_BLOCK',
      assetVersionId: 'asset-1',
      sizeHint: 'FULL_WIDTH',
      caption: [text('Figure 1')],
    };
    expect(expectValue(createContentBody([block])).blocks[0]).toMatchObject({ kind: 'MEDIA_BLOCK' });
  });

  it('builds a media block without a caption', () => {
    const block: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'asset-1', sizeHint: 'INLINE' };
    expect(Object.hasOwn(expectValue(createContentBody([block])).blocks[0] as object, 'caption')).toBe(false);
  });

  it('builds an inline media reference, with and without an alt-text override', () => {
    const plain: Inline = { kind: 'MEDIA_REF', assetVersionId: 'asset-1' };
    const overridden: Inline = { kind: 'MEDIA_REF', assetVersionId: 'asset-2', altTextOverride: 'a ramp' };
    expect(expectValue(createContentBody([paragraph(plain, overridden)])).blocks).toHaveLength(1);
  });

  it('builds an ordered and an unordered list', () => {
    for (const ordered of [true, false]) {
      const list: Block = { kind: 'LIST', ordered, items: [[paragraph(text('first'))]] };
      expect(expectValue(createContentBody([list])).blocks[0]).toMatchObject({ kind: 'LIST', ordered });
    }
  });

  it('builds a table', () => {
    const table: Block = {
      kind: 'TABLE',
      header: [[text('Element')], [text('Symbol')]],
      rows: [[[text('Sodium')], [text('Na')]]],
    };
    expect(expectValue(createContentBody([table])).blocks[0]).toMatchObject({ kind: 'TABLE' });
  });

  it('accepts every text mark', () => {
    for (const mark of TEXT_MARKS) {
      const marked: Inline = { kind: 'TEXT', value: 'x', marks: [mark] };
      expect(expectValue(createContentBody([paragraph(marked)])).blocks).toHaveLength(1);
    }
  });

  it('accepts every media size hint', () => {
    for (const sizeHint of MEDIA_SIZE_HINTS) {
      const block: Block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a', sizeHint };
      expect(expectValue(createContentBody([block])).blocks).toHaveLength(1);
    }
  });
});

describe('the closed vocabulary refuses what it does not know', () => {
  it('rejects an unknown block kind rather than passing it through', () => {
    const rogue = { kind: 'HTML_BLOCK', html: '<p>hi</p>' } as unknown as Block;
    expect(expectError(createContentBody([rogue])).code).toBe('BLOCK_KIND_UNKNOWN');
  });

  it('rejects an unknown inline kind rather than dropping it', () => {
    const rogue = { kind: 'RAW', value: '<b>hi</b>' } as unknown as Inline;
    expect(expectError(createContentBody([paragraph(rogue)])).code).toBe('INLINE_KIND_UNKNOWN');
  });

  it('rejects an unknown text mark', () => {
    const marked = { kind: 'TEXT', value: 'x', marks: ['BLINK'] } as unknown as Inline;
    expect(expectError(createContentBody([paragraph(marked)])).code).toBe('TEXT_MARK_UNKNOWN');
  });

  it('rejects an unknown media size hint', () => {
    const block = { kind: 'MEDIA_BLOCK', assetVersionId: 'a', sizeHint: 'HUGE' } as unknown as Block;
    expect(expectError(createContentBody([block])).code).toBe('MEDIA_SIZE_HINT_UNKNOWN');
  });
});

describe('notation requires an authored text alternative (ACC-02)', () => {
  const cases: readonly (readonly [string, (alternative: string) => Block | Inline, 'block' | 'inline'])[] = [
    ['MATH_BLOCK', (alt) => ({ kind: 'MATH_BLOCK', latex: 'x^2', textAlternative: alt }), 'block'],
    ['CHEM_BLOCK', (alt) => ({ kind: 'CHEM_BLOCK', notation: 'H2O', textAlternative: alt }), 'block'],
    ['MATH_INLINE', (alt) => ({ kind: 'MATH_INLINE', latex: 'x^2', textAlternative: alt }), 'inline'],
    ['CHEM_INLINE', (alt) => ({ kind: 'CHEM_INLINE', notation: 'H2O', textAlternative: alt }), 'inline'],
  ];

  function bodyWith(node: Block | Inline, position: 'block' | 'inline') {
    return position === 'block'
      ? createContentBody([node as Block])
      : createContentBody([paragraph(node as Inline)]);
  }

  for (const [kind, build, position] of cases) {
    it(`rejects a ${kind} with no text alternative`, () => {
      expect(expectError(bodyWith(build(''), position)).code).toBe('TEXT_ALTERNATIVE_REQUIRED');
    });

    it(`rejects a ${kind} whose text alternative is whitespace`, () => {
      expect(expectError(bodyWith(build('   '), position)).code).toBe('TEXT_ALTERNATIVE_REQUIRED');
    });

    it(`accepts a ${kind} with an authored text alternative`, () => {
      expect(expectValue(bodyWith(build('x squared'), position)).blocks).toHaveLength(1);
    });
  }

  it('rejects notation with no notation content', () => {
    expect(
      expectError(createContentBody([{ kind: 'MATH_BLOCK', latex: '  ', textAlternative: 'nothing' }])).code,
    ).toBe('NOTATION_EMPTY');
  });

  it('rejects inline notation with no notation content', () => {
    const inline: Inline = { kind: 'CHEM_INLINE', notation: '', textAlternative: 'nothing' };
    expect(expectError(createContentBody([paragraph(inline)])).code).toBe('NOTATION_EMPTY');
  });
});

describe('rendered markup is refused (INV-14)', () => {
  it.each([
    ['an element', 'x<sup>2</sup>'],
    ['a self-closing element', 'a line<br/>and another'],
    ['a named entity', 'a &amp; b'],
    ['a numeric entity', 'a &#8722; b'],
  ])('rejects a text value carrying %s', (_label, value) => {
    expect(expectError(createContentBody([paragraph(text(value))])).code).toBe('RENDERED_MARKUP_PRESENT');
  });

  it('permits a bare comparison operator, which is not markup', () => {
    expect(expectValue(createContentBody([paragraph(text('given that a < b and b > c'))])).blocks).toHaveLength(1);
  });
});

describe('structural validation', () => {
  it('rejects a document with no blocks', () => {
    expect(expectError(createContentBody([])).code).toBe('BODY_EMPTY');
  });

  it('rejects a paragraph with no inlines', () => {
    expect(expectError(createContentBody([paragraph()])).code).toBe('PARAGRAPH_EMPTY');
  });

  it('rejects a blank text value', () => {
    expect(expectError(createContentBody([paragraph(text('   '))])).code).toBe('TEXT_VALUE_EMPTY');
  });

  it('rejects a media block with no asset reference', () => {
    const block: Block = { kind: 'MEDIA_BLOCK', assetVersionId: '', sizeHint: 'INLINE' };
    expect(expectError(createContentBody([block])).code).toBe('MEDIA_REFERENCE_EMPTY');
  });

  it('rejects an inline media reference with no asset reference', () => {
    const inline: Inline = { kind: 'MEDIA_REF', assetVersionId: '  ' };
    expect(expectError(createContentBody([paragraph(inline)])).code).toBe('MEDIA_REFERENCE_EMPTY');
  });

  it('rejects a list with no items', () => {
    expect(expectError(createContentBody([{ kind: 'LIST', ordered: false, items: [] }])).code).toBe('LIST_EMPTY');
  });

  it('rejects a list item with no blocks', () => {
    const list: Block = { kind: 'LIST', ordered: false, items: [[]] };
    expect(expectError(createContentBody([list])).code).toBe('LIST_ITEM_EMPTY');
  });

  it('validates blocks nested inside a list item', () => {
    const list: Block = { kind: 'LIST', ordered: true, items: [[paragraph()]] };
    expect(expectError(createContentBody([list])).code).toBe('PARAGRAPH_EMPTY');
  });

  it(`accepts a list nested ${MAX_LIST_DEPTH} deep`, () => {
    let list: Block = { kind: 'LIST', ordered: false, items: [[paragraph(text('leaf'))]] };
    for (let depth = 1; depth < MAX_LIST_DEPTH; depth += 1) {
      list = { kind: 'LIST', ordered: false, items: [[list]] };
    }
    expect(expectValue(createContentBody([list])).blocks).toHaveLength(1);
  });

  it(`rejects a list nested ${MAX_LIST_DEPTH + 1} deep`, () => {
    let list: Block = { kind: 'LIST', ordered: false, items: [[paragraph(text('leaf'))]] };
    for (let depth = 0; depth < MAX_LIST_DEPTH; depth += 1) {
      list = { kind: 'LIST', ordered: false, items: [[list]] };
    }
    expect(expectError(createContentBody([list])).code).toBe('LIST_NESTING_TOO_DEEP');
  });

  it('rejects a table with no header', () => {
    const table: Block = { kind: 'TABLE', header: [], rows: [[[text('a')]]] };
    expect(expectError(createContentBody([table])).code).toBe('TABLE_HEADER_EMPTY');
  });

  it('rejects a table with no body rows', () => {
    const table: Block = { kind: 'TABLE', header: [[text('a')]], rows: [] };
    expect(expectError(createContentBody([table])).code).toBe('TABLE_ROWS_EMPTY');
  });

  it('rejects a ragged table row, naming the row', () => {
    const table: Block = {
      kind: 'TABLE',
      header: [[text('a')], [text('b')]],
      rows: [[[text('1')], [text('2')]], [[text('3')]]],
    };
    const failure = expectError(createContentBody([table]));
    expect(failure.code).toBe('TABLE_ROW_RAGGED');
    expect(failure.location).toBe('blocks[0].rows[1]');
  });

  it('validates inlines inside a header cell', () => {
    const table: Block = { kind: 'TABLE', header: [[text('  ')]], rows: [[[text('a')]]] };
    expect(expectError(createContentBody([table])).code).toBe('TEXT_VALUE_EMPTY');
  });

  it('validates inlines inside a body cell', () => {
    const table: Block = { kind: 'TABLE', header: [[text('a')]], rows: [[[text('  ')]]] };
    expect(expectError(createContentBody([table])).code).toBe('TEXT_VALUE_EMPTY');
  });

  it('validates inlines inside a media caption', () => {
    const block: Block = {
      kind: 'MEDIA_BLOCK',
      assetVersionId: 'a',
      sizeHint: 'INLINE',
      caption: [text('   ')],
    };
    expect(expectError(createContentBody([block])).code).toBe('TEXT_VALUE_EMPTY');
  });
});

describe('failures name where the problem is', () => {
  it('names the offending top-level block', () => {
    const failure = expectError(createContentBody([paragraph(text('fine')), paragraph()]));
    expect(failure.location).toBe('blocks[1]');
  });

  it('names the offending inline inside a paragraph', () => {
    const failure = expectError(createContentBody([paragraph(text('fine'), text('  '))]));
    expect(failure.location).toBe('blocks[0].inlines[1]');
  });

  it('names the offending block inside a nested list item', () => {
    const list: Block = { kind: 'LIST', ordered: false, items: [[paragraph(text('a'))], [paragraph()]] };
    expect(expectError(createContentBody([list])).location).toBe('blocks[0].items[1].blocks[0]');
  });

  it('names the offending cell inside a table row', () => {
    const table: Block = {
      kind: 'TABLE',
      header: [[text('a')], [text('b')]],
      rows: [[[text('1')], [text('  ')]]],
    };
    expect(expectError(createContentBody([table])).location).toBe('blocks[0].rows[0][1].inlines[0]');
  });
});

describe('immutability', () => {
  it('freezes the document and its block list', () => {
    const body = expectValue(createContentBody([paragraph(text('a'))]));
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body.blocks)).toBe(true);
  });

  it('freezes nested inlines and their marks', () => {
    const body = expectValue(createContentBody([paragraph({ kind: 'TEXT', value: 'a', marks: ['BOLD'] })]));
    const block = body.blocks[0] as { inlines: readonly { marks: readonly string[] }[] };
    expect(Object.isFrozen(block.inlines[0])).toBe(true);
    expect(Object.isFrozen(block.inlines[0]?.marks)).toBe(true);
  });

  it('freezes list items and the blocks inside them', () => {
    const list: Block = { kind: 'LIST', ordered: true, items: [[paragraph(text('a'))]] };
    const body = expectValue(createContentBody([list]));
    const built = body.blocks[0] as { items: readonly (readonly object[])[] };
    expect(Object.isFrozen(built.items)).toBe(true);
    expect(Object.isFrozen(built.items[0])).toBe(true);
    expect(Object.isFrozen(built.items[0]?.[0])).toBe(true);
  });

  it('freezes table header and body cells', () => {
    const table: Block = { kind: 'TABLE', header: [[text('a')]], rows: [[[text('1')]]] };
    const built = expectValue(createContentBody([table])).blocks[0] as {
      header: readonly (readonly object[])[];
      rows: readonly (readonly (readonly object[])[])[];
    };
    expect(Object.isFrozen(built.header[0])).toBe(true);
    expect(Object.isFrozen(built.rows[0])).toBe(true);
    expect(Object.isFrozen(built.rows[0]?.[0])).toBe(true);
  });

  it('freezes math and chem blocks', () => {
    const body = expectValue(createContentBody([MATH, CHEM]));
    expect(Object.isFrozen(body.blocks[0])).toBe(true);
    expect(Object.isFrozen(body.blocks[1])).toBe(true);
  });

  it('does not alias the caller’s array', () => {
    const blocks: Block[] = [paragraph(text('a'))];
    const body = expectValue(createContentBody(blocks));
    blocks.push(paragraph(text('smuggled')));
    expect(body.blocks).toHaveLength(1);
  });
});
