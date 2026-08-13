import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { accessibilityViolations } from './testing/accessibility.js';
import { ContentRenderer, type MediaResolution, type RenderIssue } from './content-renderer.js';
import { BLOCK_KINDS, INLINE_KINDS, type Block, type ContentBody } from './content-body.js';
import { SURFACE_PROFILES, MINIMUM_DEVICE_PROFILE, type SurfaceProfile } from './surface-profile.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function body(...blocks: Block[]): ContentBody {
  return { schemaVersion: 1, blocks };
}

const MEDIA: Readonly<Record<string, MediaResolution>> = {
  'asset-1': {
    src: 'https://cdn.example/ramp.png',
    altText: 'A block on a ramp inclined at thirty degrees',
    longDescription: 'The ramp rises left to right at 30°, with weight and normal-force arrows.',
  },
  'asset-2': { src: 'https://cdn.example/plain.png', altText: 'A trolley on a track' },
};

const resolveMedia = (id: string): MediaResolution | undefined => MEDIA[id];

/** One document covering every node kind, so the enumeration below is real. */
const EVERY_NODE: ContentBody = body(
  {
    kind: 'PARAGRAPH',
    inlines: [
      { kind: 'TEXT', value: 'A block slides down a ramp', marks: ['BOLD', 'ITALIC'] },
      { kind: 'MATH_INLINE', latex: 'v^2', textAlternative: 'v squared' },
      { kind: 'CHEM_INLINE', notation: 'H2O', textAlternative: 'water' },
      { kind: 'MEDIA_REF', assetVersionId: 'asset-2', altTextOverride: 'a trolley' },
    ],
  },
  { kind: 'MATH_BLOCK', latex: 'a = g\\sin\\theta', textAlternative: 'a equals g sine theta' },
  { kind: 'CHEM_BLOCK', notation: '2H2 + O2 -> 2H2O', textAlternative: 'hydrogen burns in oxygen' },
  { kind: 'MEDIA_BLOCK', assetVersionId: 'asset-1', caption: 'Figure 1', sizeHint: 'FULL_WIDTH' },
  {
    kind: 'LIST',
    ordered: true,
    items: [[{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'first', marks: [] }] }]],
  },
  {
    kind: 'TABLE',
    header: [[{ kind: 'TEXT', value: 'time', marks: [] }]],
    rows: [[[{ kind: 'TEXT', value: '0', marks: [] }]]],
  },
);

describe('every node kind renders, on every surface profile', () => {
  it.each(SURFACE_PROFILES)('renders the whole vocabulary on %s', (surface: SurfaceProfile) => {
    const issues: RenderIssue[] = [];
    const { container } = render(
      <ContentRenderer
        body={EVERY_NODE}
        surface={surface}
        resolveMedia={resolveMedia}
        onIssue={(issue) => issues.push(issue)}
      />,
    );

    expect(issues).toEqual([]);
    expect(container.querySelector('p')).not.toBeNull();
    expect(container.querySelectorAll('[role="math"]')).toHaveLength(4);
    expect(container.querySelector('figure')).not.toBeNull();
    expect(container.querySelector('ol')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('[data-surface]')?.getAttribute('data-surface')).toBe(surface);
  });

  // The enumeration is asserted against the vocabulary rather than counted by
  // hand, so a kind added to `BLOCK_KINDS` without a fixture fails here.
  it('covers every declared block kind in the fixture', () => {
    expect(EVERY_NODE.blocks.map((block) => block.kind).sort()).toEqual([...BLOCK_KINDS].sort());
  });

  it('covers every declared inline kind in the fixture', () => {
    const paragraph = EVERY_NODE.blocks[0]!;
    const kinds = paragraph.kind === 'PARAGRAPH' ? paragraph.inlines.map((inline) => inline.kind) : [];
    expect([...kinds].sort()).toEqual([...INLINE_KINDS].sort());
  });
});

