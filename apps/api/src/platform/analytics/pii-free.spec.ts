import { resolve } from 'node:path';
import { findPii, isPersonalKey } from '@questionbank/contracts/analytics';
import { describe, expect, it } from 'vitest';
import { readCatalog } from '../../fitness/event-catalog.js';
import { anEnvelope, PLANTED_PII } from '../../testing/analytics-fixtures.js';
import { AnalyticsEdge } from './edge.js';
import { MemorySink } from './sink.js';

/**
 * The analytics side of the PII gate (EVENT-TAXONOMY §1 rule 1), the rows of docs/PII-FREE.md that live in the API: the catalog, the envelope, what the edge
 * accepts and what it keeps of what it refuses. Each row has a test that shows personal data absent and a test that shows the scan able to find some.
 */
const CATALOG = readCatalog(resolve(import.meta.dirname, '../../../../../docs/EVENT-TAXONOMY.md'));
const plants = Object.entries(PLANTED_PII);

describe('the catalog', () => {
  it('names no field of the catalog a personal detail', () => {
    const personal = CATALOG.flatMap((event) => event.payloadKeys.filter(isPersonalKey).map((key) => `${event.name}.${key}`));
    expect(personal).toEqual([]);
    expect(CATALOG.reduce((sum, event) => sum + event.payloadKeys.length, 0)).toBeGreaterThan(100);
  });

  it('finds a personal field planted in a catalog row', () => {
    const planted = [...CATALOG, { name: 'planted.thing_happened', owner: 'M7', payloadKeys: ['seconds', 'email'] }];
    expect(planted.flatMap((event) => event.payloadKeys.filter(isPersonalKey).map((key) => `${event.name}.${key}`))).toEqual(['planted.thing_happened.email']);
  });
});

describe('the envelope', () => {
  it('finds none in an envelope built for every catalog name', () => {
    for (const event of CATALOG) {
      const envelope = anEnvelope({ event_name: event.name as never, payload: Object.fromEntries(event.payloadKeys.map((key) => [key, 1])) });
      expect(findPii(envelope), event.name).toEqual([]);
    }
  });

  it('finds a planted name, email and phone in an envelope field, a payload field and a context field', () => {
    for (const [kind, value] of plants) {
      const where = {
        payload: anEnvelope({ payload: { label: value } }),
        context: anEnvelope({ context: { attempt_id: value } }),
        envelope: anEnvelope({ session_id: value }),
        actor: anEnvelope({ actor: { kind: 'human', pseudonymous_id: value } }),
      };
      for (const [field, envelope] of Object.entries(where)) expect(findPii(envelope).length, `${kind} in ${field}`).toBeGreaterThan(0);
    }
    expect(findPii(anEnvelope({ payload: { full_name: 1 } }))).toEqual([{ path: '$.payload.full_name', kind: 'key' }]);
  });
});

describe('the edge', () => {
  it('writes nothing personal to the sink for the events it accepts', async () => {
    const sink = new MemorySink();
    const edge = new AnalyticsEdge(sink, () => new Date('2026-10-29T09:00:00.000Z'));
    for (const event of CATALOG) expect((await edge.admit(fresh(event.name, event.payloadKeys))).outcome, event.name).toBe('accepted');
    expect(sink.events.length).toBe(CATALOG.length);
    expect(findPii(sink.events)).toEqual([]);
  });

  it('refuses an event carrying a planted name, email or phone in any field', async () => {
    const edge = new AnalyticsEdge(new MemorySink(), () => new Date());
    for (const [kind, value] of plants) {
      for (const envelope of [anEnvelope({ payload: { label: value } }), anEnvelope({ context: { form_id: value } }), anEnvelope({ session_id: value })]) {
        expect(await edge.admit(envelope), kind).toEqual({ outcome: 'quarantined', reason: 'PII' });
      }
    }
    expect(edge.stats().quarantined.PII).toBe(plants.length * 3);
  });
});

describe('the quarantine', () => {
  it('keeps the path and the kind of what it refused and never the value', async () => {
    const edge = new AnalyticsEdge(new MemorySink(), () => new Date());
    for (const [, value] of plants) await edge.admit(anEnvelope({ payload: { label: value } }));
    const kept = JSON.stringify(edge.quarantined());
    for (const [, value] of plants) expect(kept).not.toContain(value);
    // the entries are sentences about a field, so the free-text check does not apply to them; an address or a number to ring would still show
    expect(kept).not.toMatch(/@|\d{7,}/u);
    expect(edge.quarantined().map((entry) => entry.issues)).toEqual([['$.payload.label: free-text'], ['$.payload.label: email'], ['$.payload.label: phone']]);
  });

  it('has the planted values in what was sent, so the absence above is not a scan of nothing', async () => {
    const sent = anEnvelope({ payload: { label: PLANTED_PII.email } });
    expect(JSON.stringify(sent)).toContain(PLANTED_PII.email);
    const edge = new AnalyticsEdge(new MemorySink(), () => new Date());
    await edge.admit(sent);
    expect(findPii({ ...edge.quarantined()[0], leaked: PLANTED_PII.email }).length).toBeGreaterThan(0);
  });
});

function fresh(name: string, keys: readonly string[]) {
  return anEnvelope({ event_name: name as never, payload: Object.fromEntries(keys.map((key) => [key, 1])) });
}
