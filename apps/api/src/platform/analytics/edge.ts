import { clientEnvelopeSchema, EVENT_NAMES, findPii, type AnalyticsEnvelope } from '@questionbank/contracts/analytics';
import type { AnalyticsSink } from './sink.js';

/**
 * The ingestion edge (EVENT-TAXONOMY §1 rules 1 and 3): the one place an event is admitted or refused. An event is admitted only with a complete, valid envelope, a
 * name in the catalog and no personal data in any field; anything else is **quarantined, with the reason, and counted** — never dropped silently, and never kept
 * with the value that put it there (a PII finding stores the path and the kind of what was found, not the content).
 *
 * `received_at` is stamped here. An event already admitted (same `event_id`) is counted as a duplicate and not written again, so an emitter that retries, or a
 * relay that delivers twice, cannot count a fact twice.
 */
export type QuarantineReason = 'UNKNOWN_EVENT_NAME' | 'INVALID_ENVELOPE' | 'PII';

export interface Quarantined {
  readonly reason: QuarantineReason;
  /** Paths and kinds, never values. */
  readonly issues: readonly string[];
  /** The name, only when it is one the catalog has. */
  readonly eventName: string | null;
  readonly at: string;
}

export type Admission =
  | { readonly outcome: 'accepted'; readonly event: AnalyticsEnvelope }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'quarantined'; readonly reason: QuarantineReason }
  | { readonly outcome: 'sink-unavailable' };

export interface EdgeStats {
  readonly received: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly quarantined: Readonly<Record<QuarantineReason, number>>;
  readonly sinkFailures: number;
}

export const DEDUPE_WINDOW = 50_000;
const KNOWN = new Set<string>(EVENT_NAMES);

export class AnalyticsEdge {
  readonly #quarantine: Quarantined[] = [];
  readonly #seen = new Set<string>();
  #stats = { received: 0, accepted: 0, duplicates: 0, sinkFailures: 0, quarantined: { UNKNOWN_EVENT_NAME: 0, INVALID_ENVELOPE: 0, PII: 0 } as Record<QuarantineReason, number> };

  constructor(
    private readonly sink: AnalyticsSink,
    private readonly now: () => Date,
    /** Told of every quarantine as it happens: the alert of rule 3. */
    private readonly onQuarantine: (entry: Quarantined) => void = () => undefined,
    /** How many event ids it remembers; the oldest is forgotten first. */
    private readonly window: number = DEDUPE_WINDOW,
  ) {}

  async admit(raw: unknown): Promise<Admission> {
    this.#stats.received += 1;
    const pii = findPii(raw);
    if (pii.length > 0) return this.#refuse('PII', pii.map((finding) => `${finding.path}: ${finding.kind}`), raw);

    const name = typeof raw === 'object' && raw !== null ? (raw as { event_name?: unknown }).event_name : undefined;
    if (typeof name === 'string' && !KNOWN.has(name)) return this.#refuse('UNKNOWN_EVENT_NAME', ['event_name is not in the catalog'], raw);

    const parsed = clientEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return this.#refuse('INVALID_ENVELOPE', parsed.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.code}`), raw);

    if (this.#seen.has(parsed.data.event_id)) {
      this.#stats.duplicates += 1;
      return { outcome: 'duplicate' };
    }
    const event: AnalyticsEnvelope = { ...parsed.data, received_at: this.now().toISOString() };
    try {
      await this.sink.write(event);
    } catch {
      this.#stats.sinkFailures += 1;
      return { outcome: 'sink-unavailable' };
    }
    this.#seen.add(event.event_id);
    if (this.#seen.size > this.window) this.#seen.delete(this.#seen.values().next().value as string);
    this.#stats.accepted += 1;
    return { outcome: 'accepted', event };
  }

  #refuse(reason: QuarantineReason, issues: readonly string[], raw: unknown): Admission {
    const name = typeof raw === 'object' && raw !== null ? (raw as { event_name?: unknown }).event_name : undefined;
    const entry: Quarantined = { reason, issues, eventName: typeof name === 'string' && KNOWN.has(name) ? name : null, at: this.now().toISOString() };
    this.#quarantine.push(entry);
    this.#stats.quarantined[reason] += 1;
    this.onQuarantine(entry);
    return { outcome: 'quarantined', reason };
  }

  stats(): EdgeStats {
    return { ...this.#stats, quarantined: { ...this.#stats.quarantined } };
  }

  quarantined(): readonly Quarantined[] {
    return [...this.#quarantine];
  }
}
