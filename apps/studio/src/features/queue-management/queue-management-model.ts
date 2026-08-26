/// <reference lib="dom" />
/**
 * The Content Ops queue management model (M4-41, DEC-M4-13, UX §11).
 *
 * **Filters live in the URL** (FRONTEND §5), the same `SearchParamStore`
 * shape `item-browser-model.ts` (M3-43) already established.
 *
 * **Aggregate throughput only — structurally, not by convention.** `QueueHealthView`
 * has no field a per-reviewer figure could occupy. `ReviewerThroughputResultSchema`
 * (the generated wire type) carries `perReviewer` — this model never reaches
 * for it, so there is nothing here a screen could render into a ranking by
 * forgetting to filter one out. `SORT_KEYS` is the complete, closed set of
 * keys the depth table may ever sort by; a test enumerates it directly
 * rather than trusting that nobody adds `decisionsPerHour` later.
 */

export interface QueueFilters {
  readonly subject: string | null;
}

export const NO_FILTERS: QueueFilters = Object.freeze({ subject: null });

export function filtersToSearch(filters: QueueFilters): string {
  const params = new URLSearchParams();
  if (filters.subject !== null) params.set('subject', filters.subject);
  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

export function filtersFromSearch(search: string): QueueFilters {
  const params = new URLSearchParams(search);
  const subject = params.get('subject');
  return { subject: subject === null || subject === '' ? null : subject };
}

/** Reading and writing the query string, so the surface needs no router (DEC-5) — the same port `item-browser-model.ts` declares. */
export interface SearchParamStore {
  read(): string;
  write(search: string): void;
}

export function browserSearchParams(): SearchParamStore {
  return {
    read: () => window.location.search,
    write: (search) => {
      window.history.replaceState(null, '', `${window.location.pathname}${search}`);
    },
  };
}

export const AGE_BANDS = ['fresh', 'warn', 'escalated'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export interface QueueDepthRow {
  readonly subject: string;
  readonly depth: number;
}

export interface AgeHistogramBucket {
  readonly band: AgeBand;
  readonly count: number;
}

export interface OverdueItem {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly stateEnteredAt: string;
  /** Tier-3-dependent (D36) — absent means "not yet swept", never "not overdue". */
  readonly notifiedAt?: string;
}

export interface AggregateThroughput {
  readonly decisionCount: number;
  readonly decisionsPerHour: number;
}

export interface QueueHealthView {
  readonly depthBySubject: readonly QueueDepthRow[];
  readonly ageHistogram: readonly AgeHistogramBucket[];
  readonly overdue: readonly OverdueItem[];
  readonly aggregateThroughput: AggregateThroughput;
  readonly asOf: string;
}

/** The only keys the depth table may ever sort by — closed, and named here rather than left to convention (DEC-M4-13). */
export const SORT_KEYS = ['subject', 'depth'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface QueueManagementApi {
  getQueueHealth(filters: QueueFilters): Promise<QueueHealthView>;
  reassign(itemVersionId: string, subject: string, reviewerId: string): Promise<void>;
}