describe('semantic HTML, not a pile of divs', () => {
  it('renders marks as real elements, nested outermost-first', () => {
    const { container } = render(
      <ContentRenderer
        body={body({
          kind: 'PARAGRAPH',
          inlines: [{ kind: 'TEXT', value: 'x', marks: ['BOLD', 'SUBSCRIPT'] }],
        })}
        surface="web"
      />,
    );
    expect(container.querySelector('strong > sub')?.textContent).toBe('x');
  });

  it('gives a table real header cells with a scope', () => {
    render(
      <ContentRenderer
        body={body({
          kind: 'TABLE',
          header: [[{ kind: 'TEXT', value: 'time', marks: [] }]],
          rows: [[[{ kind: 'TEXT', value: '0', marks: [] }]]],
        })}
        surface="web"
      />,
    );
    const header = screen.getByRole('columnheader', { name: 'time' });
    expect(header.getAttribute('scope')).toBe('col');
  });

  it('renders an ordered list as ol and an unordered one as ul', () => {
    const item: Block[] = [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'a', marks: [] }] }];
    const ordered = render(
      <ContentRenderer body={body({ kind: 'LIST', ordered: true, items: [item] })} surface="web" />,
    );
    expect(ordered.container.querySelector('ol')).not.toBeNull();

    const unordered = render(
      <ContentRenderer body={body({ kind: 'LIST', ordered: false, items: [item] })} surface="web" />,
    );
    expect(unordered.container.querySelector('ul')).not.toBeNull();
  });

  it('associates a caption and a long description with the figure', () => {
    const { container } = render(
      <ContentRenderer
        body={body({
          kind: 'MEDIA_BLOCK',
          assetVersionId: 'asset-1',
          caption: 'Figure 1',
          sizeHint: 'HALF_WIDTH',
        })}
        surface="web"
        resolveMedia={resolveMedia}
      />,
    );
    const figure = container.querySelector('figure')!;
    expect(within(figure).getByRole('img').getAttribute('alt')).toBe(MEDIA['asset-1']!.altText);
    expect(figure.querySelector('figcaption')?.textContent).toBe('Figure 1');
    const describedBy = within(figure).getByRole('img').getAttribute('aria-describedby');
    expect(figure.querySelector(`#${CSS.escape(describedBy!)}`)?.textContent).toContain('30°');
  });

  it('omits the long description when the asset has none', () => {
    const { container } = render(
      <ContentRenderer
        body={body({ kind: 'MEDIA_BLOCK', assetVersionId: 'asset-2', sizeHint: 'INLINE' })}
        surface="web"
        resolveMedia={resolveMedia}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('aria-describedby')).toBeNull();
    expect(container.querySelector('figcaption')).toBeNull();
  });
});

describe('notation carries the authored alternative as its accessible name (ACC-02)', () => {
  it('labels a maths node with the alternative, never the LaTeX', () => {
    render(
      <ContentRenderer
        body={body({
          kind: 'MATH_BLOCK',
          latex: '\\frac{1}{2}mv^2',
          textAlternative: 'one half m v squared',
        })}
        surface="web"
      />,
    );
    const node = screen.getByRole('math', { name: 'one half m v squared' });
    // The MathML is hidden from assistive technology, because a structural
    // reading — "fraction one over two" — is not the sentence the author
    // wrote. One reading, not two competing ones.
    const mathml = node.querySelector('math')!;
    expect(mathml.getAttribute('aria-hidden')).toBe('true');
    expect(mathml.querySelector('mfrac')).not.toBeNull();
  });

  it('labels a chemical node the same way', () => {
    render(
      <ContentRenderer
        body={body({ kind: 'CHEM_BLOCK', notation: 'H2SO4', textAlternative: 'sulfuric acid' })}
        surface="web"
      />,
    );
    expect(screen.getByRole('math', { name: 'sulfuric acid' })).toBeInTheDocument();
  });

  it('gives a long expression its own scroll container, so the body never scrolls', () => {
    const { container } = render(
      <ContentRenderer
        body={body({ kind: 'MATH_BLOCK', latex: 'x'.repeat(400), textAlternative: 'a long expression' })}
        surface="mobile"
      />,
    );
    expect(container.querySelector('[role="math"]')?.getAttribute('style')).toContain('overflow-x: auto');
  });
});

