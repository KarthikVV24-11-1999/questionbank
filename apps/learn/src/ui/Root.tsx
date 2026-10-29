import { useEffect, useState, type JSX } from 'react';
import type { BootResult } from '../bootstrap.js';
import type { PackageRefusal } from '../package/load.js';
import { LearnApp } from './LearnApp.js';

/**
 * The root: brings the sitting up and keeps it moving. It holds one thing of its own — how booting went — and none of it is the attempt.
 *
 * **The host supplies the clock's ticks** (`every`) and the network's coming back (`onOnline`): this component starts no timer and
 * listens to nothing of its own accord, so a test drives time by calling what it was given.
 */
export interface RootProps {
  readonly boot: () => Promise<BootResult>;
  /** Calls `fn` every `ms` until the returned function is called. */
  readonly every: (ms: number, fn: () => void) => () => void;
  /** Subscribes to the network coming back; returns the unsubscribe. */
  readonly onOnline: (fn: () => void) => () => void;
  /** Asked for when the build cannot open a paper: it looks for a newer shell. */
  readonly onUpdateWanted?: () => void;
}

const PUMP_EVERY_MS = 1_000;

const REFUSALS: Readonly<Record<PackageRefusal, string>> = {
  SIGNATURE_MISSING: 'This paper could not be checked, so it has not been opened.',
  KEY_MISSING: 'This paper could not be checked, so it has not been opened.',
  KEY_ID_DOES_NOT_MATCH: 'This paper could not be checked, so it has not been opened.',
  SIGNATURE_DOES_NOT_VERIFY: 'This paper did not pass its check and has not been opened. Try again in a moment.',
  NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS: 'This paper needs a newer version of this app. Reload the page to update.',
};

export function Root({ boot, every, onOnline, onUpdateWanted }: RootProps): JSX.Element {
  const [booted, setBooted] = useState<BootResult | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    boot().then(
      (result) => {
        if (cancelled) return;
        if (result.kind === 'package-refused' && result.refusal === 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS') onUpdateWanted?.();
        setBooted(result);
      },
      (error: unknown) => {
        if (!cancelled) setBootError(error instanceof Error ? error.message : 'The paper could not be loaded.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [boot, onUpdateWanted]);

  const session = booted?.kind === 'ready' ? booted.session : null;
  useEffect(() => {
    if (session === null) return undefined;
    const stopTicking = every(PUMP_EVERY_MS, () => void session.pump());
    const stopListening = onOnline(() => void session.syncNow());
    return () => {
      stopTicking();
      stopListening();
    };
  }, [session, every, onOnline]);

  if (bootError !== null) return <p role="alert">{bootError}</p>;
  if (booted === null) return <p role="status">Opening your paper…</p>;
  if (booted.kind === 'package-refused') return <p role="alert">{REFUSALS[booted.refusal]}</p>;
  if (booted.kind === 'cannot-start') return <p role="alert">The attempt could not be started: {booted.reason}.</p>;
  if (booted.discarded === undefined) return <LearnApp session={booted.session} form={booted.form} />;
  // Said once, above the paper (DEC-M7-34): the device held answers the server never had and could not be reconciled with it.
  return (
    <>
      <p role="note">Some of your earlier answers could not be found on the server, so this paper has started again from the beginning.</p>
      <LearnApp session={booted.session} form={booted.form} />
    </>
  );
}
