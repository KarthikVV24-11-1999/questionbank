/**
 * Not production code. Proves the "zero throw, zero clock read under
 * `domain/review/`" checks in `content-rules.spec.ts` fail when they should,
 * the same way `as-content-domain/planted-violations.ts` does for the rest
 * of content's domain layer.
 */
export function refuse(): never {
  throw new Error('a review domain module that throws instead of returning a Result');
}

export function decidedAt(): string {
  return new Date().toISOString();
}
