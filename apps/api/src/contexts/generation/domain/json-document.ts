/**
 * The two operations every JSON-shaped value in this domain needs: recognise a
 * plain object, and take a deep frozen copy of one.
 *
 * `domain/` imports nothing, so these live here rather than in a shared
 * package. Held in one module so the proposal, the run's request and anything
 * after them are frozen the same way.
 */

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deep, frozen copy — the caller keeps no handle through which the value can change afterwards. */
export function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (isJsonObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, freezeJson(inner)])));
  }
  return value;
}
