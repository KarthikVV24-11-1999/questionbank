/** A JSON object: what a JSONB column holds in this context. Arrays, scalars and null are not. */
export function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Freezes a JSON document all the way down, so a value read from the domain cannot be edited in place. */
export function freezeJson<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) freezeJson(inner);
    Object.freeze(value);
  }
  return value;
}
