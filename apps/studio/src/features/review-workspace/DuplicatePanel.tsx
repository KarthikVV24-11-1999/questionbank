import type { JSX } from 'react';
import type { DuplicateCandidate, DuplicateGroups } from './review-workspace-model.js';

/**
 * The duplicate panel (M4-40, DEC-M4-2).
 *
 * **Three labelled groups, always in this order, never merged**: exact
 * retype, same skeleton with different constants, merely similar. A
 * reviewer disagreeing with the machine needs to see which machine spoke —
 * an exact match and a rank-10 trigram neighbour are not the same finding,
 * and a merged list makes them look like one.
 *
 * **Selecting a candidate cites it.** The citation this panel produces is
 * exactly what `DecisionBar`/`ReviewWorkspace` hand `RecordItemReviewDecision`
 * as `duplicateOfItemId` (M4-07) — there is no second place a citation is
 * recorded from.
 */

export interface DuplicatePanelProps {
  readonly duplicates: DuplicateGroups;
  readonly selectedItemId: string | null;
  readonly onSelect: (itemId: string | null) => void;
}

function GroupList(props: {
  readonly label: string;
  readonly candidates: readonly DuplicateCandidate[];
  readonly selectedItemId: string | null;
  readonly onSelect: (itemId: string | null) => void;
  readonly showSimilarity: boolean;
}): JSX.Element {
  const { label, candidates, selectedItemId, onSelect, showSimilarity } = props;
  return (
    <section aria-labelledby={`duplicate-group-${label}`}>
      <h3 id={`duplicate-group-${label}`}>{`${label} (${candidates.length})`}</h3>
      {candidates.length === 0 ? (
        <p>None found.</p>
      ) : (
        <ul aria-label={`${label} candidates`}>
          {candidates.map((candidate) => {
            const selected = selectedItemId === candidate.itemId;
            return (
              <li key={candidate.itemVersionId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(selected ? null : candidate.itemId)}
                >
                  {`${candidate.subject} — ${candidate.itemId}`}
                  {showSimilarity && candidate.similarity !== undefined
                    ? ` (${Math.round(candidate.similarity * 100)}% similar)`
                    : ''}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function DuplicatePanel(props: DuplicatePanelProps): JSX.Element {
  const { duplicates, selectedItemId, onSelect } = props;

  return (
    <section aria-labelledby="duplicate-panel-heading">
      <h2 id="duplicate-panel-heading">Duplicate candidates</h2>

      {duplicates.state === 'not_evaluated' ? (
        <p>Duplicate detection has not run for this item yet.</p>
      ) : (
        <>
          <p>
            {duplicates.computedAt === undefined
              ? `As of ${duplicates.asOf}.`
              : `Computed ${duplicates.computedAt}, as of ${duplicates.asOf}.`}
          </p>
          <GroupList
            label="Exact"
            candidates={duplicates.exact}
            selectedItemId={selectedItemId}
            onSelect={onSelect}
            showSimilarity={false}
          />
          <GroupList
            label="Same skeleton, different constants"
            candidates={duplicates.skeleton}
            selectedItemId={selectedItemId}
            onSelect={onSelect}
            showSimilarity={false}
          />
          <GroupList
            label="Similar"
            candidates={duplicates.trigram}
            selectedItemId={selectedItemId}
            onSelect={onSelect}
            showSimilarity
          />
        </>
      )}
    </section>
  );
}
