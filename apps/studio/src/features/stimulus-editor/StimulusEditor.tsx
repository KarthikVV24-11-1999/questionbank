import { useCallback, useState, type JSX } from 'react';
import { ContentRenderer, MINIMUM_DEVICE_PROFILE } from '@questionbank/content-renderer';
import { BodyEditor, NotationModeToggle } from '../../authoring/BodyEditor.js';
import { emptyBody, toContentBody, type BodyDraft, type NotationMode } from '../../authoring/body-draft.js';
import {
  STIMULUS_TYPES,
  isStimulusType,
  stimulusFormErrors,
  type ReferencingItem,
  type StimulusEditorApi,
  type StimulusSummary,
  type StimulusType,
} from './stimulus-editor-model.js';

/**
 * The Stimulus editor (M3-41, FR-TCH-03).
 *
 * **Attach-existing comes before create-new, in the document.** An editor that
 * offers "new passage" first gets a new passage every time, and five copies of
 * one passage diverge the first time one is corrected (UX §10.1). The order is
 * a property of the layout, so a spec asserts it by document position rather
 * than trusting the next person editing this file.
 *
 * **The reference list is shown before attaching, not after.** "Used by four
 * items" is the fact that tells an author they are about to share something,
 * and it is worth nothing once the attachment has happened.
 */

export interface StimulusEditorProps {
  readonly api: StimulusEditorApi;
  /** The item being authored, which an attachment attaches to. */
  readonly itemId: string;
  readonly principalMayAuthor: boolean;
}

export function StimulusEditor(props: StimulusEditorProps): JSX.Element {
  const { api, itemId, principalMayAuthor } = props;

  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<readonly StimulusSummary[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<StimulusSummary | null>(null);
  const [referencing, setReferencing] = useState<readonly ReferencingItem[]>([]);
  const [attachedVersionNo, setAttachedVersionNo] = useState<number | null>(null);

  const [stimulusType, setStimulusType] = useState<StimulusType>('passage');
  const [body, setBody] = useState<BodyDraft>(emptyBody());
  const [notationMode, setNotationMode] = useState<NotationMode>('latex');
  const [createdId, setCreatedId] = useState<string | null>(null);

  const formErrors = stimulusFormErrors({ stimulusType, body });

  const search = useCallback(async (): Promise<void> => {
    setCandidates(await api.search(query));
    setSearched(true);
  }, [api, query]);

  const select = useCallback(
    async (candidate: StimulusSummary): Promise<void> => {
      setSelected(candidate);
      setAttachedVersionNo(null);
      setReferencing(await api.referencingItems(candidate.stimulusId));
    },
    [api],
  );

  const attach = useCallback(async (): Promise<void> => {
    if (selected === null) return;
    const attached = await api.attachToItem({ itemId, stimulusId: selected.stimulusId });
    setAttachedVersionNo(attached.pinnedVersionNo);
  }, [api, itemId, selected]);

  const create = useCallback(async (): Promise<void> => {
    if (formErrors.length > 0) return;
    const created = await api.createDraft({ stimulusType, body: toContentBody(body) });
    setCreatedId(created.stimulusId);
  }, [api, body, formErrors.length, stimulusType]);

  if (!principalMayAuthor) {
    return (
      <main>
        <h1>Stimulus</h1>
        <p role="alert">You are not permitted to author stimuli.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Stimulus</h1>

      <section aria-labelledby="attach-heading">
        <h2 id="attach-heading">Attach an existing stimulus</h2>
        <p>
          A passage, diagram or dataset is shared between items. Look for it before writing it
          again.
        </p>

        <label htmlFor="stimulus-search">Search stimuli</label>
        <input id="stimulus-search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" onClick={() => void search()}>
          Search
        </button>

        {!searched ? null : candidates.length === 0 ? (
          <p>Nothing matches that. Create one below.</p>
        ) : (
          <ul aria-label="Matching stimuli">
            {candidates.map((candidate) => (
              <li key={candidate.stimulusId}>
                <button type="button" onClick={() => void select(candidate)}>
                  {`${candidate.label} (${candidate.stimulusType})`}
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected === null ? null : (
          <div>
            <h3>{selected.label}</h3>
            {/* Shown before the attach button, because after it the fact is
                no longer a decision an author can make. */}
            {referencing.length === 0 ? (
              <p>No item uses this yet.</p>
            ) : (
              <>
                <p>{`Used by ${referencing.length} item(s):`}</p>
                <ul aria-label="Items already using this stimulus">
                  {referencing.map((item) => (
                    <li key={item.itemId}>{item.label}</li>
                  ))}
                </ul>
              </>
            )}
            <button type="button" onClick={() => void attach()}>
              Attach to this item
            </button>
            {attachedVersionNo === null ? null : (
              <p role="status">
                {`Attached. This item is pinned to version ${attachedVersionNo}; editing the stimulus later will not move it.`}
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="create-heading">
        <h2 id="create-heading">None of these — create a new stimulus</h2>

        <label htmlFor="stimulus-type">Stimulus type</label>
        <select
          id="stimulus-type"
          value={stimulusType}
          onChange={(event) => {
            if (isStimulusType(event.target.value)) setStimulusType(event.target.value);
          }}
        >
          {STIMULUS_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <NotationModeToggle
          mode={notationMode}
          onChange={setNotationMode}
          name="stimulus-notation-mode"
        />

        <BodyEditor
          body={body}
          onChange={setBody}
          idPrefix="stimulus"
          label="Stimulus"
          notationMode={notationMode}
          describeError={(fieldId) =>
            formErrors.find((error) => error.fieldId === fieldId)?.message
          }
        />

        <section aria-labelledby="stimulus-preview-heading">
          <h3 id="stimulus-preview-heading">Preview</h3>
          <div role="region" aria-label="Stimulus preview output">
            <ContentRenderer body={toContentBody(body)} surface={MINIMUM_DEVICE_PROFILE} />
          </div>
        </section>

        <button type="button" onClick={() => void create()} disabled={formErrors.length > 0}>
          Create stimulus
        </button>
        {createdId === null ? null : <p role="status">Stimulus created as a draft.</p>}
      </section>
    </main>
  );
}
