import { describe, expect, it } from 'vitest';
import { anEnvelopeForTest } from '../testing/analytics-rig.js';
import { createAnalyticsApi } from './analytics-api.js';

describe('the learner app\'s call to the ingestion edge', () => {
  it('posts the events to the analytics route and hands back what the edge said of each', async () => {
    const seen: unknown[] = [];
    const send = createAnalyticsApi({ request: async (options: unknown) => (seen.push(options), { results: [{ index: 0, outcome: 'accepted' }, { index: 1, outcome: 'quarantined', reason: 'PII' }] }), requestBytes: async () => { throw new Error('unused'); } } as never);
    const events = [anEnvelopeForTest(), anEnvelopeForTest()];
    expect(await send(events)).toEqual([{ index: 0, outcome: 'accepted' }, { index: 1, outcome: 'quarantined', reason: 'PII' }]);
    expect(seen).toMatchObject([{ method: 'POST', path: '/v1/analytics/events', body: { events } }]);
  });

  it('lets a failed request throw, so the emitter keeps what it sent', async () => {
    const send = createAnalyticsApi({ request: async () => Promise.reject(new TypeError('Failed to fetch')) } as never);
    await expect(send([anEnvelopeForTest()])).rejects.toThrow('Failed to fetch');
  });
});
