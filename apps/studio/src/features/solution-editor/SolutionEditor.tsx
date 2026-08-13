import { useCallback, useState, type JSX } from 'react';
import { ContentRenderer, MINIMUM_DEVICE_PROFILE } from '@questionbank/content-renderer';
import { BodyEditor, NotationModeToggle } from '../../authoring/BodyEditor.js';
import { useAutosave } from '../../authoring/use-autosave.js';
import { emptyBody, toContentBody, type BodyDraft, type NotationMode } from '../../authoring/body-draft.js';
import {
  moveStep,
  solutionFormErrors,
  toStepCommands,
  type SolutionDraft,
  type SolutionEditorApi,
  type SolutionTargetItem,
  type StepDraft,
} from './solution-editor-model.js';

/**
 * The Solution editor (M3-41, FR-TCH-04).
 *
 * **The item and its key sit alongside the explanation.** An author writing a
 * derivation without the question in front of them writes a derivation for a
 * different question, and the defect that produces answer-key challenges is a
 * solution that ends somewhere the key does not.
 *
 * **Disagreement surfaces immediately, not at submit.** M3-14 is checked on
 * every solution save (M3-26), so the refusal arrives with the autosave — the
 * author learns while the item is still in their head rather than at the end
 * of the session.
 *
 * **Reordering is drag-free.** Move-up and move-down are buttons, so the order
 * can be changed by keyboard alone; a drag handle is a control a keyboard user
 * cannot operate at all, and step order is meaning here rather than layout.
 */

export interface SolutionEditorProps {
  readonly api: SolutionEditorApi;
  readonly item: SolutionTargetItem;
  readonly initialDraft: SolutionDraft;
  readonly principalMayAuthor: boolean;
  readonly autosaveDelayMs?: number;
}

const DEFAULT_AUTOSAVE_DELAY_MS = 800;

let nextStepId = 0;

function newStep(): StepDraft {
  nextStepId += 1;
  return { stepId: `step-${nextStepId}`, body: emptyBody() };
}

