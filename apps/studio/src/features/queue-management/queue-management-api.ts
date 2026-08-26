import { createClient, type ApiClient } from '@questionbank/contracts/client';
import {
  QueueHealthResultSchema,
  ReviewAssignmentSchema,
  ReviewerThroughputResultSchema,
} from '@questionbank/contracts/content-schemas';
import type { QueueFilters, QueueHealthView, QueueManagementApi } from './queue-management-model.js';

/**
 * The live `QueueManagementApi` (M4-41). `GetQueueHealth` and
 * `GetReviewerThroughput` (M4-33) carry no subject parameter — both return
 * every subject at once — so `subject` filtering happens client-side over
 * the same response, the same "narrower than the port" discipline
 * `item-browser-api.ts` documents for its own D33 gap. The age histogram is
 * global in the wire response (never subject-scoped), so it is never
 * filtered — showing a subject-scoped histogram would mean fabricating one.
 *
 * **`perReviewer` is never read, let alone rendered (DEC-M4-13).** The
 * response carries it; this adapter destructures only `.aggregate`. A
 * screen that never receives per-reviewer data cannot render it by
 * accident.
 *
 * **Throughput's range defaults to the last 24 hours**, computed here — a
 * sound, reversible UI choice, not a domain fact; `GetReviewerThroughput`'s
 * `from`/`to` are ordinary required parameters with no default of their own.
 */

const THROUGHPUT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface LiveQueueManagementApiConfig {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly client?: ApiClient;
  /** Overridable so a spec never depends on the real clock. */
  readonly now?: () => Date;
}

export function createLiveQueueManagementApi(config: LiveQueueManagementApiConfig): QueueManagementApi {
  const client = config.client ?? createClient({ baseUrl: config.baseUrl, getToken: config.getToken });
  const now = config.now ?? (() => new Date());

  return {
    async getQueueHealth(filters: QueueFilters): Promise<QueueHealthView> {
      const to = now();
      const from = new Date(to.getTime() - THROUGHPUT_WINDOW_MS);

      const [health, throughput] = await Promise.all([
        client.request({ path: '/v1/authoring/review/queue-health', responseSchema: QueueHealthResultSchema }),
        client.request({
          path: '/v1/authoring/review/reviewer-throughput',
          query: { from: from.toISOString(), to: to.toISOString() },
          responseSchema: ReviewerThroughputResultSchema,
        }),
      ]);

      const matchesSubject = (subject: string): boolean => filters.subject === null || subject === filters.subject;

      return {
        depthBySubject: health.depthBySubject.filter((row) => matchesSubject(row.subject)),
        ageHistogram: health.ageHistogram,
        overdue: health.overdue
          .filter((item) => matchesSubject(item.subject))
          .map((item) => ({
            itemId: item.itemId,
            itemVersionId: item.itemVersionId,
            subject: item.subject,
            stateEnteredAt: item.stateEnteredAt,
            ...(item.notifiedAt === undefined ? {} : { notifiedAt: item.notifiedAt }),
          })),
        aggregateThroughput: throughput.aggregate,
        asOf: health.asOf,
      };
    },

    async reassign(itemVersionId: string, subject: string, reviewerId: string): Promise<void> {
      await client.request({
        path: `/v1/authoring/review/item-versions/${itemVersionId}/assignment`,
        method: 'POST',
        body: { subject, reviewerId },
        responseSchema: ReviewAssignmentSchema,
      });
    },
  };
}
