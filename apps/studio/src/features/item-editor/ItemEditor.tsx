import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  ContentRenderer,
  MINIMUM_DEVICE_PROFILE,
  SURFACE_PROFILES,
  isSurfaceProfile,
  type SurfaceProfile,
} from '@questionbank/content-renderer';
import { BodyEditor, NotationModeToggle } from '../../authoring/BodyEditor.js';
import { useAutosave } from '../../authoring/use-autosave.js';
import { toContentBody, type BodyDraft, type NotationMode } from '../../authoring/body-draft.js';
import {
  itemEditorFormErrors,
  type FormError,
  type ItemEditorApi,
  type ItemEditorDraft,
  type OptionDraft,
  type ValidationReport,
} from './item-editor-model.js';

/**
 * The Item Editor (M3-40) — one of the four pages that carry the product
 * (FRONTEND §3).
 *
 * **The preview is the delivery render.** It goes through
 * `packages/content-renderer/` with a surface parameter, defaulting to the
 * minimum device profile (FR-QM-14 rule 3, UX §10.1). Previewing at desktop
 * width for a mobile audience is how broken items reach students, and using a
 * second rendering path here would make M3-38's byte-for-byte parity claim
 * a statement about nothing.
 *
 * **Autosave is `UpdateItemDraft` with an idempotency key** (M3-25), debounced.
 * A save in flight does not swallow a keystroke typed during it: the edit marks
 * the draft dirty and the completing save starts another with the newer
 * snapshot. Losing forty minutes of equation authoring ends the relationship
 * with that author (UX §10.1), so a failed autosave says so out loud rather
 * than leaving a quiet "saved" on screen.
 *
 * **This surface decides no governance rule.** Findings come from the domain
 * (M3-17) through the port, and `maySubmit` is the domain's verdict. What the
 * editor adds is field-level form errors, which are a courtesy: the server
 * refuses the same drafts again (FRONTEND §7).
 */

export interface ItemEditorProps {
  readonly api: ItemEditorApi;
  readonly initialDraft: ItemEditorDraft;
  readonly initialAggregateVersion: number;
  /**
   * Whether this principal may author. The route guard and the server both
   * refuse independently (M3-29 answers a learner with `Authorization`); this
   * is what keeps the answer key off the screen in the meantime.
   */
  readonly principalMayAuthor: boolean;
  readonly autosaveDelayMs?: number;
}

const DEFAULT_AUTOSAVE_DELAY_MS = 800;

function findingsOf(
  report: ValidationReport | null,
  severity: 'blocking' | 'warning',
): ValidationReport['findings'] {
  return (report?.findings ?? []).filter((finding) => finding.severity === severity);
}

