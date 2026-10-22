import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { logFromEvents, mergeLogs, sameEvent, type ResponseEvent } from '@questionbank/attempt-engine';
import { mergeIncoming, toEngineEvent } from '../contexts/assessment/domain/response-log.js';
import type { ResponseEvent as ServerEvent } from '../contexts/assessment/domain/response-event.js';
import { EVENT_ID_BOOKKEEPING_ALLOWED, checkRel06HasOneHome } from './rel06-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');
const ROOTS = ['apps/api/src', 'packages/attempt-engine/src'];

describe('REL-06 has one home (ADR-0035)', () => {
  it('finds no second implementation of set union by event id in the shipped source', () => {
    expect(checkRel06HasOneHome(WORKSPACE, ROOTS)).toEqual([]);
  });

  it('lists only modules that exist, so the exemptions cannot rot', () => {
    for (const file of Object.keys(EVENT_ID_BOOKKEEPING_ALLOWED)) expect(existsSync(join(WORKSPACE, file)), file).toBe(true);
  });

  it('says where the one implementation is: the engine declares both halves, and the server\'s domain imports it', () => {
    const engineMerge = readFileSync(join(WORKSPACE, 'packages/attempt-engine/src/merge.ts'), 'utf8');
    const engineLog = readFileSync(join(WORKSPACE, 'packages/attempt-engine/src/response-log.ts'), 'utf8');
    expect(engineMerge).toMatch(/export function mergeLogs\b/u);
    expect(engineLog).toMatch(/export function logFromEvents\b/u);
    const server = readFileSync(join(API_ROOT, 'src/contexts/assessment/domain/response-log.ts'), 'utf8');
    expect(server).toContain("from '@questionbank/attempt-engine'");
    expect(server).toMatch(/\bmergeLogs\(/u);
  });

  describe('is red on a planted second implementation', () => {
    const fixtures = join(API_ROOT, 'src/fitness-fixtures');
    const run = (file: string) => checkRel06HasOneHome(fixtures, ['as-rel06'].map((dir) => dir), {}).filter((violation) => violation.file.endsWith(file));

    it('under the engine\'s own name', () => {
      expect(run('planted-second-union.ts')).toEqual([expect.objectContaining({ rule: 'REL06_SECOND_UNION_IMPLEMENTATION', detail: 'declares mergeLogs' })]);
    });

    it('under another name, by what it does', () => {
      expect(run('planted-renamed-union.ts')).toEqual([
        expect.objectContaining({ rule: 'REL06_SECOND_UNION_IMPLEMENTATION', detail: 'walks events by eventId and keeps a set or map of what it has seen' }),
      ]);
    });
  });
});

/* ------------------------------------------------------------------ *
 * The server's classification is the engine's union, over generated logs
 * ------------------------------------------------------------------ */

const ATTEMPT = '00000000-0000-4000-8000-0000000000aa';
const SLOT = '00000000-0000-4000-8000-0000000000bb';
let ordinal = 0;
const event = (n: number, overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  eventId: `${(n + 0x1000).toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`,
  attemptId: ATTEMPT,
  slotId: SLOT,
  itemVersionId: '00000000-0000-4000-8000-0000000000cc',
  sequence: n,
  kind: n % 2 === 0 ? 'select' : 'visit',
  answer: n % 2 === 0 ? 'a' : null,
  clientMonotonicMs: n * 10,
  serverReceivedAt: '2026-10-21T08:30:00.000Z',
  deviceRef: 'd',
  afterSubmission: false,
  ...overrides,
});

/** Deterministic: a seed in, the same pair of logs out. Disjoint, overlapping and identical pairs all occur. */
function pairs(): [ServerEvent[], ServerEvent[]][] {
  const out: [ServerEvent[], ServerEvent[]][] = [];
  let state = 7;
  const next = (bound: number) => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) % bound;
  for (let round = 0; round < 60; round += 1) {
    const ids = Array.from({ length: 1 + next(12) }, (_, i) => i + 1 + ordinal);
    ordinal += 20;
    const a = ids.filter(() => next(3) !== 0).map((n) => event(n));
    const kind = round % 3;
    const b = kind === 0 ? ids.filter(() => next(3) !== 0).map((n) => event(n)) : kind === 1 ? [...a] : ids.map((n) => event(n + 1_000));
    out.push([a, b]);
  }
  return out;
}

