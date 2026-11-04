import { z } from 'zod';
import type { ResponseEvent } from '@questionbank/attempt-engine';
import type { KeyValueStore } from './ports.js';

/**
 * What survives a reload and a kill (M6-50, M8-15): the engine's own values, written down and read back — the events its log holds, which of them the server has acknowledged,
 * and the facts the server fixed (the attempt, the deadline, the cap). It is not a second copy of the attempt: on resume the engine is rebuilt from these through its own
 * functions, so what runs afterwards is the engine's state and nothing the record merely says.
 *
 * **Where it lives.** In IndexedDB, in three object stores written in one transaction: the facts of the attempt, one row per event (with whether the server has it), and which
 * attempt is the one this device is sitting. A transaction there completes once its data is on disk, which is what `localStorage` never promised: Chrome committed it some seconds
 * after the write and, after the first few commits, about once a minute, so a browser killed outright could lose a minute of answers (debt D66 in docs/DEBT.md, now closed).
 * `RecordStore` is the shape; `idb-record-store.ts` is IndexedDB behind it. A row per event, and not one record rewritten each time, is so that the cost of a write does not grow
 * with the length of the attempt.
 *
 * Read with a schema. A record that does not parse — a half-written one, one from a build that wrote another shape — is *absent*, never partly trusted: the session then starts
 * from the server, which is the authority on the attempt.
 */
const eventSchema = z
  .object({
    eventId: z.string(),
    attemptId: z.string(),
    slot: z.string(),
    sequence: z.number().int().min(0),
    monotonicMs: z.number().int().min(0),
    kind: z.enum(['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag', 'skip']),
    answer: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
  })
  .strict();

const recordSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string(),
    deviceRef: z.string(),
    intervalCapMs: z.number().int().min(1),
    /** Null for an untimed attempt, which a practice run is: it has no deadline to anchor and none is invented. */
    deadline: z.string().nullable(),
    /** The form the attempt is of, so a reopened app can tell, with no server to ask, whether this record is for the paper in front of it. Absent from a record written before it was kept. */
    formId: z.string().nullable().default(null),
    /** Milliseconds from this device's wall clock to the server's, taken at the last contact (D67). Absent from a record written before it was kept. */
    serverOffsetMs: z.number().nullable().default(null),
    submissionReason: z.enum(['manual', 'expiry', 'recovered']).nullable(),
    events: z.array(eventSchema),
    acknowledgedIds: z.array(z.string()),
    rejectedIds: z.array(z.string()),
  })
  .strict();

export type SessionRecord = Omit<z.infer<typeof recordSchema>, 'events'> & { readonly events: readonly ResponseEvent[] };

/** What a record says about one event, besides the event: whether the server has it, refused it, or has not been told. */
export type EventState = 'open' | 'acknowledged' | 'rejected';

/** The record without its events: the facts of the attempt. */
export type RecordMeta = Omit<SessionRecord, 'events' | 'acknowledgedIds' | 'rejectedIds'>;

export interface EventRow {
  readonly attemptId: string;
  readonly eventId: string;
  /** For reading them back in order without parsing each; the event carries it too. */
  readonly sequence: number;
  readonly state: EventState;
  readonly event: ResponseEvent;
}

/** Everything one transaction writes: the facts, the event rows that are new or changed, and that this attempt is the one being sat. */
export interface RecordChange {
  readonly meta: RecordMeta;
  readonly rows: readonly EventRow[];
  /** Whether this attempt becomes the one the device is sitting. A session's writes say so; a migration of old records does not. */
  readonly active: boolean;
}

/** What a read gives back before it is trusted: the stored facts and rows, as they were found. */
export interface StoredAttempt {
  readonly meta: unknown;
  readonly rows: readonly unknown[];
}

/**
 * The device's disk, as the session sees it. **`commit` resolves only once the change is on disk**, all of it or none of it; that is the whole of the contract, and it is what the
 * rest of this module is built to wait for. Reading is not a promise of anything but what was committed.
 */
export interface RecordStore {
  commit(change: RecordChange): Promise<void>;
  read(attemptId: string): Promise<StoredAttempt | null>;
  /** The attempt this device was last sitting, if it committed one. */
  active(): Promise<string | null>;
}

const rowSchema = z.object({ attemptId: z.string(), eventId: z.string(), sequence: z.number().int(), state: z.enum(['open', 'acknowledged', 'rejected']), event: eventSchema }).strict();

export const stateOf = (record: Pick<SessionRecord, 'acknowledgedIds' | 'rejectedIds'>): ((eventId: string) => EventState) => {
  const acknowledged = new Set(record.acknowledgedIds);
  const rejected = new Set(record.rejectedIds);
  return (eventId) => (rejected.has(eventId) ? 'rejected' : acknowledged.has(eventId) ? 'acknowledged' : 'open');
};

export function splitRecord(record: SessionRecord): { meta: RecordMeta; rows: EventRow[] } {
  const { events, acknowledgedIds, rejectedIds, ...meta } = record;
  const state = stateOf({ acknowledgedIds, rejectedIds });
  return { meta, rows: events.map((event) => ({ attemptId: record.attemptId, eventId: event.eventId, sequence: event.sequence, state: state(event.eventId), event })) };
}

