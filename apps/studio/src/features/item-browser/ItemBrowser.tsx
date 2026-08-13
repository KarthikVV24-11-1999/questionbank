import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  LIFECYCLE_STATES,
  NO_FILTERS,
  describeDuplicateCheck,
  draftsAreScopedToMe,
  effectiveFilters,
  filtersFromSearch,
  filtersToSearch,
  isLifecycleState,
  versionHistoryPath,
  type ItemBrowserApi,
  type ItemFilters,
  type ItemRow,
  type SearchParamStore,
  type ValidationReport,
} from './item-browser-model.js';

/**
 * The Item browser and the validation panel (M3-43).
 *
 * **Filters live in the URL**, so the screen is a link somebody can send
 * (FRONTEND §5). There is no router yet (DEC-5), so the query string is
 * reached through a small port — the router, when it exists, replaces the
 * port and nothing else.
 *
 * **The surface will not offer another author's drafts.** FR-TCH-06 rule 1 is
 * enforced by the server; what this adds is that nobody has to find out by
 * being refused — asking for drafts locks the author filter to the person
 * asking, and says so.
 */

export interface ItemBrowserProps {
  readonly api: ItemBrowserApi;
  readonly searchParams: SearchParamStore;
  readonly myPrincipalId: string;
}

export function ItemBrowser(props: ItemBrowserProps): JSX.Element {
  const { api, searchParams, myPrincipalId } = props;

  const [filters, setFilters] = useState<ItemFilters>(() => filtersFromSearch(searchParams.read()));
  const [rows, setRows] = useState<readonly ItemRow[] | null>(null);
  const [selected, setSelected] = useState<ItemRow | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);

  useEffect(() => {
    let current = true;
    void api.list(effectiveFilters(filters, myPrincipalId)).then((listed) => {
      if (current) setRows(listed);
    });
    return () => {
      current = false;
    };
  }, [api, filters, myPrincipalId]);

  const apply = useCallback(
    (next: ItemFilters): void => {
      setFilters(next);
      searchParams.write(filtersToSearch(next));
      setSelected(null);
      setReport(null);
    },
    [searchParams],
  );

  const toggleState = useCallback(
    (state: string): void => {
      if (!isLifecycleState(state)) return;
      const present = filters.lifecycleStates.includes(state);
      apply({
        ...filters,
        lifecycleStates: present
          ? filters.lifecycleStates.filter((existing) => existing !== state)
          : [...filters.lifecycleStates, state],
      });
    },
    [apply, filters],
  );

  const select = useCallback(
    async (row: ItemRow): Promise<void> => {
      setSelected(row);
      setReport(await api.validationReport(row.itemId));
    },
    [api],
  );

  const filtered =
    filters.lifecycleStates.length > 0 ||
    filters.subject !== null ||
    filters.conceptIdentityId !== null ||
    filters.authorPrincipalId !== null;

  const authorLocked = draftsAreScopedToMe(filters);
  const blocking = (report?.findings ?? []).filter((finding) => finding.severity === 'blocking');
  const warnings = (report?.findings ?? []).filter((finding) => finding.severity === 'warning');

  return (
    <main>
      <h1>Items</h1>

      <section aria-labelledby="filters-heading">
        <h2 id="filters-heading">Filters</h2>

        <fieldset>
          <legend>Lifecycle state</legend>
          {LIFECYCLE_STATES.map((state) => (
            <span key={state}>
              <input
                type="checkbox"
                id={`state-${state}`}
                checked={filters.lifecycleStates.includes(state)}
                onChange={() => toggleState(state)}
              />
              <label htmlFor={`state-${state}`}>{state.replace(/_/gu, ' ')}</label>
            </span>
          ))}
        </fieldset>

        <label htmlFor="filter-subject">Subject</label>
        <input
          id="filter-subject"
          value={filters.subject ?? ''}
          onChange={(event) =>
            apply({ ...filters, subject: event.target.value === '' ? null : event.target.value })
          }
        />

        <label htmlFor="filter-concept">Concept</label>
        <input
          id="filter-concept"
          value={filters.conceptIdentityId ?? ''}
          onChange={(event) =>
            apply({
              ...filters,
              conceptIdentityId: event.target.value === '' ? null : event.target.value,
            })
          }
        />

        <label htmlFor="filter-author">Author</label>
        <input
          id="filter-author"
          value={authorLocked ? myPrincipalId : filters.authorPrincipalId ?? ''}
          disabled={authorLocked}
          aria-describedby={authorLocked ? 'filter-author-scope' : undefined}
          onChange={(event) =>
            apply({
              ...filters,
              authorPrincipalId: event.target.value === '' ? null : event.target.value,
            })
          }
        />
        {authorLocked ? (
          <p id="filter-author-scope">
            Drafts are visible only to their author, so this filter is fixed to you while drafts are
            included.
          </p>
        ) : null}

        <button type="button" onClick={() => apply(NO_FILTERS)}>
          Clear filters
        </button>
      </section>

      <section aria-labelledby="results-heading">
        <h2 id="results-heading">Results</h2>

        {rows === null ? (
          <p role="status">Loading items…</p>
        ) : rows.length === 0 ? (
          // Designed, not defaulted (UX §12): an empty state offers an action
          // or explains what will fill it — a filter that matched nothing is a
          // different situation from a corpus that is empty.
          filtered ? (
            <div>
              <p>No items match these filters.</p>
              <button type="button" onClick={() => apply(NO_FILTERS)}>
                Show every item instead
              </button>
            </div>
          ) : (
            <p>No items yet. The first draft you create will appear here.</p>
          )
        ) : (
          <ul aria-label="Items">
            {rows.map((row) => (
              <li key={row.itemId}>
                <button type="button" onClick={() => void select(row)}>
                  {`${row.label} — ${row.lifecycleState.replace(/_/gu, ' ')}`}
                </button>
                {row.publishedVersionNo === null ? null : (
                  <>
                    <span>{`Published version ${row.publishedVersionNo}`}</span>
                    <a href={versionHistoryPath(row.itemId)}>
                      {`Version history and diffs for ${row.label}`}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="validation-heading">
        <h2 id="validation-heading">Validation</h2>
        {selected === null || report === null ? (
          <p>Choose an item to see its findings.</p>
        ) : (
          <>
            <h3>{`Blocking (${blocking.length})`}</h3>
            {blocking.length === 0 ? (
              <p>Nothing blocking.</p>
            ) : (
              <ul aria-label="Blocking findings">
                {blocking.map((finding) => (
                  <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
                ))}
              </ul>
            )}

            <h3>{`Warnings (${warnings.length})`}</h3>
            {warnings.length === 0 ? (
              <p>No warnings.</p>
            ) : (
              <ul aria-label="Warning findings">
                {warnings.map((finding) => (
                  <li key={finding.code}>{`${finding.message} (${finding.location})`}</li>
                ))}
              </ul>
            )}

            <p>{describeDuplicateCheck(report.duplicateCheckState)}</p>
          </>
        )}
      </section>
    </main>
  );
}
