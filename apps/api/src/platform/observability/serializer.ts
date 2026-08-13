/**
 * The allowlist serializer (Handbook §7, §9 rule 12). "Zero PII, enforced by
 * a serializer allowlist, never a redaction regex" — a denylist fails open
 * on the first field nobody thought to add to it; an allowlist fails closed
 * on the same field, which is the only one of the two failure directions
 * this repository will accept for anything that might carry PII.
 *
 * Shared by `logger.ts` and, from M0-04, `telemetry.ts` — one rule, one
 * implementation, so a log record and a span attribute are held to the same
 * standard rather than two similar-looking ones that can drift apart.
 */

export interface FilterResult {
  readonly filtered: Readonly<Record<string, unknown>>;
  /** Every dropped key's *name*, deduplicated — never its value. */
  readonly droppedKeys: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Keeps only allowlisted keys, at every depth. An allowlisted key whose
 * value is itself an object is walked by the same rule — an entity spread
 * under a permitted key is exactly the leak this exists to stop, and a
 * shallow filter would let it straight through.
 */
export function filterAllowlisted(
  record: Readonly<Record<string, unknown>>,
  allowlist: readonly string[],
): FilterResult {
  const dropped: string[] = [];

  function filterValue(value: unknown): unknown {
    if (isPlainObject(value)) return walk(value);
    if (Array.isArray(value)) return value.map(filterValue);
    return value;
  }

  function walk(obj: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!allowlist.includes(key)) {
        if (!dropped.includes(key)) dropped.push(key);
        continue;
      }
      out[key] = filterValue(value);
    }
    return out;
  }

  return { filtered: walk(record), droppedKeys: dropped };
}

/**
 * The closed set of attribute keys a log record or span may carry beyond its
 * fixed envelope (`timestamp`, `level`, `message`, `correlationId`,
 * `context`). Handbook §7: "what you log — identifiers, never item content."
 * Adding a key here is a reviewed diff.
 */
export const ALLOWED_ATTRIBUTE_KEYS = [
  'route',
  'method',
  'statusCode',
  'handlerName',
  'errorCode',
  'durationMs',
  'principalKind',
  'principalId',
  'itemVersionId',
  'itemId',
  'traceId',
  'spanId',
  'parentSpanId',
] as const;
