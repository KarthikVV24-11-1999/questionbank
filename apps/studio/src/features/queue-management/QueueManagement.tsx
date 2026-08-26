import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  AGE_BANDS,
  NO_FILTERS,
  filtersFromSearch,
  filtersToSearch,
  type OverdueItem,
  type QueueFilters,
  type QueueHealthView,
  type QueueManagementApi,
  type SearchParamStore,
} from './queue-management-model.js';

/**
 * The Content Ops queue management surface (M4-41, UX §11, DEC-M4-13).
 *
 * **Aggregate throughput only, capacity planning never a leaderboard.**
 * `QueueHealthView` (`queue-management-model.ts`) carries no per-reviewer
 * figure at all — there is no prop, no state and no JSX here that could
 * turn into a ranking, because there is nothing to rank with.
 *
 * **Filters live in the URL**, the same port `item-browser` (M3-43) already
 * uses — a screen filtered to physics's escalated items is a link, not a
 * description of how to reproduce it.
 */

export interface QueueManagementProps {
  readonly api: QueueManagementApi;
  readonly searchParams: SearchParamStore;
}

function AssignReviewerForm(props: {
  readonly item: OverdueItem;
  readonly onReassign: (subject: string, reviewerId: string) => Promise<void>;
}): JSX.Element {
  const { item, onReassign } = props;
  const [reviewerId, setReviewerId] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const fieldId = `reassign-${item.itemVersionId}`;

  const submit = useCallback(async (): Promise<void> => {
    if (reviewerId.trim().length === 0) return;
    setStatus('sending');
    try {
      await onReassign(item.subject, reviewerId.trim());
      setStatus('sent');
    } catch {
      setStatus('failed');
    }
  }, [item.subject, onReassign, reviewerId]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={fieldId}>{`Reassign ${item.subject} item to reviewer`}</label>
      <input id={fieldId} value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} />
      <button type="submit" disabled={status === 'sending' || reviewerId.trim().length === 0}>
        Reassign
      </button>
      {status === 'sent' ? <span role="status">Reassigned.</span> : null}
      {status === 'failed' ? <span role="alert">Could not reassign. Try again.</span> : null}
    </form>
  );
}

export function QueueManagement(props: QueueManagementProps): JSX.Element {
  const { api, searchParams } = props;

  const [filters, setFilters] = useState<QueueFilters>(() => filtersFromSearch(searchParams.read()));
  const [health, setHealth] = useState<QueueHealthView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api.getQueueHealth(filters).then(
      (view) => {
        if (alive) setHealth(view);
      },
      () => {
        if (alive) setLoadError('The queue could not be loaded. Try again.');
      },
    );
    return () => {
      alive = false;
    };
  }, [api, filters]);

  const apply = useCallback(
    (next: QueueFilters): void => {
      setFilters(next);
      searchParams.write(filtersToSearch(next));
    },
    [searchParams],
  );

  const reassign = useCallback(
    async (item: OverdueItem, subject: string, reviewerId: string): Promise<void> => {
      await api.reassign(item.itemVersionId, subject, reviewerId);
    },
    [api],
  );

  const filtered = filters.subject !== null;

  return (
    <main>
      <h1>Queue management</h1>

      <section aria-labelledby="filters-heading">
        <h2 id="filters-heading">Filters</h2>
        <label htmlFor="filter-subject">Subject</label>
        <input
          id="filter-subject"
          value={filters.subject ?? ''}
          onChange={(event) => apply({ subject: event.target.value === '' ? null : event.target.value })}
        />
        <button type="button" onClick={() => apply(NO_FILTERS)}>
          Clear filters
        </button>
      </section>

      {loadError !== null ? <p role="alert">{loadError}</p> : null}

      {health === null ? (
        <p role="status">Loading queue health…</p>
      ) : (
        <>
          <section aria-labelledby="depth-heading">
            <h2 id="depth-heading">Depth by subject</h2>
            {health.depthBySubject.length === 0 ? (
              filtered ? (
                <div>
                  <p>No subject matches this filter.</p>
                  <button type="button" onClick={() => apply(NO_FILTERS)}>
                    Show every subject instead
                  </button>
                </div>
              ) : (
                // Designed, not defaulted (UX §12): a cold queue is this product's first week.
                <p>Nothing is in review yet. Depth will appear here once items are submitted.</p>
              )
            ) : (
              <table>
                <caption>Queue depth, by subject — capacity planning, never a per-reviewer figure</caption>
                <thead>
                  <tr>
                    <th scope="col">Subject</th>
                    <th scope="col">Depth</th>
                  </tr>
                </thead>
                <tbody>
                  {health.depthBySubject.map((row) => (
                    <tr key={row.subject}>
                      <td>{row.subject}</td>
                      <td>{row.depth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="histogram-heading">
            <h2 id="histogram-heading">Age</h2>
            <ul aria-label="Age histogram">
              {AGE_BANDS.map((band) => {
                const bucket = health.ageHistogram.find((entry) => entry.band === band);
                return <li key={band}>{`${band}: ${bucket?.count ?? 0}`}</li>;
              })}
            </ul>
          </section>

          <section aria-labelledby="overdue-heading">
            <h2 id="overdue-heading">Overdue</h2>
            {health.overdue.length === 0 ? (
              <p>Nothing is overdue right now.</p>
            ) : (
              <ul aria-label="Overdue items">
                {health.overdue.map((item) => (
                  <li key={item.itemVersionId}>
                    <p>
                      {`${item.subject} — entered review ${item.stateEnteredAt}`}
                      {item.notifiedAt === undefined
                        ? ' (Content Ops not yet notified)'
                        : ` (notified ${item.notifiedAt})`}
                    </p>
                    <AssignReviewerForm
                      item={item}
                      onReassign={(subject, reviewerId) => reassign(item, subject, reviewerId)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="throughput-heading">
            <h2 id="throughput-heading">Throughput (last 24 hours, aggregate)</h2>
            <p>
              {`${health.aggregateThroughput.decisionCount} decisions, ${health.aggregateThroughput.decisionsPerHour.toFixed(2)} per hour across the whole team.`}
            </p>
            <p>{`As of ${health.asOf}.`}</p>
          </section>
        </>
      )}
    </main>
  );
}
