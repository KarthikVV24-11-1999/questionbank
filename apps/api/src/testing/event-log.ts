import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientEnvelope } from '@questionbank/contracts/analytics';

/**
 * When the file `qb-event-log.path` exists in the temp directory, it names a log, and every event a test run emits is appended to it (one line of JSON), so that the
 * conformance measurement (M7-63) has a denominator that came from a run: what was emitted, replayed afterwards through the real edge. `pnpm run event-conformance`
 * makes the marker and removes it. Without it, nothing is written. (A marker file and not an environment variable: the configuration rule allows three readers of the
 * environment, and a test helper is not a fourth.)
 */
export const EVENT_LOG_MARKER = join(tmpdir(), 'qb-event-log.path');

export function eventLogPath(): string | null {
  return existsSync(EVENT_LOG_MARKER) ? readFileSync(EVENT_LOG_MARKER, 'utf8').trim() : null;
}

export function logEmission(envelope: ClientEnvelope): void {
  const path = eventLogPath();
  if (path !== null) appendFileSync(path, `${JSON.stringify({ source: 'api', event: envelope })}\n`);
}
