import type { ApiClient } from '@questionbank/contracts/client';
import type { ClientEnvelope } from '@questionbank/contracts/analytics';
import { z } from 'zod';

const answerSchema = z.object({ results: z.array(z.object({ index: z.number().int(), outcome: z.string(), reason: z.string().optional() })) });

/** The learner app's one call to the ingestion edge. Anything but a 2xx throws, and the emitter keeps what it sent. */
export function createAnalyticsApi(client: ApiClient): (events: readonly ClientEnvelope[]) => Promise<ReadonlyArray<{ index: number; outcome: string }>> {
  return async (events) => (await client.request({ method: 'POST', path: '/v1/analytics/events', body: { events }, responseSchema: answerSchema })).results;
}