describe('an unknown node degrades visibly and reports itself', () => {
  it('renders a labelled fallback for an unknown block kind, and does not throw', () => {
    const issues: RenderIssue[] = [];
    const unknown = { kind: 'HOLOGRAM', payload: 'x' } as unknown as Block;

    expect(() =>
      render(
        <ContentRenderer body={body(unknown)} surface="web" onIssue={(issue) => issues.push(issue)} />,
      ),
    ).not.toThrow();

    expect(screen.getByRole('note')).toHaveTextContent('Unsupported content');
    expect(issues).toEqual([
      { code: 'UNKNOWN_BLOCK_KIND', location: 'blocks[0]', message: 'unknown block kind "HOLOGRAM"' },
    ]);
  });

  it('does the same for an unknown inline kind, naming where it was', () => {
    const issues: RenderIssue[] = [];
    render(
      <ContentRenderer
        body={body({
          kind: 'PARAGRAPH',
          inlines: [{ kind: 'EMOJI' } as never],
        })}
        surface="web"
        onIssue={(issue) => issues.push(issue)}
      />,
    );

    expect(issues[0]).toMatchObject({
      code: 'UNKNOWN_INLINE_KIND',
      location: 'blocks[0].inlines[0]',
    });
    // A `span`, not a `div`: an inline fallback inside a `p` must not close
    // the paragraph, or the degradation breaks the page it exists to save.
    expect(screen.getByRole('note').tagName).toBe('SPAN');
  });

  // A dropped node is worse than a visible one: an item that asks about a
  // figure the student cannot see is a mark nobody can defend.
  it('never renders nothing', () => {
    const { container } = render(
      <ContentRenderer body={body({ kind: 'WORMHOLE' } as unknown as Block)} surface="print" />,
    );
    expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('reports an unresolved figure and still renders an affordance', () => {
    const issues: RenderIssue[] = [];
    render(
      <ContentRenderer
        body={body({ kind: 'MEDIA_BLOCK', assetVersionId: 'missing', caption: 'Figure 4', sizeHint: 'FULL_WIDTH' })}
        surface="web"
        onIssue={(issue) => issues.push(issue)}
      />,
    );
    expect(issues[0]?.code).toBe('MEDIA_UNRESOLVED');
    expect(screen.getByRole('note')).toHaveTextContent('Figure unavailable');
  });

  it('reports an unresolved inline reference and still renders its description', () => {
    const issues: RenderIssue[] = [];
    const { container } = render(
      <ContentRenderer
        body={body({
          kind: 'PARAGRAPH',
          inlines: [{ kind: 'MEDIA_REF', assetVersionId: 'missing', altTextOverride: 'a ramp' }],
        })}
        surface="web"
        onIssue={(issue) => issues.push(issue)}
      />,
    );
    expect(issues[0]?.code).toBe('MEDIA_UNRESOLVED');
    expect(container.textContent).toContain('a ramp');
  });

  it('renders without a resolver or a reporter at all', () => {
    expect(() =>
      render(
        <ContentRenderer
          body={body({ kind: 'MEDIA_BLOCK', assetVersionId: 'missing', sizeHint: 'INLINE' })}
          surface="web"
        />,
      ),
    ).not.toThrow();
  });

  it('reports an unresolved inline reference with no override, and renders nothing for it', () => {
    const onIssue = vi.fn();
    const { container } = render(
      <ContentRenderer
        body={body({ kind: 'PARAGRAPH', inlines: [{ kind: 'MEDIA_REF', assetVersionId: 'missing' }] })}
        surface="web"
        onIssue={onIssue}
      />,
    );
    expect(onIssue).toHaveBeenCalledOnce();
    expect(container.querySelector('.qb-media-ref--unresolved')?.textContent).toBe('');
  });
});

describe('the surface is a parameter, not four components (INV-14)', () => {
  it('changes nothing about what a node means', () => {
    const rendered = SURFACE_PROFILES.map((surface) => {
      const { container } = render(
        <ContentRenderer body={EVERY_NODE} surface={surface} resolveMedia={resolveMedia} />,
      );
      // Strip the surface marker, which is the one thing that legitimately
      // differs. What remains must be identical, or M3-38's parity claim is
      // about nothing.
      return container.innerHTML.replaceAll(`qb-content--${surface}`, '').replaceAll(surface, '');
    });
    expect(new Set(rendered).size).toBe(1);
  });

  it('defaults preview to the minimum device profile (FR-QM-14 rule 3)', () => {
    expect(MINIMUM_DEVICE_PROFILE).toBe('mobile');
  });
});

describe('accessibility', () => {
  it('scans clean on a representative document', async () => {
    const { container } = render(
      <ContentRenderer body={EVERY_NODE} surface="web" resolveMedia={resolveMedia} />,
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean on the fallback path too', async () => {
    const { container } = render(
      <ContentRenderer body={body({ kind: 'HOLOGRAM' } as unknown as Block)} surface="web" />,
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

// ── The gates this package carries ──────────────────────────────────────────

function sourceFilesUnder(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'node_modules' || entry === '.git' || entry === 'coverage'
        ? []
        : sourceFilesUnder(path, extensions);
    }
    return extensions.some((extension) => path.endsWith(extension)) && !path.includes('.spec.')
      ? [path]
      : [];
  });
}

describe('F24 / §9 rule 16 — no colour outside the token layer', () => {
  const PACKAGE_SRC = resolve(dirname(fileURLToPath(import.meta.url)));

  it('names no colour literal in any component', () => {
    const offenders = sourceFilesUnder(PACKAGE_SRC, ['.ts', '.tsx'])
      .filter((file) => !file.endsWith('tokens.ts'))
      .filter((file) => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/iu.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('scanned something, so the check is not vacuous', () => {
    expect(sourceFilesUnder(PACKAGE_SRC, ['.tsx']).length).toBeGreaterThan(0);
  });

  it('emits colours as custom properties only', () => {
    const source = readFileSync(join(PACKAGE_SRC, 'content-renderer.tsx'), 'utf8');
    for (const match of source.matchAll(/color:\s*([^,\n}]+)/gu)) {
      expect(match[1], match[0]).toContain('TOKENS.');
    }
  });
});

describe('F19 — the package imports neither application', () => {
  it('reaches no app from any source file', () => {
    const offenders = sourceFilesUnder(join(REPO_ROOT, 'packages/content-renderer/src'), ['.ts', '.tsx'])
      .filter((file) => /from '[^']*apps\/(learn|studio|api)/u.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

/**
 * **F20 itself moved to `apps/api/src/fitness/content-rules.ts` at M3-44**,
 * where the milestone's gates live and where it is proven against a committed
 * planted second implementation. Two copies of the *check* would have been the
 * same mistake the rule is about — and the planted fixture lives under
 * `apps/`, so a second unexempted scan finds it and fails.
 *
 * What stays here is the package's own half: this file declares the one
 * implementation, and F19 keeps the dependency pointing one way.
 */
describe('F20 — this package declares the one ContentRenderer', () => {
  it('declares it exactly once in its own source', () => {
    const declarations = sourceFilesUnder(
      join(REPO_ROOT, 'packages/content-renderer/src'),
      ['.ts', '.tsx'],
    ).filter((file) =>
      /export (?:function|const|class) ContentRenderer\b/u.test(readFileSync(file, 'utf8')),
    );

    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain('packages/content-renderer/src/content-renderer.tsx');
  });

  it('scanned its own source, so an empty result would not pass as one', () => {
    const scanned = sourceFilesUnder(join(REPO_ROOT, 'packages/content-renderer/src'), [
      '.ts',
      '.tsx',
    ]);
    expect(scanned.length).toBeGreaterThan(5);
  });
});
