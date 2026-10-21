/**
 * The one definition of "is an identifier" in this context. Every id the
 * assessment context stores is a `uuid`, so a value that is not one is refused
 * where it is made and not where the database finally rejects it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** A lower-case SHA-256 digest in hex — the form a marking rule set's hash takes. */
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Milliseconds exactly, because that is what survives a round trip through
 * storage unchanged: a looser form would come back as a different string, and
 * this form also compares correctly as text.
 */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

/** `timestamp` plus `ms` milliseconds, in the same form. */
export function addMilliseconds(timestamp: string, ms: number): string {
  return new Date(Date.parse(timestamp) + ms).toISOString();
}
