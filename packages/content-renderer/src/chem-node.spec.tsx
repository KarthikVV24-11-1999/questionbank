import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { accessibilityViolations } from './testing/accessibility.js';
import { chemToMathML } from './chem-to-mathml.js';
import { ChemNode, type ChemNodeIssue } from './chem-node.js';
import { ContentRenderer, type RenderIssue } from './content-renderer.js';
import { SURFACE_PROFILES } from './surface-profile.js';
import type { ContentBody } from './content-body.js';

function chemBody(notation: string, textAlternative: string): ContentBody {
  return { schemaVersion: 1, blocks: [{ kind: 'CHEM_BLOCK', notation, textAlternative }] };
}

describe('each notation class renders through the MathML pipeline', () => {
  it('renders a formula with subscripts', () => {
    const result = chemToMathML('H2O');
    expect(result.ok && result.mathml).toBe(
      '<msub><mi mathvariant="normal">H</mi><mn>2</mn></msub><mi mathvariant="normal">O</mi>',
    );
  });

  it('renders a multi-letter element symbol whole', () => {
    const result = chemToMathML('NaCl');
    expect(result.ok && result.mathml).toBe(
      '<mi mathvariant="normal">Na</mi><mi mathvariant="normal">Cl</mi>',
    );
  });

  it('renders a charge as a superscript', () => {
    const result = chemToMathML('Na+');
    expect(result.ok && result.mathml).toBe('<msup><mi mathvariant="normal">Na</mi><mo>+</mo></msup>');
  });

  // `H2O` and `Ca2+` write digits in the same place and mean opposite things.
  // What disambiguates is whether a sign follows them.
  it('reads digits before a sign as a charge, not a subscript', () => {
    const result = chemToMathML('Ca2+');
    expect(result.ok && result.mathml).toBe(
      '<msup><mi mathvariant="normal">Ca</mi><mo>2+</mo></msup>',
    );
  });

  it('renders a subscript and a charge together, written explicitly', () => {
    const result = chemToMathML('SO4^2-');
    expect(result.ok && result.mathml).toContain('<msubsup>');
    expect(result.ok && result.mathml).toContain('<mn>4</mn>');
    expect(result.ok && result.mathml).toContain('<mo>2-</mo>');
  });

  it('accepts the braced charge form as well', () => {
    const result = chemToMathML('SO4^{2-}');
    expect(result.ok && result.mathml).toContain('<mo>2-</mo>');
  });

  it('renders a stoichiometric coefficient as a number, not an element', () => {
    const result = chemToMathML('2H2');
    expect(result.ok && result.mathml).toBe(
      '<mn>2</mn><msub><mi mathvariant="normal">H</mi><mn>2</mn></msub>',
    );
  });

  it.each([
    ['a state symbol', 'H2O(l)', '<mi mathvariant="normal">l</mi>'],
    ['an aqueous state', 'NaCl(aq)', '<mi mathvariant="normal">aq</mi>'],
    ['a standalone state', '(g)', '<mi mathvariant="normal">g</mi>'],
  ])('renders %s', (_name, notation, expected) => {
    const result = chemToMathML(notation);
    expect(result.ok && result.mathml).toContain(expected);
  });

  it.each([
    ['a single arrow', '->', '→'],
    ['a reverse arrow', '<-', '←'],
    ['an equilibrium arrow', '<=>', '⇌'],
  ])('renders %s', (_name, notation, expected) => {
    const result = chemToMathML(notation);
    expect(result.ok && result.mathml).toBe(`<mo>${expected}</mo>`);
  });

  it('renders a whole equation of the kind an item actually asks', () => {
    const result = chemToMathML('\\ce{2H2 + O2 -> 2H2O}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mathml).toContain('<mo>+</mo>');
    expect(result.mathml).toContain('<mo>→</mo>');
    expect(result.mathml.startsWith('<mn>2</mn>')).toBe(true);
  });

  it('renders a hydrate dot', () => {
    const result = chemToMathML('CuSO4.5H2O');
    expect(result.ok && result.mathml).toContain('<mo>⋅</mo>');
  });

  it('renders a bracketed group', () => {
    const result = chemToMathML('Ca(OH)2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mathml).toContain('<mo>(</mo>');
    expect(result.mathml).toContain('<mo>)</mo>');
  });

  it('emits a real math element in the MathML namespace', () => {
    const { container } = render(
      <ChemNode notation="H2SO4" textAlternative="sulfuric acid" display="block" location="blocks[0]" />,
    );
    const math = container.querySelector('math')!;
    expect(math.getAttribute('xmlns')).toBe('http://www.w3.org/1998/Math/MathML');
    expect(math.querySelector('msub')).not.toBeNull();
  });
});

describe('the authored alternative is the accessible name, as for mathematics', () => {
  it('announces the alternative', () => {
    render(
      <ChemNode notation="H2SO4" textAlternative="sulfuric acid" display="block" location="blocks[0]" />,
    );
    expect(screen.getByRole('math', { name: 'sulfuric acid' })).toBeInTheDocument();
  });

  it('hides the MathML from assistive technology', () => {
    const { container } = render(
      <ChemNode notation="H2O" textAlternative="water" display="inline" location="blocks[0]" />,
    );
    expect(container.querySelector('math')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('rendering is deterministic and identical across profiles', () => {
  it('is byte-identical across 100 calls', () => {
    const outputs = new Set(
      Array.from({ length: 100 }, () => {
        const result = chemToMathML('\\ce{2H2 + O2 -> 2H2O}');
        return result.ok ? result.mathml : 'FAILED';
      }),
    );
    expect(outputs.size).toBe(1);
    expect([...outputs][0]).not.toBe('FAILED');
  });

  it('renders the same MathML on every surface profile', () => {
    const rendered = SURFACE_PROFILES.map((surface) => {
      const { container } = render(
        <ContentRenderer body={chemBody('2H2 + O2 -> 2H2O', 'hydrogen burns')} surface={surface} />,
      );
      return container.querySelector('math')?.outerHTML;
    });
    expect(new Set(rendered).size).toBe(1);
  });
});

describe('a structure degrades to the documented affordance (DEC-6, D19)', () => {
  it.each([
    ['a chemfig structure', '\\chemfig{*6(------)}'],
    ['a SMILES string', 'c1ccccc1'],
    ['a bond with an angle', 'C-[:30]C'],
  ])('refuses %s and says to use a diagram asset', (_name, notation) => {
    const result = chemToMathML(notation);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.useDiagramAsset).toBe(true);
    expect(result.reason).toContain('diagram asset');
  });

  it('renders the alternative with the affordance, not a broken picture', () => {
    const issues: ChemNodeIssue[] = [];
    render(
      <ChemNode
        notation="\\chemfig{*6(------)}"
        textAlternative="a benzene ring"
        display="block"
        location="blocks[2]"
        onIssue={(issue) => issues.push(issue)}
      />,
    );

    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('a benzene ring');
    expect(note).toHaveTextContent('Use a diagram asset');
    expect(issues[0]).toMatchObject({
      code: 'STRUCTURE_NEEDS_DIAGRAM_ASSET',
      location: 'blocks[2]',
    });
  });

  // The two refusals are different things: one is a defect the author fixes,
  // the other is content in the wrong medium.
  it('distinguishes a structure from malformed notation', () => {
    const issues: ChemNodeIssue[] = [];
    render(
      <ChemNode
        notation="!!!"
        textAlternative="nonsense"
        display="inline"
        location="blocks[0]"
        onIssue={(issue) => issues.push(issue)}
      />,
    );
    expect(issues[0]?.code).toBe('NOTATION_UNRENDERABLE');
    expect(screen.getByRole('note')).not.toHaveTextContent('Use a diagram asset');
  });

  it.each([
    ['punctuation', '!!!'],
    ['an empty string', '   '],
    ['a lowercase word', 'water'],
  ])('refuses %s as notation', (_name, notation) => {
    const result = chemToMathML(notation);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.useDiagramAsset).toBe(false);
  });

  it('reports through the renderer so publication can block on it', () => {
    const issues: RenderIssue[] = [];
    render(
      <ContentRenderer
        body={chemBody('c1ccccc1', 'a benzene ring')}
        surface="mobile"
        onIssue={(issue) => issues.push(issue)}
      />,
    );
    expect(issues[0]).toMatchObject({ code: 'STRUCTURE_NEEDS_DIAGRAM_ASSET', location: 'blocks[0]' });
  });

  it('degrades without a reporter attached, and never throws', () => {
    expect(() =>
      render(<ChemNode notation="!!!" textAlternative="x" display="inline" location="b" />),
    ).not.toThrow();
  });
});

describe('accessibility', () => {
  it('scans clean, rendered and degraded alike', async () => {
    const rendered = render(
      <ChemNode notation="2H2 + O2 -> 2H2O" textAlternative="hydrogen burns" display="block" location="b" />,
    );
    expect(await accessibilityViolations(rendered.container)).toEqual([]);

    const degraded = render(
      <ChemNode notation="c1ccccc1" textAlternative="a benzene ring" display="block" location="b" />,
    );
    expect(await accessibilityViolations(degraded.container)).toEqual([]);
  });
});
