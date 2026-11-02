/**
 * What the bound on hashing throws when it has no room (M8-08), recognised by what it says it is rather than by its class: identity may not import the platform file that defines
 * the class (ADR-0026), and an `instanceof` against a copy would never match.
 */
export interface Saturation {
  readonly saturated: true;
  readonly reason: 'queue_full' | 'wait_timeout';
}

export function isSaturation(error: unknown): error is Saturation {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { saturated?: unknown; reason?: unknown };
  return candidate.saturated === true && (candidate.reason === 'queue_full' || candidate.reason === 'wait_timeout');
}
