import type { JSX } from 'react';
import { chemToMathML } from './chem-to-mathml.js';
import { TOKENS } from './tokens.js';

/**
 * Chemical notation, through the same MathML pipeline as mathematics (DEC-6).
 *
 * **The affordance distinguishes two refusals.** Malformed notation is a
 * defect the author fixes; a *structure* is not a defect at all — it is
 * content in the wrong medium, and the honest response names the medium it
 * belongs in. A half-drawn benzene ring would tell the author nothing;
 * "author it as a diagram asset" tells them exactly what to do, which is what
 * DEC-6's ratified amendment asks for while D19 stays open.
 */

export interface ChemNodeIssue {
  readonly code: 'NOTATION_UNRENDERABLE' | 'STRUCTURE_NEEDS_DIAGRAM_ASSET';
  readonly location: string;
  readonly message: string;
}

export interface ChemNodeProps {
  readonly notation: string;
  readonly textAlternative: string;
  readonly display: 'block' | 'inline';
  readonly location: string;
  readonly onIssue?: (issue: ChemNodeIssue) => void;
}

export function ChemNode(props: ChemNodeProps): JSX.Element {
  const converted = chemToMathML(props.notation);
  const Wrapper = props.display === 'block' ? 'div' : 'span';

  if (!converted.ok) {
    props.onIssue?.({
      code: converted.useDiagramAsset ? 'STRUCTURE_NEEDS_DIAGRAM_ASSET' : 'NOTATION_UNRENDERABLE',
      location: props.location,
      message: converted.reason,
    });

    return (
      <Wrapper
        className={`qb-notation qb-notation--chem ${
          converted.useDiagramAsset ? 'qb-notation--needs-diagram' : 'qb-notation--unrenderable'
        }`}
        role="note"
        aria-label={props.textAlternative}
        style={{ color: TOKENS.feedbackWarning, border: `1px solid ${TOKENS.borderSubtle}` }}
      >
        <span>{props.textAlternative}</span>
        {converted.useDiagramAsset ? (
          <span className="qb-notation__affordance"> Use a diagram asset for a chemical structure.</span>
        ) : null}
      </Wrapper>
    );
  }

  return (
    <Wrapper
      className={`qb-notation qb-notation--chem qb-notation--${props.display}`}
      role="math"
      aria-label={props.textAlternative}
      style={{ overflowX: 'auto', color: TOKENS.textPrimary }}
      dangerouslySetInnerHTML={{
        __html: `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${
          props.display === 'block' ? 'block' : 'inline'
        }" aria-hidden="true">${converted.mathml}</math>`,
      }}
    />
  );
}
