import type { JSX, ReactNode } from 'react';
import {
  isBlockKind,
  isInlineKind,
  type Block,
  type ContentBody,
  type Inline,
  type MediaSizeHint,
  type TextMark,
} from './content-body.js';
import { ChemNode } from './chem-node.js';
import { MathNode } from './math-node.js';
import type { SurfaceProfile } from './surface-profile.js';
import { TOKENS } from './tokens.js';

/**
 * `ContentRenderer` — **the one implementation** (§9 rule 13 / F20).
 *
 * Two implementations mean the authoring preview diverges from what students
 * see, silently, and INV-14's promise of deterministic rendering across four
 * surfaces becomes a claim nobody can check. So there is one component, the
 * surface is a parameter, and a monorepo-wide scan asserts no second one
 * exists.
 *
 * **An unknown node renders a visible, labelled fallback and reports it.** It
 * never throws — a renderer that throws takes a whole paper down over one
 * node — and it never renders nothing, which is worse: a silently dropped node
 * is an item that asks about a diagram the student cannot see, and nobody finds
 * out until a mark is disputed.
 *
 * Media is rendered as a **reference**, not a fetch. The renderer knows an
 * asset version identifier and the alt text carried with the reference; the
 * host supplies `resolveMedia` to turn that into a source. Without it the
 * figure still renders its accessible description, because ACC-03's guarantee
 * is the description rather than the picture.
 */

export interface MediaResolution {
  readonly src: string;
  readonly altText: string;
  readonly longDescription?: string;
}

export interface RenderIssue {
  readonly code:
    | 'UNKNOWN_BLOCK_KIND'
    | 'UNKNOWN_INLINE_KIND'
    | 'MEDIA_UNRESOLVED'
    | 'NOTATION_UNRENDERABLE'
    | 'STRUCTURE_NEEDS_DIAGRAM_ASSET';
  readonly location: string;
  readonly message: string;
}

export interface ContentRendererProps {
  readonly body: ContentBody;
  readonly surface: SurfaceProfile;
  /** Turns an asset version identifier into something a browser can show. */
  readonly resolveMedia?: (assetVersionId: string) => MediaResolution | undefined;
  /** Called once per issue, so a validation surface can block publication. */
  readonly onIssue?: (issue: RenderIssue) => void;
}

const MARK_ELEMENT: Readonly<Record<TextMark, 'strong' | 'em' | 'sub' | 'sup'>> = Object.freeze({
  BOLD: 'strong',
  ITALIC: 'em',
  SUBSCRIPT: 'sub',
  SUPERSCRIPT: 'sup',
});

const SIZE_CLASS: Readonly<Record<MediaSizeHint, string>> = Object.freeze({
  INLINE: 'qb-media--inline',
  HALF_WIDTH: 'qb-media--half',
  FULL_WIDTH: 'qb-media--full',
});

/** Marks nest outermost-first, so the same set always produces the same tree. */
function withMarks(value: string, marks: readonly TextMark[]): JSX.Element | string {
  return marks.reduceRight<JSX.Element | string>((inner, mark) => {
    const Element = MARK_ELEMENT[mark];
    return <Element>{inner}</Element>;
  }, value);
}

interface RenderContext {
  readonly surface: SurfaceProfile;
  readonly resolveMedia: (assetVersionId: string) => MediaResolution | undefined;
  readonly report: (issue: RenderIssue) => void;
}

/**
 * `display` decides the element, not the styling. An inline fallback rendered
 * as a `div` would sit inside a `p`, which is invalid HTML — the browser
 * closes the paragraph and the rest of the sentence lands outside it, so the
 * degradation would itself break the page it is meant to save.
 */
function Fallback(props: {
  readonly label: string;
  readonly detail: ReactNode;
  readonly display: 'block' | 'inline';
}): JSX.Element {
  const Wrapper = props.display === 'block' ? 'div' : 'span';
  return (
    <Wrapper
      className="qb-render-fallback"
      role="note"
      style={{
        color: TOKENS.feedbackWarning,
        border: `1px solid ${TOKENS.borderSubtle}`,
        padding: TOKENS.spaceSmall,
      }}
    >
      <strong>{props.label}</strong> <span>{props.detail}</span>
    </Wrapper>
  );
}

function InlineNode(props: {
  readonly inline: Inline;
  readonly location: string;
  readonly context: RenderContext;
}): JSX.Element {
  const { inline, location, context } = props;

  if (!isInlineKind((inline as { kind: string }).kind)) {
    context.report({
      code: 'UNKNOWN_INLINE_KIND',
      location,
      message: `unknown inline kind "${(inline as { kind: string }).kind}"`,
    });
    return <Fallback label="Unsupported content" detail={`at ${location}`} display="inline" />;
  }

  switch (inline.kind) {
    case 'TEXT':
      return <>{withMarks(inline.value, inline.marks)}</>;
    case 'MATH_INLINE':
      return (
        <MathNode
          latex={inline.latex}
          textAlternative={inline.textAlternative}
          display="inline"
          location={location}
          onIssue={context.report}
        />
      );
    case 'CHEM_INLINE':
      return (
        <ChemNode
          notation={inline.notation}
          textAlternative={inline.textAlternative}
          display="inline"
          location={location}
          onIssue={context.report}
        />
      );
    case 'MEDIA_REF': {
      const resolved = context.resolveMedia(inline.assetVersionId);
      const altText = inline.altTextOverride ?? resolved?.altText;
      if (resolved === undefined) {
        context.report({
          code: 'MEDIA_UNRESOLVED',
          location,
          message: `no media resolved for ${inline.assetVersionId}`,
        });
        // The description still renders. ACC-03's guarantee is the description,
        // not the picture, and an unresolved asset must not silently vanish.
        return <span className="qb-media-ref qb-media-ref--unresolved">{altText ?? ''}</span>;
      }
      return <img className="qb-media-ref" src={resolved.src} alt={altText ?? resolved.altText} />;
    }
  }
}

