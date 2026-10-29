import { uuidV7, type ClientEnvelope, type EventName } from '@questionbank/contracts/analytics';
import type { KeyValueStore } from '../session/ports.js';

/**
 * The learner app's analytics emitter (M7-62, EVENT-TAXONOMY §1).
 *
 * **It can never cost the learner anything.** `emit` returns nothing, does no I/O the caller waits for, and cannot throw: an event is built, put in a buffer on the
 * device and sent in the background, and anything that goes wrong on the way is swallowed. It touches nothing the attempt engine keeps (the response log is the
 * engine's, under its own storage keys), so an analytics failure cannot lose a response.
 *
 * **Events survive the network the way responses do.** They are written to the device before they are sent and removed only when the edge has answered for them;
 * an answer of "sink unavailable" or a failed request keeps them for the next flush. The buffer is bounded, and when it is full the oldest go: an event is worth
 * less than the device's storage the learner's answers need. (The response log's own channel carries only the engine's closed vocabulary of response events, so
 * these ride the same offline-buffering pattern in a channel of their own: DEC-M7-37.)
 *
 * The clock is injected and `occurred_at` is the device's clock moved by the offset to the server's taken at the last contact, which is what "offset-corrected"
 * means here (§1); `received_at` is the edge's.
 */
export interface AnalyticsPorts {
  readonly storage: KeyValueStore;
  readonly nowMs: () => number;
  /** Milliseconds from this device's wall clock to the server's, as last taken; 0 where it was never taken. */
  readonly offsetMs: () => number;
  /** At least ten random bytes. */
  readonly random: () => Uint8Array;
  readonly send: (events: readonly ClientEnvelope[]) => Promise<ReadonlyArray<{ readonly index: number; readonly outcome: string }>>;
  readonly identity: {
    readonly pseudonymousId: string;
    readonly sessionId: string;
    readonly appVersion: string;
    readonly tenantId: string;
    readonly surface: ClientEnvelope['surface'];
    readonly deviceClass: () => ClientEnvelope['device_class'];
    readonly networkClass: () => ClientEnvelope['network_class'];
  };
}

/** What a screen is given to say that something happened. */
export interface ScreenAnalytics {
  emit(name: EventName, payload: ClientEnvelope['payload'], context?: ClientEnvelope['context']): void;
  /** The same clock the events are stamped with, for a payload that is a duration. */
  nowMs(): number;
  /** Sends what is buffered; called when the network is back. */
  flush(): void;
}

export const BUFFER_KEY = 'qb.analytics.buffer';
export const MAX_BUFFERED = 200;

export function createAnalytics(ports: AnalyticsPorts): ScreenAnalytics {
  let sending = false;

  const read = (): ClientEnvelope[] => {
    try {
      const parsed: unknown = JSON.parse(ports.storage.getItem(BUFFER_KEY) ?? '[]');
      return Array.isArray(parsed) ? (parsed as ClientEnvelope[]) : [];
    } catch {
      return [];
    }
  };
  const write = (events: readonly ClientEnvelope[]): void => {
    ports.storage.setItem(BUFFER_KEY, JSON.stringify(events.slice(-MAX_BUFFERED)));
  };

  const flush = (): void => {
    if (sending) return;
    const batch = read();
    if (batch.length === 0) return;
    sending = true;
    ports
      .send(batch)
      .then((results) => {
        const keep = new Set(results.filter((result) => result.outcome === 'sink-unavailable').map((result) => result.index));
        const sent = new Set(batch.filter((_, index) => !keep.has(index)).map((event) => event.event_id));
        write(read().filter((event) => !sent.has(event.event_id)));
      })
      .catch(() => undefined)
      .finally(() => {
        sending = false;
      });
  };

  return {
    nowMs: ports.nowMs,
    flush,
    emit(name, payload, context = {}) {
      try {
        const at = ports.nowMs();
        const { identity } = ports;
        const event: ClientEnvelope = {
          event_id: uuidV7(at, ports.random()),
          event_name: name,
          event_version: 1,
          occurred_at: new Date(at + ports.offsetMs()).toISOString(),
          actor: { kind: 'human', pseudonymous_id: identity.pseudonymousId },
          session_id: identity.sessionId,
          surface: identity.surface,
          app_version: identity.appVersion,
          device_class: identity.deviceClass(),
          network_class: identity.networkClass(),
          tenant_id: identity.tenantId,
          context,
          payload,
        };
        write([...read(), event]);
        flush();
      } catch {
        // never the learner's problem
      }
    },
  };
}

/** An emitter that records nothing, for a screen opened where nothing is listening. */
export const NO_ANALYTICS: ScreenAnalytics = { emit: () => undefined, nowMs: () => 0, flush: () => undefined };
