import type { JSX } from 'react';
import { ContentRenderer } from '@questionbank/content-renderer';
import type { PackageSlot } from '../package/types.js';
import { TOKENS } from '../tokens.js';

/**
 * One question. It reads the answer it shows from the engine's projection (handed in) and reports a choice by calling `onAnswer`: it keeps
 * nothing of its own, so the control it draws is checked or not because the log says so.
 */
type Answer = string | number | readonly (string | number)[] | null;

const body = (value: unknown) => value as Parameters<typeof ContentRenderer>[0]['body'];

export interface QuestionPaneProps {
  readonly slot: PackageSlot;
  readonly stimulus: unknown;
  readonly answer: Answer;
  readonly onAnswer: (answer: string | readonly string[]) => void;
  readonly onClear: () => void;
}

export function QuestionPane({ slot, stimulus, answer, onAnswer, onClear }: QuestionPaneProps): JSX.Element {
  const item = slot.item;
  const chosen = new Set(Array.isArray(answer) ? answer.map(String) : answer === null ? [] : [String(answer)]);
  const options = [...(item.options ?? [])].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <section aria-label={`Question ${slot.ordinal}`} style={{ padding: TOKENS.spaceMedium }}>
      {stimulus === undefined ? null : (
        <aside aria-label="Passage" style={{ background: TOKENS.surfaceRaised, padding: TOKENS.spaceMedium }}>
          <ContentRenderer body={body(stimulus)} surface="offline" />
        </aside>
      )}
      <div>
        <ContentRenderer body={body(item.stem)} surface="offline" />
      </div>

      {item.itemType === 'SINGLE_CORRECT_MCQ' || item.itemType === 'MULTIPLE_CORRECT_MCQ' ? (
        <fieldset style={{ border: 0, padding: 0 }}>
          <legend>{item.itemType === 'MULTIPLE_CORRECT_MCQ' ? 'Choose every option that is correct' : 'Choose one option'}</legend>
          {options.map((option) => {
            const single = item.itemType === 'SINGLE_CORRECT_MCQ';
            return (
              <label key={option.optionId} style={{ display: 'block', padding: TOKENS.spaceSmall }}>
                <input
                  type={single ? 'radio' : 'checkbox'}
                  name={`q-${slot.slotId}`}
                  checked={chosen.has(option.optionId)}
                  onChange={() => {
                    if (single) onAnswer(option.optionId);
                    else {
                      const next = new Set(chosen);
                      if (next.has(option.optionId)) next.delete(option.optionId);
                      else next.add(option.optionId);
                      if (next.size === 0) onClear();
                      else onAnswer([...next].sort());
                    }
                  }}
                />{' '}
                <ContentRenderer body={body(option.body)} surface="offline" />
              </label>
            );
          })}
        </fieldset>
      ) : null}

      {item.itemType === 'NUMERIC' ? (
        <label style={{ display: 'block', padding: TOKENS.spaceSmall }}>
          Your answer{item.numericInput?.unitCanonical === undefined ? '' : ` (in ${item.numericInput.unitCanonical})`}
          <input
            type="text"
            inputMode="decimal"
            value={answer === null || Array.isArray(answer) ? '' : String(answer)}
            onChange={(event) => (event.target.value.trim().length === 0 ? onClear() : onAnswer(event.target.value))}
          />
        </label>
      ) : null}

      {item.itemType === 'MATCHING' ? (
        <MatchingControls slot={slot} chosen={[...chosen]} onAnswer={onAnswer} onClear={onClear} />
      ) : null}

      <button type="button" onClick={onClear} disabled={answer === null}>
        Clear my answer
      </button>
    </section>
  );
}

/** Matching is answered as a list of `left:right` pairs, which is how scoring reads it. */
function MatchingControls({ slot, chosen, onAnswer, onClear }: { readonly slot: PackageSlot; readonly chosen: readonly string[]; readonly onAnswer: QuestionPaneProps['onAnswer']; readonly onClear: () => void }): JSX.Element {
  const left = slot.item.matchingLeft ?? [];
  const right = slot.item.matchingRight ?? [];
  const pairs = new Map(chosen.map((pair) => pair.split(':') as [string, string]));
  return (
    <div role="group" aria-label="Match each item">
      {left.map((member) => (
        <label key={member.memberId} style={{ display: 'block' }}>
          <ContentRenderer body={body(member.body)} surface="offline" />
          <select
            value={pairs.get(member.memberId) ?? ''}
            onChange={(event) => {
              const next = new Map(pairs);
              if (event.target.value === '') next.delete(member.memberId);
              else next.set(member.memberId, event.target.value);
              if (next.size === 0) onClear();
              else onAnswer([...next].map(([l, r]) => `${l}:${r}`).sort());
            }}
          >
            <option value="">Choose…</option>
            {right.map((candidate) => (
              <option key={candidate.memberId} value={candidate.memberId}>
                {candidate.memberId}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