function Inlines(props: {
  readonly inlines: readonly Inline[];
  readonly location: string;
  readonly context: RenderContext;
}): JSX.Element {
  return (
    <>
      {props.inlines.map((inline, index) => (
        <InlineNode
          key={`${props.location}.inlines[${index}]`}
          inline={inline}
          location={`${props.location}.inlines[${index}]`}
          context={props.context}
        />
      ))}
    </>
  );
}

function BlockNode(props: {
  readonly block: Block;
  readonly location: string;
  readonly context: RenderContext;
}): JSX.Element {
  const { block, location, context } = props;

  if (!isBlockKind((block as { kind: string }).kind)) {
    context.report({
      code: 'UNKNOWN_BLOCK_KIND',
      location,
      message: `unknown block kind "${(block as { kind: string }).kind}"`,
    });
    return <Fallback label="Unsupported content" detail={`at ${location}`} display="block" />;
  }

  switch (block.kind) {
    case 'PARAGRAPH':
      return (
        <p style={{ color: TOKENS.textPrimary }}>
          <Inlines inlines={block.inlines} location={location} context={context} />
        </p>
      );

    case 'MATH_BLOCK':
      return (
        <MathNode
          latex={block.latex}
          textAlternative={block.textAlternative}
          display="block"
          location={location}
          onIssue={context.report}
        />
      );

    case 'CHEM_BLOCK':
      return (
        <ChemNode
          notation={block.notation}
          textAlternative={block.textAlternative}
          display="block"
          location={location}
          onIssue={context.report}
        />
      );

    case 'MEDIA_BLOCK': {
      const resolved = context.resolveMedia(block.assetVersionId);
      const caption =
        block.caption === undefined ? undefined : (
          <Inlines inlines={block.caption} location={`${location}.caption`} context={context} />
        );
      if (resolved === undefined) {
        context.report({
          code: 'MEDIA_UNRESOLVED',
          location,
          message: `no media resolved for ${block.assetVersionId}`,
        });
        return <Fallback label="Figure unavailable" detail={caption ?? ''} display="block" />;
      }
      // A real `figure`/`figcaption`, so the caption is associated with the
      // image rather than being a paragraph that happens to sit under it.
      return (
        <figure className={`qb-media ${SIZE_CLASS[block.sizeHint]}`}>
          <img
            src={resolved.src}
            alt={resolved.altText}
            {...(resolved.longDescription === undefined
              ? {}
              : { 'aria-describedby': `${location}-longdesc` })}
          />
          {resolved.longDescription === undefined ? null : (
            <p id={`${location}-longdesc`} className="qb-media__long-description">
              {resolved.longDescription}
            </p>
          )}
          {caption === undefined ? null : <figcaption>{caption}</figcaption>}
        </figure>
      );
    }

    case 'LIST': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List style={{ color: TOKENS.textPrimary }}>
          {block.items.map((item, index) => (
            <li key={`${location}.items[${index}]`}>
              {item.map((child, childIndex) => (
                <BlockNode
                  key={`${location}.items[${index}][${childIndex}]`}
                  block={child}
                  location={`${location}.items[${index}][${childIndex}]`}
                  context={context}
                />
              ))}
            </li>
          ))}
        </List>
      );
    }

    case 'TABLE':
      // Real `th` with `scope`, so a screen reader announces the column a cell
      // belongs to rather than reading a grid of unlabelled values.
      return (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderColor: TOKENS.borderSubtle }}>
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={`${location}.header[${index}]`} scope="col">
                    <Inlines
                      inlines={cell}
                      location={`${location}.header[${index}]`}
                      context={context}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${location}.rows[${rowIndex}]`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${location}.rows[${rowIndex}][${cellIndex}]`}>
                      <Inlines
                        inlines={cell}
                        location={`${location}.rows[${rowIndex}][${cellIndex}]`}
                        context={context}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function ContentRenderer(props: ContentRendererProps): JSX.Element {
  const context: RenderContext = {
    surface: props.surface,
    resolveMedia: props.resolveMedia ?? (() => undefined),
    report: props.onIssue ?? (() => undefined),
  };

  return (
    <div className={`qb-content qb-content--${props.surface}`} data-surface={props.surface}>
      {props.body.blocks.map((block, index) => (
        <BlockNode
          key={`blocks[${index}]`}
          block={block}
          location={`blocks[${index}]`}
          context={context}
        />
      ))}
    </div>
  );
}
