import { createTelemetry, type SpanRecord, type Telemetry } from './telemetry.js';

/**
 * The in-memory double for `Telemetry` (ports over adapters). Its real owner
 * is `createJsonTelemetry` in `telemetry.ts` — the production sink this
 * stands in for — and it exists so a test can assert the shape of a span
 * tree (M0-14's walking skeleton, M0-13's health checks) without parsing
 * JSON lines off a captured stdout.
 */
export interface RecordingTelemetry extends Telemetry {
  readonly spans: readonly SpanRecord[];
  reset(): void;
}

export function createRecordingTelemetry(): RecordingTelemetry {
  const spans: SpanRecord[] = [];
  const base = createTelemetry((record) => {
    spans.push(record);
  });

  return {
    ...base,
    spans,
    reset(): void {
      spans.length = 0;
    },
  };
}
