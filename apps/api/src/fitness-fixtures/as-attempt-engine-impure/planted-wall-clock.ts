// Planted violation for frontend-rules.spec.ts (F26): the attempt engine
// reading the wall clock, which is user-settable. Time must arrive as a parameter.
export function remainingMs(deadlineMs: number): number {
  return deadlineMs - Date.now();
}
