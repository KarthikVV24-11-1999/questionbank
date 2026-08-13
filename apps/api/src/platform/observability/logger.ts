import type { LogLevel, NodeEnv } from '../config/config.js';
import { ALLOWED_ATTRIBUTE_KEYS, filterAllowlisted } from './serializer.js';

/**
 * Structured JSON logging, one event per line (Handbook §7). This is the
 * only place a `LogEntry`'s free-form `attributes` bag is turned into text —
 * every field in it passes through the allowlist serializer first, so a
 * caller cannot accidentally ship a value the allowlist would have dropped.
 */

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly correlationId: string;
  /** The owning module or bounded context — a plain label, never carries PII by construction. */
  readonly context: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** §7: message and code are always logged; the stack is dropped in production. */
  readonly error?: Error & { readonly code?: string };
}

export interface LoggerDependencies {
  readonly logLevel: LogLevel;
  readonly nodeEnv: NodeEnv;
  readonly clock?: () => Date;
  /** Defaults to one `process.stdout.write` per line. Overridable so tests never touch stdout. */
  readonly write?: (line: string) => void;
}

export interface Logger {
  log(entry: LogEntry): void;
}

/** `debug` is off in production regardless of the configured level (§7). */
function shouldEmit(level: LogLevel, configuredLevel: LogLevel, nodeEnv: NodeEnv): boolean {
  if (level === 'debug' && nodeEnv === 'production') return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel];
}

function serialize(entry: LogEntry, nodeEnv: NodeEnv, now: Date): Record<string, unknown> {
  const { filtered, droppedKeys } = filterAllowlisted(entry.attributes ?? {}, ALLOWED_ATTRIBUTE_KEYS);

  const record: Record<string, unknown> = {
    timestamp: now.toISOString(),
    level: entry.level,
    message: entry.message,
    correlationId: entry.correlationId,
    context: entry.context,
    ...filtered,
  };

  if (droppedKeys.length > 0) {
    record['droppedKeys'] = droppedKeys;
  }

  if (entry.error !== undefined) {
    record['errorMessage'] = entry.error.message;
    if (typeof entry.error.code === 'string') {
      record['errorCode'] = entry.error.code;
    }
    if (nodeEnv !== 'production' && entry.error.stack !== undefined) {
      record['errorStack'] = entry.error.stack;
    }
  }

  return record;
}

export function createLogger(deps: LoggerDependencies): Logger {
  const clock = deps.clock ?? (() => new Date());
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  return {
    log(entry: LogEntry): void {
      if (!shouldEmit(entry.level, deps.logLevel, deps.nodeEnv)) return;
      write(JSON.stringify(serialize(entry, deps.nodeEnv, clock())));
    },
  };
}
