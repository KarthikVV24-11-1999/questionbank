/// <reference lib="dom" />
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The undo window (M4-39, DEC-M4-10) — a client-side commit delay, not a
 * compensating record. `content.review_decision` is append-only with no
 * mutator and M3's transition table has no reverse edge from `approved`
 * back to `in_review`, so there is nothing to retract once a decision
 * reaches the server. `hold` therefore never sends anything itself —
 * `commit` fires exactly once, from the timer, only if `undo` was never
 * called first.
 *
 * **The cost is stated, not hidden.** A reviewer who closes the tab inside
 * the window loses that decision; the item stays claimed until its lease
 * expires and returns to the pool. That is recoverable by re-deciding, so
 * this hook clears its own timer on unmount rather than trying to flush a
 * decision the reviewer is no longer present to confirm.
 */

export interface UndoBuffer<T> {
  /** The decision counting down, or `null` between decisions. */
  readonly pending: T | null;
  /** Milliseconds left before `commit` fires — the countdown a reviewer sees. */
  readonly remainingMs: number;
  /** Starts the window for `value`. A second call before the first elapses replaces it — never two pending decisions at once. */
  hold(value: T): void;
  /** Cancels the pending commit. `commit` never runs for this value. */
  undo(): void;
}

export function useUndoBuffer<T>(commit: (value: T) => void, windowMs: number): UndoBuffer<T> {
  const [pending, setPending] = useState<T | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const clearTimers = useCallback(() => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    if (intervalRef.current !== null) clearInterval(intervalRef.current);
    timeoutRef.current = null;
    intervalRef.current = null;
  }, []);

  const hold = useCallback(
    (value: T): void => {
      clearTimers();
      setPending(value);
      setRemainingMs(windowMs);

      const startedAt = Date.now();
      intervalRef.current = setInterval(() => {
        setRemainingMs(Math.max(0, windowMs - (Date.now() - startedAt)));
      }, 100);
      timeoutRef.current = setTimeout(() => {
        clearTimers();
        setPending(null);
        commitRef.current(value);
      }, windowMs);
    },
    [clearTimers, windowMs],
  );

  const undo = useCallback((): void => {
    clearTimers();
    setPending(null);
  }, [clearTimers]);

  // Never fires a decision nobody is present to confirm — see the header.
  useEffect(() => clearTimers, [clearTimers]);

  return { pending, remainingMs, hold, undo };
}
