import { RESPONSE_EVENT_KINDS, type ResponseEvent } from '../response-event.js';

/** Small seeded generator: the same seed gives the same sequence, so a failing property reproduces. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * A random event stream for one attempt: every kind, a few slots, rising
 * sequence and monotonic time, ids prefixed so two streams never collide
 * unless asked to.
 */
export function randomEvents(
  random: () => number,
  options: { readonly attemptId?: string; readonly count?: number; readonly idPrefix?: string; readonly firstSequence?: number } = {},
): ResponseEvent[] {
  const attemptId = options.attemptId ?? 'a1';
  const prefix = options.idPrefix ?? 'e';
  const count = options.count ?? 30;
  const events: ResponseEvent[] = [];
  let sequence = options.firstSequence ?? 1;
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    sequence += 1 + Math.floor(random() * 3);
    at += Math.floor(random() * 5000);
    const kind = RESPONSE_EVENT_KINDS[Math.floor(random() * RESPONSE_EVENT_KINDS.length)] as ResponseEvent['kind'];
    const base = { eventId: `${prefix}${i}`, attemptId, slot: `q${Math.floor(random() * 4)}`, sequence, monotonicMs: at };
    events.push(
      kind === 'select' || kind === 'change'
        ? { ...base, kind, answer: `opt${Math.floor(random() * 4)}` }
        : { ...base, kind },
    );
  }
  return events;
}
