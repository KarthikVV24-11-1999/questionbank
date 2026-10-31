import { createHash } from 'node:crypto';
import { uuidV7, type ClientEnvelope, type EventName, type ServerEnvelope } from '@questionbank/contracts/analytics';
import type { AnalyticsEdge } from './edge.js';

/**
 * Builds and submits the events the server itself is the surface for (EVENT-TAXONOMY §1 rule 5's server half). The envelope is the shared one; `surface` is `server`.
 *
 * **The event id is derived from the fact.** A relay delivers at least once and a recorder may be asked twice, so an id drawn at random would count one fact as
 * two. The caller names a `factKey` (the transition, say), the id's random bytes are a hash of it, and the edge's duplicate check does the rest.
 *
 * The server is the surface for the events it derives from what it did (DEC-M7-38). It has no device and no network, so its envelope carries no class of either. Emitting never throws: an event that cannot be sent is the edge's to count (`sinkFailures`, a quarantine), and the work that produced the fact has already happened.
 */
export const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

export interface ServerEmitterDeps {
  readonly edge: AnalyticsEdge;
  readonly appVersion: string;
  /** Sees every envelope built, before the edge decides on it: how a test run learns what was emitted (M7-63). Absent in production. */
  readonly observe?: (envelope: ClientEnvelope) => void;
}

export interface ServerEvent {
  readonly name: EventName;
  readonly factKey: string;
  readonly occurredAt: string;
  /** The learner's pseudonymous id: an opaque identifier, never a name (the mapping is Identity's, M8). */
  readonly actor: string;
  readonly context: ClientEnvelope['context'];
  readonly payload: ClientEnvelope['payload'];
}

export class ServerEmitter {
  constructor(private readonly deps: ServerEmitterDeps) {}

  async emit(event: ServerEvent): Promise<void> {
    try {
      const digest = createHash('sha256').update(`${event.name}:${event.factKey}`).digest();
      const envelope: ServerEnvelope = {
        event_id: uuidV7(Date.parse(event.occurredAt), digest),
        event_name: event.name,
        event_version: 1,
        occurred_at: event.occurredAt,
        actor: { kind: 'human', pseudonymous_id: event.actor },
        session_id: `server-${digest.subarray(0, 6).toString('hex')}`,
        surface: 'server',
        app_version: this.deps.appVersion,
        tenant_id: PLATFORM_TENANT,
        context: event.context,
        payload: event.payload,
      };
      this.deps.observe?.(envelope);
      await this.deps.edge.admit(envelope);
    } catch {
      // an event is never worth the work that produced it
    }
  }
}
