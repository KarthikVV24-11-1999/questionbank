import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { accessibilityViolations } from './testing/accessibility.js';
import { latexToMathML } from './latex-to-mathml.js';
import { MathNode, type MathNodeIssue } from './math-node.js';
import { SURFACE_PROFILES } from './surface-profile.js';
import { ContentRenderer, type RenderIssue } from './content-renderer.js';
import type { ContentBody } from './content-body.js';

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

function mathBody(latex: string, textAlternative: string): ContentBody {
  return { schemaVersion: 1, blocks: [{ kind: 'MATH_BLOCK', latex, textAlternative }] };
}

describe('LaTeX becomes real MathML, not HTML that looks like mathematics', () => {
  // One representative expression per notation class a JEE/NEET item uses.
  it.each([
    ['a fraction', '\\frac{1}{2}', '<mfrac><mn>1</mn><mn>2</mn></mfrac>'],
    ['a superscript', 'v^2', '<msup><mi>v</mi><mn>2</mn></msup>'],
    ['a subscript', 'v_0', '<msub><mi>v</mi><mn>0</mn></msub>'],
    ['both scripts', 'x_1^2', '<msubsup><mi>x</mi><mn>1</mn><mn>2</mn></msubsup>'],
    ['a root', '\\sqrt{2}', '<msqrt><mn>2</mn></msqrt>'],
    ['a greek letter', '\\theta', '<mi>θ</mi>'],
    ['an operator', 'a \\times b', '<mi>a</mi><mo>×</mo><mi>b</mi>'],
    ['a function', '\\sin x', '<mi>sin</mi><mi>x</mi>'],
    ['a vector accent', '\\vec{v}', '<mover><mi>v</mi><mo>→</mo></mover>'],
  ])('renders %s', (_name, latex, expected) => {
    const result = latexToMathML(latex);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mathml).toBe(expected);
  });

  it('runs digits together into one number, so 981 is a number and not three', () => {
    const result = latexToMathML('9.81');
    expect(result.ok && result.mathml).toBe('<mn>9.81</mn>');
  });

  it('renders a delimited group as a row', () => {
    const result = latexToMathML('\\left( a + b \\right)');
    expect(result.ok && result.mathml).toBe('<mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow>');
  });

  it('renders a whole equation of the kind an item actually asks', () => {
    const result = latexToMathML('a = \\frac{v^2}{r}');
    expect(result.ok && result.mathml).toBe(
      '<mi>a</mi><mo>=</mo><mfrac><msup><mi>v</mi><mn>2</mn></msup><mi>r</mi></mfrac>',
    );
  });

  it('emits a real math element in the DOM, in the MathML namespace', () => {
    const { container } = render(
      <MathNode latex="x^2" textAlternative="x squared" display="block" location="blocks[0]" />,
    );
    const math = container.querySelector('math')!;
    expect(math).not.toBeNull();
    expect(math.getAttribute('xmlns')).toBe(MATHML_NS);
    expect(math.getAttribute('display')).toBe('block');
    expect(math.querySelector('msup')).not.toBeNull();
  });

  it('escapes markup rather than emitting it', () => {
    const result = latexToMathML('a < b');
    expect(result.ok && result.mathml).toContain('&lt;');
    expect(result.ok && result.mathml).not.toContain('<mo><</mo>');
  });
});

