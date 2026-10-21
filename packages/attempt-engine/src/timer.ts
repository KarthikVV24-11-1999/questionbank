/**
 * Remaining time, computed from monotonic readings handed in by the caller
 * (ASSESSMENT-ENGINE §5). The wall clock is user-settable, so nothing in this
 * module could be allowed to read it — and nothing does: every function
 * takes the reading as a parameter and returns a value. Expiry is therefore
 * a question asked ("is it expired at this reading?"), never an event the
 * engine schedules; whoever owns the real clock decides when to ask.
 *
 * The deadline itself is server-anchored and signed at start. Verifying the
 * signature is the caller's job; what the engine needs from it is how long
 * the attempt was allowed, which is the difference between two readings of
 * the *server's* clock and so is untouched by the device's.
 */
export interface AttemptTimer {
  /** How long the attempt was allowed in total, from the server's deadline. */
  readonly allowedMs: number;
  /** Time observed to have passed, in readings of the monotonic clock. */
  readonly consumedMs: number;
  /** The last monotonic reading seen; time since it has not yet been counted. */
  readonly lastReadingMs: number;
}

/** Allowed duration from the signed deadline and the server time it was issued at. */
export function allowedFromDeadline(deadline: { readonly issuedAtMs: number; readonly deadlineMs: number }): number {
  return Math.max(0, deadline.deadlineMs - deadline.issuedAtMs);
}

export function startTimer(allowedMs: number, readingMs: number): AttemptTimer {
  return { allowedMs, consumedMs: 0, lastReadingMs: readingMs };
}

/** Time elapsed since the last reading; a reading that went backwards counts nothing. */
function sinceLast(timer: AttemptTimer, readingMs: number): number {
  return Math.max(0, readingMs - timer.lastReadingMs);
}

/**
 * Folds the time up to `readingMs` into the timer. A monotonic clock never
 * runs backwards within one process, so a reading below the last means the
 * process restarted and the origin moved: nothing is counted for the gap and
 * the new reading becomes the baseline. The gap is not lost track of — the
 * server re-validates at submission and the stricter of the two governs.
 */
export function advance(timer: AttemptTimer, readingMs: number): AttemptTimer {
  return {
    allowedMs: timer.allowedMs,
    consumedMs: timer.consumedMs + sinceLast(timer, readingMs),
    lastReadingMs: readingMs,
  };
}

/**
 * Re-baselines after the app was suspended or restarted, counting nothing for
 * the time it was not running. Time the learner genuinely lost is then
 * recovered from the server's view, not guessed here.
 */
export function resume(timer: AttemptTimer, readingMs: number): AttemptTimer {
  return { ...timer, lastReadingMs: readingMs };
}

export function remainingMs(timer: AttemptTimer, readingMs: number): number {
  return Math.max(0, timer.allowedMs - timer.consumedMs - sinceLast(timer, readingMs));
}

export function isExpired(timer: AttemptTimer, readingMs: number): boolean {
  return remainingMs(timer, readingMs) === 0;
}

/**
 * The stricter of the client's and the server's view governs: offline expiry
 * must not become a loophole, and a client that thinks it has more time than
 * the server does is wrong.
 */
export function governingRemainingMs(clientRemainingMs: number, serverRemainingMs: number): number {
  return Math.min(clientRemainingMs, serverRemainingMs);
}
