import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ALLOWED_ATTRIBUTE_KEYS, filterAllowlisted } from './serializer.js';

/**
 * ROADMAP M0's "OpenTelemetry wiring end to end", as far as an offline
 * `node_modules/.pnpm` store allows: no `@opentelemetry/*` package is
 * present and there is no network to fetch one, so this ships the **port and
 * the span tree**, not the vendor. `JsonTelemetry` below is not an OTLP
 * exporter and does not pretend to be one — writing an exporter against an
 * SDK this repository cannot compile against would produce a file that has
 * never been type-checked against the API it claims to implement, which is
 * worse than its absence. Recorded as debt **D31**, trigger: the OTel SDK
 * becoming installable (M0-WALKING-SKELETON.md, DEC-M0-10).
 *
 * The correlation id `http-runner.ts` already echoes on every response
 * (§8) *is* the trace id here — not a second identifier invented alongside
 * it. A span cannot be started without one.
 *
 * Span attributes pass through the same allowlist serializer a log record
 * does (`serializer.ts`) — one rule, one implementation, so a span cannot
 * carry something a log line would have refused.
 */

export type SpanStatus = 'ok' | 'error';

export interface SpanAttributes extends Record<string, unknown> {
  readonly correlationId: string;
}

export interface SpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly droppedAttributeKeys: readonly string[];
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly errorMessage?: string;
}

export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  end(status?: SpanStatus, errorMessage?: string): void;
}

export interface Telemetry {
  startSpan(name: string, attributes: SpanAttributes): SpanHandle;
  withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: SpanHandle) => Promise<T> | T): Promise<T>;
}

interface ActiveSpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

/**
 * Parent linkage is implicit, tracked through `AsyncLocalStorage` rather
 * than a `parent` parameter — `withSpan` calls nested inside another's `fn`
 * pick up the enclosing span automatically, including across an `await`,
 * which a plain module-level stack would not survive.
 */
const activeSpan = new AsyncLocalStorage<ActiveSpanContext>();

function filterSpanAttributes(
  attributes: SpanAttributes,
): { attributes: Record<string, unknown>; dropped: readonly string[] } {
  // correlationId is promoted to the envelope's traceId; it is never
  // duplicated into the filtered attribute bag.
  const { correlationId: _correlationId, ...rest } = attributes;
  const { filtered, droppedKeys } = filterAllowlisted(rest, ALLOWED_ATTRIBUTE_KEYS);
  return { attributes: filtered, dropped: droppedKeys };
}

/**
 * The shared span-tracking core. `emit` is the one difference between a
 * production sink and a test double — everything about span lifecycle,
 * parent linkage and attribute filtering lives here exactly once.
 */
export function createTelemetry(emit: (record: SpanRecord) => void): Telemetry {
  function startSpan(name: string, attributes: SpanAttributes): SpanHandle {
    if (typeof attributes.correlationId !== 'string' || attributes.correlationId.length === 0) {
      throw new Error('startSpan requires a non-empty correlationId attribute');
    }

    const parent = activeSpan.getStore();
    const traceId = parent?.traceId ?? attributes.correlationId;
    const spanId = randomUUID();
    const startedAt = new Date();
    const { attributes: filtered, dropped } = filterSpanAttributes(attributes);
    let ended = false;

    return {
      traceId,
      spanId,
      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
      end(status: SpanStatus = 'ok', errorMessage?: string): void {
        if (ended) return;
        ended = true;
        const endedAt = new Date();
        emit({
          name,
          traceId,
          spanId,
          ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
          attributes: filtered,
          droppedAttributeKeys: dropped,
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          status,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        });
      },
    };
  }

  async function withSpan<T>(name: string, attributes: SpanAttributes, fn: (span: SpanHandle) => Promise<T> | T): Promise<T> {
    const handle = startSpan(name, attributes);
    try {
      const result = await activeSpan.run({ traceId: handle.traceId, spanId: handle.spanId }, () => fn(handle));
      handle.end('ok');
      return result;
    } catch (error) {
      handle.end('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  return { startSpan, withSpan };
}

export interface JsonTelemetryDependencies {
  /** Defaults to one `process.stdout.write` per line. Overridable so tests never touch stdout. */
  readonly write?: (line: string) => void;
}

/** Writes each ended span as one JSON line — the span analogue of `logger.ts`'s log line. */
export function createJsonTelemetry(deps: JsonTelemetryDependencies = {}): Telemetry {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return createTelemetry((record) => {
    write(
      JSON.stringify({
        type: 'span',
        name: record.name,
        traceId: record.traceId,
        spanId: record.spanId,
        ...(record.parentSpanId === undefined ? {} : { parentSpanId: record.parentSpanId }),
        startedAt: record.startedAt.toISOString(),
        endedAt: record.endedAt.toISOString(),
        durationMs: record.durationMs,
        status: record.status,
        ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
        ...(record.droppedAttributeKeys.length > 0 ? { droppedKeys: record.droppedAttributeKeys } : {}),
        ...record.attributes,
      }),
    );
  });
}
