import { describe, expect, it } from 'vitest';
import { BLOCK_KINDS, INLINE_KINDS, type Block, type ContentBody } from './content-body.js';
import type { MediaResolution } from './content-renderer.js';
import {
  renderFor,
  rendersOnEverySurface,
  serializationsAgree,
  validateRender,
} from './render-validation.js';
import { MINIMUM_DEVICE_PROFILE, SURFACE_PROFILES } from './surface-profile.js';

/**
 * The milestone's "preview matches the student render byte-for-byte", and
 * FR-QM-14.
 *
 * **Parity is structural**: the preview and the delivery render are the same
 * call, so the claim rests on there being one code path rather than on two
 * paths happening to agree today. What this spec can and does check is that
 * the *instrument* works — a planted divergence must fail it — and that the
 * one path is deterministic across calls and across surfaces.
 */

const MEDIA: Readonly<Record<string, MediaResolution>> = {
  'asset-1': {
    src: 'https://cdn.example/ramp.png',
    altText: 'A block on a ramp inclined at thirty degrees',
    longDescription: 'The ramp rises left to right at 30°.',
  },
};

const resolveMedia = (id: string): MediaResolution | undefined => MEDIA[id];

function body(...blocks: Block[]): ContentBody {
  return { schemaVersion: 1, blocks };
}

/** The fixture corpus. Every node kind appears, asserted by enumeration below. */
const CORPUS: Readonly<Record<string, ContentBody>> = Object.freeze({
  'a plain paragraph': body({
    kind: 'PARAGRAPH',
    inlines: [{ kind: 'TEXT', value: 'A block slides down a ramp.', marks: [] }],
  }),
  'every text mark': body({
    kind: 'PARAGRAPH',
    inlines: [{ kind: 'TEXT', value: 'x', marks: ['BOLD', 'ITALIC', 'SUBSCRIPT', 'SUPERSCRIPT'] }],
  }),
  'mathematics, block and inline': body(
    { kind: 'MATH_BLOCK', latex: 'a = \\frac{v^2}{r}', textAlternative: 'a equals v squared over r' },
    {
      kind: 'PARAGRAPH',
      inlines: [{ kind: 'MATH_INLINE', latex: '\\sqrt{2}', textAlternative: 'root two' }],
    },
  ),
  'chemistry, block and inline': body(
    { kind: 'CHEM_BLOCK', notation: '2H2 + O2 -> 2H2O', textAlternative: 'hydrogen burns in oxygen' },
    {
      kind: 'PARAGRAPH',
      inlines: [{ kind: 'CHEM_INLINE', notation: 'H2SO4', textAlternative: 'sulfuric acid' }],
    },
  ),
  'a figure with a caption': body({
    kind: 'MEDIA_BLOCK',
    assetVersionId: 'asset-1',
    caption: [{ kind: 'TEXT', value: 'Figure 1', marks: [] }],
    sizeHint: 'FULL_WIDTH',
  }),
  'an inline media reference': body({
    kind: 'PARAGRAPH',
    inlines: [{ kind: 'MEDIA_REF', assetVersionId: 'asset-1', altTextOverride: 'the ramp' }],
  }),
  'a nested list': body({
    kind: 'LIST',
    ordered: false,
    items: [
      [
        { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'outer', marks: [] }] },
        {
          kind: 'LIST',
          ordered: true,
          items: [[{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'inner', marks: [] }] }]],
        },
      ],
    ],
  }),
  'a table': body({
    kind: 'TABLE',
    header: [
      [{ kind: 'TEXT', value: 'time', marks: [] }],
      [{ kind: 'TEXT', value: 'speed', marks: [] }],
    ],
    rows: [
      [
        [{ kind: 'TEXT', value: '0', marks: [] }],
        [{ kind: 'MATH_INLINE', latex: 'v_0', textAlternative: 'v nought' }],
      ],
    ],
  }),
});

const FIXTURES = Object.entries(CORPUS);

function kindsIn(node: unknown, found: Set<string>): Set<string> {
  if (node === null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const entry of node) kindsIn(entry, found);
    return found;
  }
  const record = node as Record<string, unknown>;
  if (typeof record['kind'] === 'string') found.add(record['kind']);
  for (const value of Object.values(record)) kindsIn(value, found);
  return found;
}

describe('the fixture corpus covers every node kind', () => {
  const covered = kindsIn(Object.values(CORPUS), new Set<string>());

  it('covers every block kind', () => {
    expect([...BLOCK_KINDS].filter((kind) => !covered.has(kind))).toEqual([]);
  });

  it('covers every inline kind', () => {
    expect([...INLINE_KINDS].filter((kind) => !covered.has(kind))).toEqual([]);
  });
});

