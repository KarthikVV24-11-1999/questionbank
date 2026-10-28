import { useEffect, useRef, useState } from 'react';

/**
 * How a request is going (M7-57): loading, loaded or failed. This is the one place the learner screens hold state, and the state is the request's,
 * never the learner's — the allowlist in `learn-rules.ts` names this file for that and nothing else.
 */
export type Remote<T> = { readonly status: 'loading' } | { readonly status: 'failed'; readonly message: string } | { readonly status: 'loaded'; readonly value: T };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'Something went wrong.');

/** Runs `load` once, when the screen opens. A different screen is a different mount, and asks again. */
export function useRemote<T>(load: () => Promise<T>): Remote<T> {
  const [remote, setRemote] = useState<Remote<T>>({ status: 'loading' });
  useEffect(() => {
    load().then(
      (value) => setRemote({ status: 'loaded', value }),
      (error: unknown) => setRemote({ status: 'failed', message: messageOf(error) }),
    );
  }, []);
  return remote;
}

/** One action a person takes, run once at a time and not again once it has succeeded, with what went wrong if it did not. */
export function useAction<T>(run: () => Promise<T>, done: (value: T) => void): { readonly busy: boolean; readonly failure: string | null; readonly go: () => void } {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Read at the moment of a tap, not as of the last render: two taps in one tick both see the render's `busy` as false.
  const going = useRef(false);
  const go = (): void => {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    setFailure(null);
    run().then(
      // Done: the screen is about to be left, so the action stays taken — a second tap before it is gone would only ask again.
      done,
      (error: unknown) => {
        going.current = false;
        setBusy(false);
        setFailure(messageOf(error));
      },
    );
  };
  return { busy, failure, go };
}