export function SolutionEditor(props: SolutionEditorProps): JSX.Element {
  const { api, item, initialDraft, principalMayAuthor } = props;

  const [draft, setDraft] = useState<SolutionDraft>(initialDraft);
  const [notationMode, setNotationMode] = useState<NotationMode>('latex');
  const [disagreement, setDisagreement] = useState<string | null>(null);

  const autosave = useAutosave<SolutionDraft>({
    delayMs: props.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS,
    initial: initialDraft,
    save: async (snapshot, attempt) => {
      const outcome = await api
        .saveDraft({
          solutionId: snapshot.solutionId,
          idempotencyKey: `${snapshot.solutionId}:${attempt}`,
          targetItemVersionId: snapshot.targetItemVersionId,
          finalAnswer: snapshot.finalAnswer,
          steps: toStepCommands(snapshot.steps),
          distractorAnalyses: Object.entries(snapshot.distractorAnalyses).map(
            ([optionId, body]) => ({ optionId, misconception: toContentBody(body) }),
          ),
        })
        .catch(() => null);

      if (outcome === null) return false;
      setDisagreement(outcome.disagreement ?? null);
      return outcome.ok;
    },
  });

  const edit = useCallback(
    (next: SolutionDraft): void => {
      setDraft(next);
      autosave.record(next);
    },
    [autosave],
  );

  const formErrors = solutionFormErrors(draft);
  const describeError = (fieldId: string): string | undefined =>
    formErrors.find((error) => error.fieldId === fieldId)?.message;

  if (!principalMayAuthor) {
    return (
      <main>
        <h1>Solution</h1>
        <p role="alert">You are not permitted to author solutions.</p>
      </main>
    );
  }

  const incorrectOptions = item.options.filter((option) => option.optionId !== item.correctOptionId);

  return (
    <main>
      <h1>Solution</h1>

      {disagreement === null ? null : (
        <p role="alert">{disagreement}</p>
      )}
      {autosave.failed && disagreement === null ? (
        <p role="alert">Autosave failed. Your last edits are not saved.</p>
      ) : null}

      <section aria-labelledby="target-heading">
        <h2 id="target-heading">The item this explains</h2>
        <div role="region" aria-label="Item stem">
          <ContentRenderer body={item.stem} surface={MINIMUM_DEVICE_PROFILE} />
        </div>
        <ul aria-label="Options and the key">
          {item.options.map((option) => (
            <li key={option.optionId}>
              <div role="region" aria-label={`Option ${option.ordinal} body`}>
                <ContentRenderer body={option.body} surface={MINIMUM_DEVICE_PROFILE} />
              </div>
              <p>
                {option.optionId === item.correctOptionId
                  ? `Option ${option.ordinal} — the key`
                  : `Option ${option.ordinal} — a distractor`}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <NotationModeToggle
        mode={notationMode}
        onChange={setNotationMode}
        name="solution-notation-mode"
      />

      <section aria-labelledby="final-answer-heading">
        <h2 id="final-answer-heading">Final answer</h2>
        {draft.finalAnswer.kind === 'OPTION' ? (
          <>
            <label htmlFor="final-answer">The solution concludes</label>
            <select
              id="final-answer"
              value={draft.finalAnswer.optionId ?? ''}
              onChange={(event) =>
                edit({
                  ...draft,
                  finalAnswer: {
                    kind: 'OPTION',
                    optionId: event.target.value === '' ? null : event.target.value,
                  },
                })
              }
            >
              <option value="">Choose an option…</option>
              {item.options.map((option) => (
                <option key={option.optionId} value={option.optionId}>
                  {`Option ${option.ordinal}`}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label htmlFor="final-answer">The solution concludes</label>
            <input
              id="final-answer"
              value={draft.finalAnswer.value}
              aria-describedby={
                describeError('final-answer') === undefined ? undefined : 'final-answer-error'
              }
              onChange={(event) =>
                edit({ ...draft, finalAnswer: { kind: 'NUMERIC', value: event.target.value } })
              }
            />
            {describeError('final-answer') === undefined ? null : (
              <p id="final-answer-error">{describeError('final-answer')}</p>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="steps-heading">
        <h2 id="steps-heading">Steps</h2>
        {draft.steps.length === 0 ? <p>No steps yet.</p> : null}
        <ol>
          {draft.steps.map((step, index) => (
            <li key={step.stepId}>
              <BodyEditor
                body={step.body}
                onChange={(body) =>
                  edit({
                    ...draft,
                    steps: draft.steps.map((existing, at) =>
                      at === index ? { ...existing, body } : existing,
                    ),
                  })
                }
                idPrefix={`step-${step.stepId}`}
                label={`Step ${index + 1}`}
                notationMode={notationMode}
                describeError={describeError}
              />
              <button
                type="button"
                disabled={index === 0}
                onClick={() => edit({ ...draft, steps: moveStep(draft.steps, index, -1) })}
              >
                {`Move step ${index + 1} up`}
              </button>
              <button
                type="button"
                disabled={index === draft.steps.length - 1}
                onClick={() => edit({ ...draft, steps: moveStep(draft.steps, index, 1) })}
              >
                {`Move step ${index + 1} down`}
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          id="add-step"
          onClick={() => edit({ ...draft, steps: [...draft.steps, newStep()] })}
        >
          Add a step
        </button>
      </section>

      <section aria-labelledby="distractors-heading">
        <h2 id="distractors-heading">Distractor analysis</h2>
        {incorrectOptions.length === 0 ? (
          <p>This item has no distractors to analyse.</p>
        ) : (
          incorrectOptions.map((option) => (
            <div key={option.optionId}>
              <h3>{`Option ${option.ordinal}`}</h3>
              {/* The option's own body, not just its number: an author asked
                  about "option 3" in the abstract writes about the wrong one. */}
              <div role="region" aria-label={`Option ${option.ordinal} as authored`}>
                <ContentRenderer body={option.body} surface={MINIMUM_DEVICE_PROFILE} />
              </div>
              <BodyEditor
                body={draft.distractorAnalyses[option.optionId] ?? emptyBody()}
                onChange={(body: BodyDraft) =>
                  edit({
                    ...draft,
                    distractorAnalyses: { ...draft.distractorAnalyses, [option.optionId]: body },
                  })
                }
                idPrefix={`misconception-${option.optionId}`}
                label={`Misconception behind option ${option.ordinal}`}
                notationMode={notationMode}
              />
            </div>
          ))
        )}
      </section>
    </main>
  );
}
