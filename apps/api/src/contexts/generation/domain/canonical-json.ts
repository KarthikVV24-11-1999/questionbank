/**
 * A JSON value rendered with object keys in sorted order, so two values that
 * differ only in key order render identically.
 *
 * Used wherever equality must not depend on key order: `jsonb` does not
 * preserve it, so a stored proposal and the one being saved are compared this
 * way; a recorded request is looked up by it, so the same question asked with
 * its fields in another order still finds its recording.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
