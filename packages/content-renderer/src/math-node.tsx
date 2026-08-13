import type { JSX } from 'react';
import { latexToMathML } from './latex-to-mathml.js';
import { TOKENS } from './tokens.js';

/**
 * A mathematical expression, as **real MathML** (ACC-02).
 *
 * **The authored `textAlternative` is the accessible name.** The converter's
 * own output is not trusted to produce a sensible reading order: MathML gives
 * a screen reader structure, and structure is not the same as a sentence a
 * student can follow. `\frac{1}{2}mv^2` read structurally is "fraction one
 * over two m v squared"; the author wrote "one half m v squared", and that is
 * what gets announced.
 *
 * The MathML itself is `aria-hidden`, so assistive technology hears the
 * alternative and nothing else — one reading, not two competing ones.
 *
 * **Invalid LaTeX degrades and reports.** It renders the alternative with a
 * visible error affordance and calls `onIssue`, so FR-QM-14 rule 2 can block
 * publication on it rather than a student meeting a broken expression.
 */

export interface MathNodeIssue {
  readonly code: 'NOTATION_UNRENDERABLE';
  readonly location: string;
  readonly message: string;
}

export interface MathNodeProps {
  readonly latex: string;
  readonly textAlternative: string;
  readonly display: 'block' | 'inline';
  readonly location: string;
  readonly onIssue?: (issue: MathNodeIssue) => void;
}

export function MathNode(props: MathNodeProps): JSX.Element {
  const converted = latexToMathML(props.latex);
  const Wrapper = props.display === 'block' ? 'div' : 'span';

  if (!converted.ok) {
    props.onIssue?.({
      code: 'NOTATION_UNRENDERABLE',
      location: props.location,
      message: `this expression does not render: ${converted.reason}`,
    });

    return (
      <Wrapper
        className="qb-notation qb-notation--math qb-notation--unrenderable"
        role="note"
        aria-label={props.textAlternative}
        style={{ color: TOKENS.feedbackWarning, border: `1px solid ${TOKENS.borderSubtle}` }}
      >
        {/* The alternative still renders: an author and a student both need to
            know what the expression was meant to say. */}
        <span>{props.textAlternative}</span>
      </Wrapper>
    );
  }

  return (
    <Wrapper
      className={`qb-notation qb-notation--math qb-notation--${props.display}`}
      role="math"
      aria-label={props.textAlternative}
      // Long expressions scroll inside their own container; the body never
      // scrolls horizontally (FRONTEND §9).
      style={{ overflowX: 'auto', color: TOKENS.textPrimary }}
      // The one place raw markup is emitted, and it is markup this module
      // produced from a closed grammar — never authored HTML, which INV-14
      // forbids and `ContentBody` refuses at construction.
      dangerouslySetInnerHTML={{
        __html: `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${
          props.display === 'block' ? 'block' : 'inline'
        }" aria-hidden="true">${converted.mathml}</math>`,
      }}
    />
  );
}

/** The serialized MathML for a document, for the parity check (M3-38). */
export function mathMLFor(latex: string): string | undefined {
  const converted = latexToMathML(latex);
  return converted.ok ? converted.mathml : undefined;
}
