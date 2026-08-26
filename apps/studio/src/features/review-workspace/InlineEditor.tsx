import { useCallback, useMemo, useState, type JSX } from 'react';
import { DifficultyBandSchema, type DifficultyBand, type TaxonomyTag } from '@questionbank/contracts/content-schemas';
import { BodyEditor } from '../../authoring/BodyEditor.js';
import { emptyBody, toContentBody, type BodyDraft } from '../../authoring/body-draft.js';
import { EDITABLE_FIELDS, reviewerEditsWireFields, type ReviewerEdits } from './review-workspace-model.js';

/**
 * Edit-in-place, without leaving the queue (M4-40, M4-08, M4-15, ADR-0018).
 *
 * **Exposes exactly `EDITABLE_FIELDS` and nothing the wire schema also
 * carries beyond it.** `ReviewerEditsSchema` (generated from
 * `openapi/content.yaml`) additionally accepts `responseSpec` — the domain's
 * own way of refusing one **by name** rather than silently, per
 * `ReviewerEdits`'s doc comment ("never actually applied"). This component
 * renders no control that could produce a `responseSpec` value; the
 * enumeration in `review-workspace-model.ts` is what a test asserts against,
 * not a promise kept by convention.
 *
 * **The stem editor starts from a blank draft, not the claimed version's
 * own content.** `body-draft.ts` has a `toContentBody` (draft → wire) but no
 * inverse yet — round-tripping an already-authored `ContentBody` back into
 * an editable draft is a real gap, not attempted here. The claimed stem
 * renders above the editor (read-only, via the same `ContentRenderer` the
 * rest of the workspace uses) so a reviewer edits with the original in
 * view, exactly as they would compare a diff.
 */

export interface InlineEditorProps {
  readonly stemPreview: JSX.Element;
  readonly currentTaxonomyTags: readonly TaxonomyTag[];
  readonly currentDifficultyEstimate: DifficultyBand;
  readonly onChange: (edits: ReviewerEdits | null) => void;
}

function freshTag(): TaxonomyTag {
  return { conceptIdentityId: '', taxonomyVersionId: '', weight: 1, isPrimary: false };
}

export function InlineEditor(props: InlineEditorProps): JSX.Element {
  const { stemPreview, currentTaxonomyTags, currentDifficultyEstimate, onChange } = props;

  const [editingStem, setEditingStem] = useState(false);
  const [stemDraft, setStemDraft] = useState<BodyDraft>(emptyBody());
  const [editingTags, setEditingTags] = useState(false);
  const [tags, setTags] = useState<readonly TaxonomyTag[]>(currentTaxonomyTags);
  const [editingDifficulty, setEditingDifficulty] = useState(false);
  const [difficulty, setDifficulty] = useState<DifficultyBand>(currentDifficultyEstimate);

  const emit = useCallback(
    (next: {
      readonly stemEnabled?: boolean;
      readonly stem?: BodyDraft;
      readonly tagsEnabled?: boolean;
      readonly tags?: readonly TaxonomyTag[];
      readonly difficultyEnabled?: boolean;
      readonly difficulty?: DifficultyBand;
    }): void => {
      const edits: ReviewerEdits = {
        ...((next.stemEnabled ?? editingStem) ? { stem: toContentBody(next.stem ?? stemDraft) } : {}),
        ...((next.tagsEnabled ?? editingTags) ? { taxonomyTags: next.tags ?? tags } : {}),
        ...((next.difficultyEnabled ?? editingDifficulty)
          ? { difficultyEstimate: next.difficulty ?? difficulty }
          : {}),
      };
      onChange(Object.keys(edits).length === 0 ? null : edits);
    },
    [editingStem, stemDraft, editingTags, tags, editingDifficulty, difficulty, onChange],
  );

  const forbiddenFields = useMemo(
    () => reviewerEditsWireFields().filter((field) => !(EDITABLE_FIELDS as readonly string[]).includes(field)),
    [],
  );

  return (
    <section aria-labelledby="inline-editor-heading">
      <h2 id="inline-editor-heading">Edit before approving</h2>
      <p>
        The answer key and response options cannot be edited from this screen. Return the item with{' '}
        <strong>Request changes</strong> if the author needs to change them.
      </p>

      <div>
        <input
          type="checkbox"
          id="edit-stem-toggle"
          checked={editingStem}
          onChange={(event) => {
            setEditingStem(event.target.checked);
            emit({ stemEnabled: event.target.checked });
          }}
        />
        <label htmlFor="edit-stem-toggle">Edit the stem</label>
        <div>{stemPreview}</div>
        {editingStem ? (
          <BodyEditor
            body={stemDraft}
            onChange={(next) => {
              setStemDraft(next);
              emit({ stem: next });
            }}
            idPrefix="reviewer-stem"
            label="Stem text"
            notationMode="latex"
          />
        ) : null}
      </div>

      <div>
        <input
          type="checkbox"
          id="edit-tags-toggle"
          checked={editingTags}
          onChange={(event) => {
            setEditingTags(event.target.checked);
            emit({ tagsEnabled: event.target.checked });
          }}
        />
        <label htmlFor="edit-tags-toggle">Edit taxonomy tags</label>
        {editingTags ? (
          <ul aria-label="Taxonomy tags">
            {tags.map((tag, index) => (
              // No stable id exists until a tag is saved, so the position is the key.
              <li key={index}>
                <label htmlFor={`tag-${index}-concept`}>{`Concept (tag ${index + 1})`}</label>
                <input
                  id={`tag-${index}-concept`}
                  value={tag.conceptIdentityId}
                  onChange={(event) => {
                    const next = tags.map((t, at) =>
                      at === index ? { ...t, conceptIdentityId: event.target.value } : t,
                    );
                    setTags(next);
                    emit({ tags: next });
                  }}
                />
                <label htmlFor={`tag-${index}-weight`}>{`Weight (tag ${index + 1})`}</label>
                <input
                  id={`tag-${index}-weight`}
                  type="number"
                  value={tag.weight}
                  onChange={(event) => {
                    const next = tags.map((t, at) =>
                      at === index ? { ...t, weight: Number(event.target.value) } : t,
                    );
                    setTags(next);
                    emit({ tags: next });
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = tags.filter((_, at) => at !== index);
                    setTags(next);
                    emit({ tags: next });
                  }}
                >
                  {`Remove tag ${index + 1}`}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => {
                  const next = [...tags, freshTag()];
                  setTags(next);
                  emit({ tags: next });
                }}
              >
                Add tag
              </button>
            </li>
          </ul>
        ) : null}
      </div>

      <div>
        <input
          type="checkbox"
          id="edit-difficulty-toggle"
          checked={editingDifficulty}
          onChange={(event) => {
            setEditingDifficulty(event.target.checked);
            emit({ difficultyEnabled: event.target.checked });
          }}
        />
        <label htmlFor="edit-difficulty-toggle">Edit difficulty estimate</label>
        {editingDifficulty ? (
          <>
            <label htmlFor="difficulty-select">Difficulty estimate</label>
            <select
              id="difficulty-select"
              value={difficulty}
              onChange={(event) => {
                const next = event.target.value as DifficultyBand;
                setDifficulty(next);
                emit({ difficulty: next });
              }}
            >
              {DifficultyBandSchema.options.map((band) => (
                <option key={band} value={band}>
                  {band}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {/* Not rendered — the enumeration itself, kept here only so a reader sees what this component deliberately never offers. */}
      <span hidden data-forbidden-fields={forbiddenFields.join(',')} />
    </section>
  );
}
