import { useRef, type JSX } from 'react';
import {
  NOTATION_PALETTE,
  insertPaletteEntry,
  isNotationMode,
  notationSourceOf,
  segmentForPalette,
  withNotationSource,
  type BodyBlockDraft,
  type BodyDraft,
  type NotationBlockDraft,
  type NotationMode,
} from './body-draft.js';

/**
 * The one authored-body editor: text, mathematics, chemistry, and the
 * dual-mode notation input (UX §10.1).
 *
 * Shared by the item, stimulus and solution editors. Three copies of a
 * notation field would be three places for the mode switch to lose an
 * expression, and only one of them would be found before an author did.
 *
 * **The two modes edit the same string.** LaTeX for the fluent, a palette for
 * everyone else, and the palette is an insertion device over the expression
 * rather than a second representation — which is what makes switching mid-item
 * lossless rather than carefully-implemented-as-lossless.
 */

export interface BodyEditorProps {
  readonly body: BodyDraft;
  readonly onChange: (next: BodyDraft) => void;
  /** Prefixes every field's DOM id, so an error summary can link to one. */
  readonly idPrefix: string;
  /** Names the fields for a screen reader: "Stem text", "Option 2 notation". */
  readonly label: string;
  readonly notationMode: NotationMode;
  /** The inline error for a field, when the host has one. */
  readonly describeError?: (fieldId: string) => string | undefined;
}

function replaceBlock(body: BodyDraft, index: number, block: BodyBlockDraft): BodyDraft {
  return { blocks: body.blocks.map((existing, at) => (at === index ? block : existing)) };
}

export function BodyEditor(props: BodyEditorProps): JSX.Element {
  const caretRef = useRef<Record<string, number>>({});
  const describeError = props.describeError ?? ((): string | undefined => undefined);

  const notationBlock = (block: NotationBlockDraft, index: number): JSX.Element => {
    const source = notationSourceOf(block);
    const sourceId = `${props.idPrefix}-block-${index}`;
    const altId = `${props.idPrefix}-alt-${index}`;
    const altError = describeError(altId);

    return (
      <>
        <label htmlFor={sourceId}>{`${props.label} notation`}</label>
        <input
          id={sourceId}
          value={source}
          onChange={(event) => {
            caretRef.current[sourceId] = event.target.selectionStart ?? event.target.value.length;
            props.onChange(replaceBlock(props.body, index, withNotationSource(block, event.target.value)));
          }}
          onSelect={(event) => {
            caretRef.current[sourceId] = event.currentTarget.selectionStart ?? source.length;
          }}
        />

        {props.notationMode === 'palette' ? (
          <>
            <ul aria-label={`${props.label} expression parts`}>
              {segmentForPalette(source).map((segment, at) => (
                <li key={`${segment.kind}-${at}`}>
                  {segment.kind === 'PALETTE' ? segment.entryId : `typed: ${segment.text}`}
                </li>
              ))}
            </ul>
            <div role="group" aria-label={`${props.label} notation palette`}>
              {NOTATION_PALETTE.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => {
                    const caret = caretRef.current[sourceId] ?? source.length;
                    const inserted = insertPaletteEntry(source, caret, entry);
                    caretRef.current[sourceId] = inserted.caret;
                    props.onChange(
                      replaceBlock(props.body, index, withNotationSource(block, inserted.latex)),
                    );
                  }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </>
        ) : null}

        <label htmlFor={altId}>{`${props.label} description`}</label>
        <input
          id={altId}
          value={block.textAlternative}
          aria-describedby={altError === undefined ? undefined : `${altId}-error`}
          onChange={(event) =>
            props.onChange(
              replaceBlock(props.body, index, { ...block, textAlternative: event.target.value }),
            )
          }
        />
        {altError === undefined ? null : <p id={`${altId}-error`}>{altError}</p>}
      </>
    );
  };

  return (
    <>
      {props.body.blocks.map((block, index) => {
        const textId = `${props.idPrefix}-block-${index}`;
        const textError = describeError(textId);
        return (
          <div key={`${props.idPrefix}-${index}`}>
            {block.kind === 'TEXT' ? (
              <>
                <label htmlFor={textId}>{`${props.label} text`}</label>
                <textarea
                  id={textId}
                  value={block.value}
                  aria-describedby={textError === undefined ? undefined : `${textId}-error`}
                  onChange={(event) =>
                    props.onChange(
                      replaceBlock(props.body, index, { kind: 'TEXT', value: event.target.value }),
                    )
                  }
                />
                {textError === undefined ? null : <p id={`${textId}-error`}>{textError}</p>}
              </>
            ) : (
              notationBlock(block, index)
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          props.onChange({
            blocks: [...props.body.blocks, { kind: 'MATH', latex: '', textAlternative: '' }],
          })
        }
      >
        {`Add an equation to ${props.label.toLowerCase()}`}
      </button>
      <button
        type="button"
        onClick={() =>
          props.onChange({
            blocks: [...props.body.blocks, { kind: 'CHEM', notation: '', textAlternative: '' }],
          })
        }
      >
        {`Add chemical notation to ${props.label.toLowerCase()}`}
      </button>
    </>
  );
}

export interface NotationModeToggleProps {
  readonly mode: NotationMode;
  readonly onChange: (mode: NotationMode) => void;
  /** Distinguishes the radio group when two editors share a page. */
  readonly name: string;
}

export function NotationModeToggle(props: NotationModeToggleProps): JSX.Element {
  return (
    <fieldset>
      <legend>Notation input</legend>
      {(['latex', 'palette'] as const).map((mode) => (
        <span key={mode}>
          <input
            type="radio"
            id={`${props.name}-${mode}`}
            name={props.name}
            value={mode}
            checked={props.mode === mode}
            onChange={(event) => {
              if (isNotationMode(event.target.value)) props.onChange(event.target.value);
            }}
          />
          <label htmlFor={`${props.name}-${mode}`}>{mode === 'latex' ? 'LaTeX' : 'Palette'}</label>
        </span>
      ))}
    </fieldset>
  );
}
