/**
 * Domain operations report expected failures as values, never as thrown exceptions (ENGINEERING-HANDBOOK §8).
 *
 * Duplicated rather than imported, as every context does: `domain/` imports nothing (§9 rule 2), and a shared `Result` would
 * be the first thread by which this domain reaches into another context's. The shapes are structurally identical.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
