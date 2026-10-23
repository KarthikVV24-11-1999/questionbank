import { z } from 'zod';
import type { ResponseEvent } from '@questionbank/attempt-engine';
import type { KeyValueStore } from './ports.js';

/**
 * What survives a reload (M6-50): the engine's own values, written down and read back — the events its log holds, which of them the
 * server has acknowledged, and the facts the server fixed (the attempt, the deadline, the cap). It is not a second copy of the attempt:
 * on resume the engine is rebuilt from these through its own functions, so what runs afterwards is the engine's state and nothing the
 * record merely says.
 *
 * Read with a schema. A record that does not parse — a half-written one, one from a build that wrote another shape — is *absent*, never
 * partly trusted: the session then starts from the server, which is the authority on the attempt.
 */
const eventSchema = z
  .object({
    eventId: z.string(),
    attemptId: z.string(),
    slot: z.string(),
    sequence: z.number().int().min(0),
    monotonicMs: z.number().int().min(0),
    kind: z.enum(['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag']),
    answer: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
  })
  .strict();

const recordSchema = z
  .object({
    version: z.literal(1),
    attemptId: z.string(),
    deviceRef: z.string(),
    intervalCapMs: z.number().int().min(1),
    deadline: z.string(),
    submissionReason: z.enum(['manual', 'expiry', 'recovered']).nullable(),
    events: z.array(eventSchema),
    acknowledgedIds: z.array(z.string()),
    rejectedIds: z.array(z.string()),
  })
  .strict();

export type SessionRecord = Omit<z.infer<typeof recordSchema>, 'events'> & { readonly events: readonly ResponseEvent[] };

const ACTIVE_KEY = 'qb.attempt.active';
const keyOf = (attemptId: string): string => `qb.attempt.${attemptId}`;

export function saveRecord(storage: KeyValueStore, record: SessionRecord): void {
  storage.setItem(keyOf(record.attemptId), JSON.stringify(record));
  storage.setItem(ACTIVE_KEY, record.attemptId);
}

export function loadRecord(storage: KeyValueStore, attemptId: string): SessionRecord | null {
  const raw = storage.getItem(keyOf(attemptId));
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = recordSchema.safeParse(json);
  return parsed.success && parsed.data.attemptId === attemptId ? (parsed.data as SessionRecord) : null;
}

/** The attempt this device was last sitting, if it wrote one down. */
export function activeAttemptId(storage: KeyValueStore): string | null {
  return storage.getItem(ACTIVE_KEY);
}

export function clearRecord(storage: KeyValueStore, attemptId: string): void {
  storage.removeItem(keyOf(attemptId));
  if (storage.getItem(ACTIVE_KEY) === attemptId) storage.removeItem(ACTIVE_KEY);
}
