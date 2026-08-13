import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Debounced autosave, shared by every Studio editor (FRONTEND §7).
 *
 * **A keystroke landing while a save is in flight is not lost.** The edit marks
 * the draft dirty, and the save that is completing starts another with the
 * newer snapshot rather than the one it was carrying. That is the whole reason
 * this is a hook instead of a few lines per editor: it is the failure mode that
 * costs an author forty minutes, and it is the one nobody re-derives correctly
 * the second time.
 *
 * The attempt number is handed to `save` so the caller can mint the
 * idempotency key `UpdateItemDraft` wants (M3-25) — a retransmission of that
 * request carries the key it was minted with, so the server sees one write.
 */

export interface AutosaveOptions<T> {
  readonly delayMs: number;
  /** The snapshot to save if nothing is recorded before the first flush. */
  readonly initial: T;
  /** Returns false when the save did not land, which the editor must say out loud. */
  readonly save: (snapshot: T, attempt: number) => Promise<boolean>;
}

export interface Autosave<T> {
  readonly record: (snapshot: T) => void;
  readonly failed: boolean;
}

export function useAutosave<T>(options: AutosaveOptions<T>): Autosave<T> {
  const snapshotRef = useRef<T>(options.initial);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const saveRef = useRef(options.save);
  saveRef.current = options.save;

  const [failed, setFailed] = useState(false);

  const run: () => Promise<void> = useCallback(async () => {
    if (savingRef.current) {
      dirtyRef.current = true;
      return;
    }
    savingRef.current = true;
    dirtyRef.current = false;
    attemptRef.current += 1;

    const landed = await saveRef.current(snapshotRef.current, attemptRef.current);

    savingRef.current = false;
    setFailed(!landed);
    if (dirtyRef.current) {
      dirtyRef.current = false;
      await run();
    }
  }, []);

  const record = useCallback(
    (snapshot: T): void => {
      snapshotRef.current = snapshot;
      if (savingRef.current) dirtyRef.current = true;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void run();
      }, options.delayMs);
    },
    [options.delayMs, run],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  return { record, failed };
}
