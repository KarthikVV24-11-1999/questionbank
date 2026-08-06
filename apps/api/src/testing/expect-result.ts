import type { Result } from '../contexts/curriculum/domain/result.js';

/** Unwraps a successful Result in tests, failing loudly with the error otherwise. */
export function expectValue<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Unwraps a failed Result in tests, failing loudly if the operation succeeded. */
export function expectError<T, E>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error(`expected error result, got ok: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}