describe('mergeIncoming is the engine\'s union, over generated disjoint, overlapping and identical pairs', () => {
  const canonical = (events: readonly ServerEvent[]) => {
    const log = logFromEvents(ATTEMPT, events.map(toEngineEvent));
    if (!log.ok) throw new Error('fixture conflicts');
    return log.log.events.map((e) => e.eventId);
  };

  it('has the same union as the engine\'s mergeLogs, in the same order', () => {
    for (const [a, b] of pairs()) {
      const merged = mergeIncoming(ATTEMPT, a, b);
      expect(merged.ok).toBe(true);
      if (!merged.ok) continue;
      const engine = mergeLogs(
        (logFromEvents(ATTEMPT, a.map(toEngineEvent)) as { ok: true; log: never }).log,
        (logFromEvents(ATTEMPT, b.map(toEngineEvent)) as { ok: true; log: never }).log,
      );
      expect(engine.ok).toBe(true);
      if (engine.ok) expect(merged.value.unionIds).toEqual(engine.log.events.map((e: ResponseEvent) => e.eventId));
    }
  });

  it('is commutative and idempotent in what it says is new: a log merged with itself adds nothing', () => {
    for (const [a, b] of pairs()) {
      const ab = mergeIncoming(ATTEMPT, a, b);
      const ba = mergeIncoming(ATTEMPT, b, a);
      expect(ab.ok && ba.ok).toBe(true);
      if (!ab.ok || !ba.ok) continue;
      expect(ab.value.unionIds).toEqual(ba.value.unionIds);
      expect(ab.value.unionIds).toEqual(canonical([...a, ...b]));
      const alone = mergeIncoming(ATTEMPT, a, a);
      expect(alone.ok && alone.value.fresh).toEqual([]);
      expect(alone.ok && alone.value.replayedIds.size).toBe(new Set(a.map((e) => e.eventId)).size);
    }
  });

  it('classifies every incoming id as new or already held, never both, and every new one once', () => {
    for (const [a, b] of pairs()) {
      const merged = mergeIncoming(ATTEMPT, a, [...b, ...b]);
      if (!merged.ok) throw new Error('fixture conflicts');
      const heldIds = new Set(a.map((e) => e.eventId));
      const freshIds = merged.value.fresh.map((e) => e.eventId);
      expect(new Set(freshIds).size).toBe(freshIds.length);
      expect(freshIds.every((id) => !heldIds.has(id))).toBe(true);
      expect([...merged.value.replayedIds].every((id) => heldIds.has(id))).toBe(true);
      expect(freshIds.length + merged.value.replayedIds.size).toBe(new Set(b.map((e) => e.eventId)).size);
    }
  });

  it('refuses an id reused with other content, naming it, whichever side holds the first copy', () => {
    const first = event(1);
    const other = event(1, { kind: 'select', answer: 'z', sequence: 1 });
    for (const [held, incoming] of [[[first], [other]], [[other], [first]], [[], [first, other]]] as const) {
      const merged = mergeIncoming(ATTEMPT, held, incoming);
      expect(merged.ok).toBe(false);
      if (!merged.ok) expect(merged.error).toMatchObject({ code: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT', eventId: first.eventId });
    }
  });
});

describe('the database\'s own identity check agrees with the engine\'s', () => {
  // The repository compares a stored event with an incoming one to tell a replay from a defect, in terms of the server's
  // fields. It is the backstop for a race the merge cannot see, and it must say what the engine says of the same pair.
  it('over generated same-id pairs: the same content is the same, any difference is a difference', async () => {
    const { PostgresResponseLog } = await import('../contexts/assessment/infrastructure/response-log.repository.js');
    const rows: ServerEvent[] = [];
    const base = event(5);
    const variants: ServerEvent[] = [
      base,
      { ...base, serverReceivedAt: '2027-01-01T00:00:00.000Z', afterSubmission: true },
      { ...base, sequence: 6 },
      { ...base, kind: 'select', answer: 'q' },
      { ...base, clientMonotonicMs: 1 },
      { ...base, slotId: '00000000-0000-4000-8000-0000000000dd' },
      { ...base, deviceRef: 'other' },
    ];
    rows.push(...variants);
    const stored: Record<string, ServerEvent> = {};
    const log = new PostgresResponseLog({
      query: async (sql: string, params: unknown[]) => {
        if (sql.startsWith('INSERT')) return { rows: [] };
        const row = stored['held']!;
        return {
          rows: [
            {
              event_id: row.eventId,
              attempt_id: row.attemptId,
              slot_id: row.slotId,
              item_version_id: row.itemVersionId,
              sequence: String(row.sequence),
              kind: row.kind,
              answer: row.answer,
              client_monotonic_ms: String(row.clientMonotonicMs),
              server_received_at: new Date(row.serverReceivedAt),
              device_ref: row.deviceRef,
              after_submission: row.afterSubmission,
            },
          ],
          params,
        };
      },
    } as never);
    for (const incoming of rows) {
      stored['held'] = base;
      const repo = await log.append(incoming);
      const engineSays = sameEvent(toEngineEvent(base), toEngineEvent(incoming));
      // the repository also compares the server-derived pin and device; here those only differ where the engine's view differs too,
      // except `deviceRef`, which the engine does not carry — a difference the database rightly refuses and the engine cannot see
      const deviceOnly = incoming.deviceRef !== base.deviceRef && engineSays;
      expect(repo.ok, JSON.stringify(incoming)).toBe(deviceOnly ? false : engineSays);
    }
  });
});