export function ItemEditor(props: ItemEditorProps): JSX.Element {
  const { api, initialDraft, initialAggregateVersion, principalMayAuthor } = props;
  const autosaveDelayMs = props.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;

  const [draft, setDraft] = useState<ItemEditorDraft>(initialDraft);
  const [notationMode, setNotationMode] = useState<NotationMode>('latex');
  const [previewSurface, setPreviewSurface] = useState<SurfaceProfile>(MINIMUM_DEVICE_PROFILE);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [submitRefused, setSubmitRefused] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const versionRef = useRef(initialAggregateVersion);
  const summaryRef = useRef<HTMLDivElement>(null);

  const formErrors = useMemo(() => itemEditorFormErrors(draft), [draft]);
  const errorFor = useCallback(
    (fieldId: string): FormError | undefined => formErrors.find((error) => error.fieldId === fieldId),
    [formErrors],
  );
  const describeError = useCallback(
    (fieldId: string): string | undefined => errorFor(fieldId)?.message,
    [errorFor],
  );

  const autosave = useAutosave<ItemEditorDraft>({
    delayMs: autosaveDelayMs,
    initial: initialDraft,
    save: async (snapshot, attempt) => {
      const saved = await api
        .saveDraft({
          itemId: snapshot.itemId,
          idempotencyKey: `${snapshot.itemId}:${attempt}`,
          expectedAggregateVersion: versionRef.current,
          draft: snapshot,
          misconceptions: snapshot.options
            .filter((option) => option.optionId !== snapshot.correctOptionId)
            .map((option) => ({ optionId: option.optionId, text: option.misconception })),
        })
        .catch(() => null);
      if (saved === null) return false;
      versionRef.current = saved.aggregateVersion;
      setReport(saved.report);
      return true;
    },
  });

  const edit = useCallback(
    (next: ItemEditorDraft): void => {
      setDraft(next);
      autosave.record(next);
    },
    [autosave],
  );

  useEffect(() => {
    if (submitRefused) summaryRef.current?.focus();
  }, [submitRefused]);

  const submit = useCallback(async (): Promise<void> => {
    if (formErrors.length > 0 || report === null || !report.maySubmit) {
      setSubmitRefused(true);
      return;
    }
    const outcome = await api.submitForReview(draft.itemId, versionRef.current);
    if (outcome.ok) {
      setSubmitted(true);
      setSubmitMessage(null);
      return;
    }
    setSubmitMessage(outcome.message);
  }, [api, draft.itemId, formErrors.length, report]);

  if (!principalMayAuthor) {
    return (
      <main>
        <h1>Item editor</h1>
        <p role="alert">
          You are not permitted to author items. Ask Content Ops for an authoring role.
        </p>
      </main>
    );
  }

  const blocking = findingsOf(report, 'blocking');
  const warnings = findingsOf(report, 'warning');
  const previewBody = toContentBody(draft.stem);

  const setOption = (optionId: string, change: (option: OptionDraft) => OptionDraft): void =>
    edit({
      ...draft,
      options: draft.options.map((option) => (option.optionId === optionId ? change(option) : option)),
    });

  return (
    <main>
      <h1>Item editor</h1>

      {submitted ? <p role="status">Submitted for review.</p> : null}
      {autosave.failed ? (
        <p role="alert">Autosave failed. Your last edits are not saved — do not close this tab.</p>
      ) : null}
      {submitMessage === null ? null : <p role="alert">{submitMessage}</p>}

      {submitRefused && (formErrors.length > 0 || blocking.length > 0) ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" aria-labelledby="error-summary-heading">
          <h2 id="error-summary-heading">This item cannot be submitted yet</h2>
          <ul>
            {formErrors.map((error) => (
              <li key={error.fieldId}>
                <a href={`#${error.fieldId}`}>{`${error.message} (${error.location})`}</a>
              </li>
            ))}
            {blocking.map((finding) => (
              <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <NotationModeToggle mode={notationMode} onChange={setNotationMode} name="notation-mode" />

      <section aria-labelledby="stem-heading">
        <h2 id="stem-heading">Stem</h2>
        <BodyEditor
          body={draft.stem}
          onChange={(stem) => edit({ ...draft, stem })}
          idPrefix="stem"
          label="Stem"
          notationMode={notationMode}
          describeError={describeError}
        />
      </section>

      {draft.itemType === 'SINGLE_CORRECT_MCQ' ? (
        <section aria-labelledby="options-heading">
          <h2 id="options-heading">Options and answer key</h2>
          <fieldset id="correct-option-group">
            <legend>Correct option</legend>
            {draft.options.map((option) => (
              <span key={option.optionId}>
                <input
                  type="radio"
                  id={`correct-${option.optionId}`}
                  name="correct-option"
                  checked={draft.correctOptionId === option.optionId}
                  onChange={() => edit({ ...draft, correctOptionId: option.optionId })}
                />
                <label htmlFor={`correct-${option.optionId}`}>{`Option ${option.ordinal} is correct`}</label>
              </span>
            ))}
          </fieldset>

          {draft.options.map((option) => (
            <div key={option.optionId}>
              <h3>{`Option ${option.ordinal}`}</h3>
              <BodyEditor
                body={option.body}
                onChange={(body) => setOption(option.optionId, (existing) => ({ ...existing, body }))}
                idPrefix={`option-${option.optionId}`}
                label={`Option ${option.ordinal}`}
                notationMode={notationMode}
                describeError={describeError}
              />
              {draft.correctOptionId === option.optionId ? null : (
                <>
                  {/* The misconception, not just the wrong value — authored
                      while the author still has the item in their head. */}
                  <label htmlFor={`misconception-${option.optionId}`}>
                    {`What misconception leads a student to option ${option.ordinal}?`}
                  </label>
                  <textarea
                    id={`misconception-${option.optionId}`}
                    value={option.misconception}
                    onChange={(event) =>
                      setOption(option.optionId, (existing) => ({
                        ...existing,
                        misconception: event.target.value,
                      }))
                    }
                  />
                </>
              )}
            </div>
          ))}
        </section>
      ) : (
        <section aria-labelledby="numeric-heading">
          <h2 id="numeric-heading">Numeric answer</h2>
          {/* Decimal literals are text the whole way (ADR-0007): `0.10` and
              `0.1` are different authored answers and a float loses that. */}
          <label htmlFor="numeric-expected-value">Expected value</label>
          <input
            id="numeric-expected-value"
            value={draft.numeric?.expectedValue ?? ''}
            aria-describedby={
              errorFor('numeric-expected-value') === undefined
                ? undefined
                : 'numeric-expected-value-error'
            }
            onChange={(event) =>
              edit({
                ...draft,
                numeric: {
                  tolerance: draft.numeric?.tolerance ?? '',
                  unit: draft.numeric?.unit ?? '',
                  expectedValue: event.target.value,
                },
              })
            }
          />
          {errorFor('numeric-expected-value') === undefined ? null : (
            <p id="numeric-expected-value-error">{errorFor('numeric-expected-value')?.message}</p>
          )}

          <label htmlFor="numeric-tolerance">Tolerance</label>
          <input
            id="numeric-tolerance"
            value={draft.numeric?.tolerance ?? ''}
            onChange={(event) =>
              edit({
                ...draft,
                numeric: {
                  expectedValue: draft.numeric?.expectedValue ?? '',
                  unit: draft.numeric?.unit ?? '',
                  tolerance: event.target.value,
                },
              })
            }
          />

          <label htmlFor="numeric-unit">Canonical unit</label>
          <input
            id="numeric-unit"
            value={draft.numeric?.unit ?? ''}
            onChange={(event) =>
              edit({
                ...draft,
                numeric: {
                  expectedValue: draft.numeric?.expectedValue ?? '',
                  tolerance: draft.numeric?.tolerance ?? '',
                  unit: event.target.value,
                },
              })
            }
          />
        </section>
      )}

      <section aria-labelledby="preview-heading">
        <h2 id="preview-heading">Preview</h2>
        <label htmlFor="preview-surface">Preview surface</label>
        <select
          id="preview-surface"
          value={previewSurface}
          onChange={(event) => {
            if (isSurfaceProfile(event.target.value)) setPreviewSurface(event.target.value);
          }}
        >
          {SURFACE_PROFILES.map((surface) => (
            <option key={surface} value={surface}>
              {surface}
            </option>
          ))}
        </select>
        <div role="region" aria-label="Preview output">
          <ContentRenderer body={previewBody} surface={previewSurface} />
        </div>
      </section>

      <section aria-labelledby="validation-heading">
        <h2 id="validation-heading">Validation</h2>
        <h3>Blocking</h3>
        {blocking.length === 0 ? (
          <p>Nothing blocking.</p>
        ) : (
          <ul aria-live="polite">
            {blocking.map((finding) => (
              <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
            ))}
          </ul>
        )}
        <h3>Warnings</h3>
        {warnings.length === 0 ? (
          <p>No warnings.</p>
        ) : (
          <ul>
            {warnings.map((finding) => (
              <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
            ))}
          </ul>
        )}
        {report === null ? null : (
          <p>{`Duplicate check: ${report.duplicateCheckState.replace(/_/gu, ' ')}.`}</p>
        )}
      </section>

      <button type="button" onClick={() => void submit()}>
        Submit for review
      </button>
    </main>
  );
}