describe('the authored alternative is the accessible name (ACC-02)', () => {
  it('announces the alternative, not the structure', () => {
    render(
      <MathNode
        latex={'\\frac{1}{2}mv^2'}
        textAlternative="one half m v squared"
        display="block"
        location="blocks[0]"
      />,
    );
    expect(screen.getByRole('math', { name: 'one half m v squared' })).toBeInTheDocument();
  });

  // One reading, not two competing ones: the MathML is hidden so a screen
  // reader hears the sentence the author wrote.
  it('hides the MathML from assistive technology', () => {
    const { container } = render(
      <MathNode latex="x^2" textAlternative="x squared" display="inline" location="blocks[0]" />,
    );
    expect(container.querySelector('math')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('rendering is deterministic', () => {
  it('is byte-identical across 100 calls', () => {
    const outputs = new Set(
      Array.from({ length: 100 }, () => {
        const result = latexToMathML('\\frac{1}{2}mv^2 + \\sqrt{x_1^2}');
        return result.ok ? result.mathml : 'FAILED';
      }),
    );
    expect(outputs.size).toBe(1);
    expect([...outputs][0]).not.toBe('FAILED');
  });

  it('is byte-identical across all four surface profiles', () => {
    const rendered = SURFACE_PROFILES.map((surface) => {
      const { container } = render(
        <ContentRenderer body={mathBody('a = \\frac{v^2}{r}', 'a equals v squared over r')} surface={surface} />,
      );
      return container.querySelector('math')?.outerHTML;
    });
    expect(new Set(rendered).size).toBe(1);
    expect(rendered[0]).toContain('mfrac');
  });
});

describe('invalid LaTeX degrades and reports (FR-QM-14 rule 2)', () => {
  it.each([
    ['an unclosed group', '\\frac{1'],
    ['a stray closing brace', 'x}'],
    ['an unknown command', '\\wormhole{x}'],
    ['a \\left with no \\right', '\\left( a + b'],
    ['a stray backslash', 'a \\'],
    ['nothing at all', '   '],
  ])('refuses %s', (_name, latex) => {
    expect(latexToMathML(latex).ok).toBe(false);
  });

  it('renders the alternative with a visible affordance rather than a broken expression', () => {
    const issues: MathNodeIssue[] = [];
    render(
      <MathNode
        latex={'\\frac{1'}
        textAlternative="one half"
        display="block"
        location="blocks[3]"
        onIssue={(issue) => issues.push(issue)}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('one half');
    expect(issues).toEqual([
      {
        code: 'NOTATION_UNRENDERABLE',
        location: 'blocks[3]',
        message: expect.stringContaining('does not render') as unknown as string,
      },
    ]);
  });

  it('reports through the renderer, so publication can be blocked on it', () => {
    const issues: RenderIssue[] = [];
    render(
      <ContentRenderer
        body={mathBody('\\wormhole', 'a wormhole')}
        surface="mobile"
        onIssue={(issue) => issues.push(issue)}
      />,
    );
    expect(issues[0]).toMatchObject({ code: 'NOTATION_UNRENDERABLE', location: 'blocks[0]' });
  });

  it('never throws, whatever it is handed', () => {
    const onIssue = vi.fn();
    expect(() =>
      render(
        <MathNode
          latex={'\\'.repeat(50)}
          textAlternative="nonsense"
          display="inline"
          location="blocks[0]"
          onIssue={onIssue}
        />,
      ),
    ).not.toThrow();
    expect(onIssue).toHaveBeenCalledOnce();
  });

  it('degrades without a reporter attached', () => {
    expect(() =>
      render(<MathNode latex={'\\frac{'} textAlternative="x" display="inline" location="b" />),
    ).not.toThrow();
  });
});

describe('layout and accessibility', () => {
  it('scrolls a long expression inside its own container', () => {
    const { container } = render(
      <MathNode
        latex={`x_1 + ${'y + '.repeat(80)}z`}
        textAlternative="a long sum"
        display="block"
        location="blocks[0]"
      />,
    );
    expect(container.firstElementChild?.getAttribute('style')).toContain('overflow-x: auto');
  });

  it('scans clean, rendered and degraded alike', async () => {
    const rendered = render(
      <MathNode latex={'\\frac{1}{2}'} textAlternative="one half" display="block" location="b" />,
    );
    expect(await accessibilityViolations(rendered.container)).toEqual([]);

    const degraded = render(
      <MathNode latex={'\\frac{1'} textAlternative="one half" display="block" location="b" />,
    );
    expect(await accessibilityViolations(degraded.container)).toEqual([]);
  });
});
