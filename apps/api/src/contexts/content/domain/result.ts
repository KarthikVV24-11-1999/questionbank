/**
 * Domain operations report expected failures as values, never as thrown
 * exceptions (ENGINEERING-HANDBOOK §8).
 *
 * This duplicates curriculum's and scoring's `Result` rather than importing
 * either. `domain/` imports nothing (§9 rule 2), and that rule does not soften
 * for a type this small — a shared `Result` would be the first thread by which
 * the content domain reaches into another context's. All three are
 * structurally identical, so a value crossing a barrel needs no conversion.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