/** Puts a stored attempt back together and reads it with the schema: `null` for anything that does not parse, or is of another attempt. */
export function assembleRecord(attemptId: string, stored: StoredAttempt | null): SessionRecord | null {
  if (stored === null) return null;
  const rows = z.array(rowSchema).safeParse(stored.rows);
  if (!rows.success || rows.data.some((row) => row.attemptId !== attemptId)) return null;
  const ordered = [...rows.data].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1));
  const parsed = recordSchema.safeParse({
    ...(typeof stored.meta === 'object' && stored.meta !== null ? stored.meta : {}),
    events: ordered.map((row) => row.event),
    acknowledgedIds: ordered.filter((row) => row.state === 'acknowledged').map((row) => row.eventId),
    rejectedIds: ordered.filter((row) => row.state === 'rejected').map((row) => row.eventId),
  });
  return parsed.success && parsed.data.attemptId === attemptId ? (parsed.data as SessionRecord) : null;
}

export async function loadRecord(store: RecordStore, attemptId: string): Promise<SessionRecord | null> {
  return assembleRecord(attemptId, await store.read(attemptId));
}

/** Writes a whole record in one transaction. The session writes only what changed (`record-writer.ts`); this is for the one who has a whole record and wants it kept (a migration, a test). */
export async function saveRecord(store: RecordStore, record: SessionRecord, active = true): Promise<void> {
  await store.commit({ ...splitRecord(record), active });
}

/* ------------------------------------------------------------------------------------------------ what an earlier build left behind */

const ACTIVE_KEY = 'qb.attempt.active';
const LEGACY_PREFIX = 'qb.attempt.';

/** `localStorage`, as the earlier build used it for this record, with the one thing that build never needed: a list of what it holds. */
export interface LegacyStorage extends KeyValueStore {
  keys(): readonly string[];
}

function readLegacy(storage: KeyValueStore, key: string): SessionRecord | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = recordSchema.safeParse(json);
  return parsed.success && key === `${LEGACY_PREFIX}${parsed.data.attemptId}` ? (parsed.data as SessionRecord) : null;
}

/**
 * Two records of one attempt, as one: the events of both (by event id, in the order of their sequence), what the server has or refused according to either, and the facts of whichever
 * holds more. A record is on disk twice only when a build that wrote `localStorage` and this one were both running (an old tab left open across an update), or a crash came between
 * the copy and the removal of the old; either way, losing an event is the one thing a merge must not do.
 */
export function mergeRecords(first: SessionRecord, second: SessionRecord): SessionRecord {
  const byId = new Map<string, ResponseEvent>();
  for (const event of [...first.events, ...second.events]) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  const events = [...byId.values()].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1));
  const richer = second.events.length > first.events.length ? second : first;
  return {
    ...richer,
    formId: richer.formId ?? first.formId ?? second.formId,
    serverOffsetMs: richer.serverOffsetMs ?? first.serverOffsetMs ?? second.serverOffsetMs,
    submissionReason: first.submissionReason ?? second.submissionReason,
    events,
    acknowledgedIds: [...new Set([...first.acknowledgedIds, ...second.acknowledgedIds])],
    rejectedIds: [...new Set([...first.rejectedIds, ...second.rejectedIds])],
  };
}

/**
 * Brings what an earlier build kept in `localStorage` into the device's own store (M8-15), once, before anything reads. A learner who is partway through an attempt when the new build
 * loads has their answers there and nowhere else; this is the step that must not lose them.
 *
 * **Copy, commit, then remove.** Each record is written to the store, and only when that commit has resolved (so it is on disk) is the old key removed. Dying anywhere in between leaves
 * the record in both places, and the next run merges them and removes the old one: it is never in neither. A record that does not parse is left where it is, untouched: it is not ours to
 * delete, and it is not trusted. The attempt that was active stays the active one unless the store already names another.
 *
 * Returns how many attempts it moved, for the caller that wants to say so.
 */
export async function migrateLegacy(legacy: LegacyStorage, store: RecordStore): Promise<number> {
  const wasActive = legacy.getItem(ACTIVE_KEY);
  let moved = 0;
  for (const key of legacy.keys()) {
    if (!key.startsWith(LEGACY_PREFIX) || key === ACTIVE_KEY) continue;
    const old = readLegacy(legacy, key);
    if (old === null) continue;
    const held = await loadRecord(store, old.attemptId);
    await saveRecord(store, held === null ? old : mergeRecords(held, old), false);
    legacy.removeItem(key);
    moved += 1;
  }
  if (wasActive !== null) {
    // the attempt that was being sat stays the one, unless the store already names another
    if ((await store.active()) === null) {
      const record = await loadRecord(store, wasActive);
      if (record !== null) await saveRecord(store, record, true);
    }
    if ((await store.active()) !== null) legacy.removeItem(ACTIVE_KEY);
  }
  return moved;
}