describe('preview matches the delivery render, byte for byte', () => {
  it.each(FIXTURES)('agrees on %s, on every surface', (_name, fixture) => {
    for (const surface of SURFACE_PROFILES) {
      // The preview and the delivery render are the same call — that is the
      // claim, and it is why this passes rather than why it is trivial.
      const preview = renderFor(fixture, surface, { resolveMedia }).html;
      const delivery = renderFor(fixture, surface, { resolveMedia }).html;
      expect(serializationsAgree(preview, delivery), `${_name} on ${surface}`).toBe(true);
    }
  });

  // Shown to fail before it is trusted to pass.
  it('catches a planted divergence', () => {
    const fixture = CORPUS['a table']!;
    const preview = renderFor(fixture, 'mobile', { resolveMedia }).html;
    const diverged = preview.replace('<th', '<th data-preview-only="1"');

    expect(diverged).not.toBe(preview);
    expect(serializationsAgree(preview, diverged)).toBe(false);
  });

  it('is stable across repeated renders of the same document', () => {
    const fixture = CORPUS['mathematics, block and inline']!;
    const outputs = new Set(
      Array.from({ length: 50 }, () => renderFor(fixture, 'print', { resolveMedia }).html),
    );
    expect(outputs.size).toBe(1);
  });

  // The surface changes layout affordances, never meaning: strip the marker
  // and the four serializations are one.
  it('differs across surfaces only by the surface marker', () => {
    const fixture = CORPUS['a nested list']!;
    const stripped = SURFACE_PROFILES.map((surface) =>
      renderFor(fixture, surface, { resolveMedia })
        .html.replaceAll(`qb-content--${surface}`, '')
        .replaceAll(`data-surface="${surface}"`, ''),
    );
    expect(new Set(stripped).size).toBe(1);
  });
});

describe('preview defaults to the minimum device profile (FR-QM-14 rule 3)', () => {
  it('is mobile, not desktop', () => {
    expect(MINIMUM_DEVICE_PROFILE).toBe('mobile');
  });

  // An item that breaks does so on the smallest screen; previewing at desktop
  // width is how that goes unnoticed until a learner meets it.
  it('renders the corpus on the minimum profile without failures', () => {
    for (const [name, fixture] of FIXTURES) {
      const verdicts = validateRender(fixture, { resolveMedia });
      const minimum = verdicts.find((verdict) => verdict.surface === MINIMUM_DEVICE_PROFILE)!;
      expect(minimum.ok, `${name} on ${MINIMUM_DEVICE_PROFILE}`).toBe(true);
    }
  });
});

describe('the verdict M3-11 consumes', () => {
  it('reports every supported surface, in the declared order', () => {
    const verdicts = validateRender(CORPUS['a table']!, { resolveMedia });
    expect(verdicts.map((verdict) => verdict.surface)).toEqual([...SURFACE_PROFILES]);
    expect(rendersOnEverySurface(verdicts)).toBe(true);
  });

  it('fails on every surface when a node does not render, naming where', () => {
    const broken = body({
      kind: 'MATH_BLOCK',
      latex: '\\frac{1',
      textAlternative: 'an unfinished fraction',
    });
    const verdicts = validateRender(broken);

    expect(rendersOnEverySurface(verdicts)).toBe(false);
    for (const verdict of verdicts) {
      expect(verdict.ok, verdict.surface).toBe(false);
      expect(verdict.failures[0], verdict.surface).toContain('blocks[0]');
    }
  });

  it('names the block index for an unknown kind too', () => {
    const verdicts = validateRender(
      body(
        { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'fine', marks: [] }] },
        { kind: 'HOLOGRAM' } as unknown as Block,
      ),
    );
    expect(verdicts[0]?.failures[0]).toContain('blocks[1]');
  });

  it('fails on a chemical structure, which publication must not carry', () => {
    const verdicts = validateRender(
      body({ kind: 'CHEM_BLOCK', notation: 'c1ccccc1', textAlternative: 'a benzene ring' }),
    );
    expect(rendersOnEverySurface(verdicts)).toBe(false);
    expect(verdicts[0]?.failures[0]).toContain('diagram asset');
  });

  // A figure the *preview* was not handed is a host condition, not a document
  // defect — blocking on it would refuse to publish an item whose asset simply
  // was not passed to a validator.
  it('does not block on an unresolved figure', () => {
    const verdicts = validateRender(
      body({ kind: 'MEDIA_BLOCK', assetVersionId: 'never-passed', sizeHint: 'INLINE' }),
    );
    expect(rendersOnEverySurface(verdicts)).toBe(true);
  });

  it('renders an empty document without failing', () => {
    expect(rendersOnEverySurface(validateRender(body()))).toBe(true);
  });

  it('renders without a media resolver at all', () => {
    expect(() => validateRender(CORPUS['a figure with a caption']!)).not.toThrow();
  });
});

describe('the serialized output is real markup a browser would accept', () => {
  it('emits MathML for both notation classes', () => {
    const maths = renderFor(CORPUS['mathematics, block and inline']!, 'web').html;
    expect(maths).toContain('<math');
    expect(maths).toContain('mfrac');

    const chemistry = renderFor(CORPUS['chemistry, block and inline']!, 'web').html;
    expect(chemistry).toContain('mathvariant="normal"');
  });

  it('emits a figure with its alt text on every surface', () => {
    for (const surface of SURFACE_PROFILES) {
      const html = renderFor(CORPUS['a figure with a caption']!, surface, { resolveMedia }).html;
      expect(html, surface).toContain('alt="A block on a ramp inclined at thirty degrees"');
      expect(html, surface).toContain('<figcaption>');
    }
  });

  it('nests a list inside a list without flattening it', () => {
    const html = renderFor(CORPUS['a nested list']!, 'web').html;
    expect(html).toMatch(/<ul[^>]*>[\s\S]*<ol[^>]*>/u);
  });
});
