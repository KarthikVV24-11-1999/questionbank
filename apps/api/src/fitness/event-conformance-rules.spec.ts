import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { aServerEnvelope, anEnvelope, PLANTED_PII } from '../testing/analytics-fixtures.js';
import { checkConformanceIndex, emittedNamesIn, measureConformance, parseConformanceTable, readEventLog } from './event-conformance.js';
import { readCatalog } from './event-catalog.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOCUMENT = readFileSync(resolve(ROOT, 'docs/EVENT-CONFORMANCE.md'), 'utf8');
const CATALOG = readCatalog(resolve(ROOT, 'docs/EVENT-TAXONOMY.md'));
const OWNED = CATALOG.filter((event) => event.owner === 'M7').map((event) => event.name);
const EMITTED = emittedNamesIn([resolve(ROOT, 'apps/learn/src'), resolve(ROOT, 'apps/api/src')], CATALOG);
const FILE = 'apps/api/src/fitness/event-conformance-rules.spec.ts';
const wired = (event: string, emitted: string, canFail: string) => `| \`${event}\` | wired | \`${FILE}\` :: ${emitted} | \`${FILE}\` :: ${canFail} | — |`;
const notWired = (event: string, reason: string) => `| \`${event}\` | not wired | — | — | ${reason} |`;
const rules = (document: string, owned = ['x.one'], emitted: string[] = []) => checkConformanceIndex(ROOT, document, owned, emitted).map((v) => v.rule);

/** The envelope each wired event is emitted with, as the call site builds it. */
const EMITTED_AS = {
  'mastery.gain_verified': { payload: { concept_identity_id: '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a', days_to_verify: 3.5, evidence_count: 10 }, surface: 'server' as const },
  'mock.diagnostic_viewed': { payload: { findings_shown: 2, deepest_drill_level: 0 }, surface: 'web' as const },
  'mock.remediation_clicked': { payload: { finding_rank: 1, hours_after_result: 1.99 }, surface: 'web' as const },
  'practice.session_started': { payload: { selection_strategy: 'filtered', source: 'remediation', concept_ids: ['5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a'], item_count: 10 }, surface: 'web' as const },
};

/** A good envelope for the event passes the check; the same envelope damaged in each way the edge refuses is counted as not conforming, with the reason. */
async function expectCheckCatches(event: keyof typeof EMITTED_AS): Promise<void> {
  const { surface, payload } = EMITTED_AS[event];
  const good = surface === 'server' ? aServerEnvelope({ event_name: event, payload }) : anEnvelope({ event_name: event, payload });
  expect(await measureConformance([good])).toMatchObject({ total: 1, conforming: 1 });

  const missing = { ...good } as Record<string, unknown>;
  delete missing['tenant_id'];
  const bad = [missing, { ...good, event_name: 'ad_hoc.thing_clicked' }, { ...good, payload: { ...good.payload, contact: PLANTED_PII.email } }];
  const measured = await measureConformance([good, ...bad.map((envelope) => ({ ...envelope, event_id: anEnvelope().event_id }))]);
  expect(measured).toMatchObject({ total: 4, conforming: 1, byReason: { INVALID_ENVELOPE: 1, UNKNOWN_EVENT_NAME: 1, PII: 1 } });
  expect(measured.byEvent[event]).toEqual({ emitted: 3, conforming: 1 });
}

describe('the conformance table (M7-63)', () => {
  it('has a row for every event M7 owns, wired exactly where shipped source emits the name, with tests that exist and run', () => {
    expect(parseConformanceTable(DOCUMENT).map((row) => row.event).sort()).toEqual([...OWNED].sort());
    expect(EMITTED).toEqual(['mastery.gain_verified', 'mock.diagnostic_viewed', 'mock.remediation_clicked', 'practice.session_started']);
    expect(checkConformanceIndex(ROOT, DOCUMENT, OWNED, EMITTED)).toEqual([]);
  });

  describe('is red on a planted violation', () => {
    it('an owned event with no row, and a row for an event nobody owns', () => {
      expect(rules(notWired('x.two', 'because (D92)'), ['x.one'])).toEqual(['EVENT_ROW_MISSING', 'EVENT_ROW_UNKNOWN']);
    });

    it('a wired event missing one of its tests, and one test claimed for both', () => {
      expect(rules(`| \`x.one\` | wired | \`${FILE}\` :: a row | — | — |`, ['x.one'], ['x.one'])).toEqual(['WIRED_WITHOUT_BOTH_TESTS']);
      expect(rules(wired('x.one', 'a row that is not wired and gives no reason', 'a row that is not wired and gives no reason'), ['x.one'], ['x.one'])).toEqual(['ONE_TEST_FOR_BOTH']);
    });

    it('a test renamed away, and a file that is gone', () => {
      const document = `| \`x.one\` | wired | \`${FILE}\` :: a test that is ${'not'} there | \`apps/api/src/no-such-file.spec.ts\` :: x | — |`;
      expect(rules(document, ['x.one'], ['x.one']).sort()).toEqual(['EVIDENCE_FILE_MISSING', 'EVIDENCE_TEST_MISSING'].sort());
    });

    it('a row that is not wired and gives no reason', () => {
      expect(rules(notWired('x.one', '—'))).toEqual(['NOT_WIRED_WITHOUT_REASON']);
    });

    it('an event that shipped source emits and the table says is not wired, and a wired row no source emits', () => {
      expect(rules(notWired('x.one', 'because (D92)'), ['x.one'], ['x.one'])).toEqual(['EMITTED_BUT_NOT_WIRED_IN_TABLE']);
      expect(rules(wired('x.one', 'a row that is not wired and gives no reason', 'a test renamed away, and a file that is gone'), ['x.one'], [])).toEqual(['WIRED_IN_TABLE_BUT_NOT_EMITTED']);
    });
  });
});

describe('the conformance check can fail', () => {
  it('catches a planted bad envelope for mastery.gain_verified', async () => expectCheckCatches('mastery.gain_verified'));
  it('catches a planted bad envelope for mock.diagnostic_viewed', async () => expectCheckCatches('mock.diagnostic_viewed'));
  it('catches a planted bad envelope for mock.remediation_clicked', async () => expectCheckCatches('mock.remediation_clicked'));
  it('catches a planted bad envelope for practice.session_started', async () => expectCheckCatches('practice.session_started'));

  it('counts a replay of the same event as the same fact, and a log line back into events', async () => {
    const event = anEnvelope();
    expect(await measureConformance([event, event])).toMatchObject({ total: 2, conforming: 2 });
    expect(readEventLog(`${JSON.stringify({ source: 'learn', event })}\n\n${JSON.stringify({ source: 'api', event })}\n`).map((line) => line.source)).toEqual(['learn', 'api']);
  });
});
