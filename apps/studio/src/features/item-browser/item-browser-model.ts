/// <reference lib="dom" />
// The one DOM-touching export in this file (`browserSearchParams`) is
// reached transitively by `apps/api`'s M0-19 live-wiring integration spec,
// whose own tsconfig carries no "DOM" lib — this per-file reference keeps
// that cross-package import type-checkable without widening apps/api's
// project-wide lib list for a decision that belongs to this file alone.
import {
  LifecycleStateSchema,
  type LifecycleState,
} from '@questionbank/contracts/content-schemas';

/**
 * The Item browser's model (M3-43).
 *
 * **Filters live in the URL** (FRONTEND §5): if a refresh loses it, it
 * belonged in the URL. A reviewer sending "the eleven physics items awaiting
 * changes" to a colleague sends a link, not a description of how to reproduce
 * a screen.
 *
 * **Search state is typed and validated, not parsed ad hoc** (FRONTEND §8). An
 * unrecognised lifecycle value in a hand-edited URL is dropped here rather
 * than forwarded to the server, because a filter nobody can name is a query
 * whose result nobody can explain.
 */

export const LIFECYCLE_STATES = LifecycleStateSchema.options;
export type { LifecycleState };

export function isLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export interface ItemFilters {
  readonly lifecycleStates: readonly LifecycleState[];
  readonly subject: string | null;
  readonly conceptIdentityId: string | null;
  readonly authorPrincipalId: string | null;
}

export const NO_FILTERS: ItemFilters = Object.freeze({
  lifecycleStates: [],
  subject: null,
  conceptIdentityId: null,
  authorPrincipalId: null,
});

export function filtersToSearch(filters: ItemFilters): string {
  const params = new URLSearchParams();
  for (const state of filters.lifecycleStates) params.append('state', state);
  if (filters.subject !== null) params.set('subject', filters.subject);
  if (filters.conceptIdentityId !== null) params.set('concept', filters.conceptIdentityId);
  if (filters.authorPrincipalId !== null) params.set('author', filters.authorPrincipalId);

  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

export function filtersFromSearch(search: string): ItemFilters {
  const params = new URLSearchParams(search);
  const subject = params.get('subject');
  const concept = params.get('concept');
  const author = params.get('author');

  return {
    // An unknown state is dropped rather than passed on: the server would
    // refuse it, and the author would be told their filter is invalid rather
    // than that the value never meant anything.
    lifecycleStates: params.getAll('state').filter(isLifecycleState),
    subject: subject === null || subject === '' ? null : subject,
    conceptIdentityId: concept === null || concept === '' ? null : concept,
    authorPrincipalId: author === null || author === '' ? null : author,
  };
}

/** Reading and writing the query string, so the browser needs no router (DEC-5). */
export interface SearchParamStore {
  read(): string;
  write(search: string): void;
}

/**
 * The real one. `replaceState` rather than `pushState`: typing into a filter
 * should not fill the back button with one entry per keystroke.
 */
export function browserSearchParams(): SearchParamStore {
  return {
    read: () => window.location.search,
    write: (search) => {
      window.history.replaceState(null, '', `${window.location.pathname}${search}`);
    },
  };
}

/**
 * Whether the filter set asks for drafts.
 *
 * Drafts are visible only to their author and Content Ops (FR-TCH-06 rule 1).
 * The server enforces it; the surface refuses to *offer* another author's
 * drafts, so nobody has to discover the rule by being refused.
 */
export function draftsAreScopedToMe(filters: ItemFilters): boolean {
  return filters.lifecycleStates.includes('draft');
}

/** The filters as they will actually be queried, with the draft scope applied. */
export function effectiveFilters(filters: ItemFilters, myPrincipalId: string): ItemFilters {
  if (!draftsAreScopedToMe(filters)) return filters;
  return { ...filters, authorPrincipalId: myPrincipalId };
}

export interface ItemRow {
  readonly itemId: string;
  readonly label: string;
  readonly lifecycleState: LifecycleState;
  readonly subject: string;
  readonly authorPrincipalId: string;
  /** Present exactly when the item has a published version (FR-QM-02 rule 4). */
  readonly publishedVersionNo: number | null;
}

/** Where the version history with diffs lives. A path, not a router call. */
export function versionHistoryPath(itemId: string): string {
  return `/authoring/items/${itemId}/history`;
}

export interface ValidationFinding {
  readonly code: string;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly location: string;
}

export interface ValidationReport {
  readonly findings: readonly ValidationFinding[];
  readonly maySubmit: boolean;
  /** `not_evaluated` until M4 wires FR-QM-04 (DEC-7). */
  readonly duplicateCheckState: string;
}

/**
 * What the panel says about duplicate detection.
 *
 * **Never "none found".** A report claiming no duplicates when the check never
 * ran is a claim a reviewer acts on, and M4 owns the check (DEC-7).
 */
export function describeDuplicateCheck(state: string): string {
  if (state === 'not_evaluated') return 'Duplicate detection has not run. It arrives with the review workspace.';
  if (state === 'none_found') return 'Duplicate detection ran and found no candidates.';
  return 'Duplicate detection found candidates.';
}

export interface ItemBrowserApi {
  list(filters: ItemFilters): Promise<readonly ItemRow[]>;
  validationReport(itemId: string): Promise<ValidationReport>;
}
