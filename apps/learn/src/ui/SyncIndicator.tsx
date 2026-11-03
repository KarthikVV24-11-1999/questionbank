import type { JSX } from 'react';
import type { SyncStatus } from '@questionbank/attempt-engine';
import { TOKENS } from '../tokens.js';

/**
 * Says whether what the learner has done is saved (§7: calm, not an alarm).
 *
 * **The engine's own `syncStatus` is the only input** — there is no second notion of connectivity here: no `navigator.onLine`, no
 * ping, no flag of its own. "Am I synced" has one source, and when the engine says it is backing off the screen says the answers are
 * kept and will be sent, in the same quiet type as everything else.
 *
 * Two facts the engine does not have, because they are about this device's disk and not about the server (M8-15): answers given and shown but not yet on the disk are still
 * "saving", whatever the engine says; and when the device cannot keep the log at all, the learner is told that, plainly and without alarm, and told what to do, because then the
 * page is holding the only copy that has not been sent.
 */
const WORDS: Readonly<Record<SyncStatus, string>> = {
  idle: 'All answers saved',
  pending: 'Saving your answers…',
  backing_off: 'Your answers are kept on this device and will be sent when the connection is back',
  suspended: 'Your answers are kept on this device. Sending is paused.',
};

/** Said when the device is failing to keep the answers (the disk is full, or the browser will not give a store). */
export const NOT_KEPT = 'This device could not keep your answers. Keep this page open until they are sent.';

export function SyncIndicator({ status, pending, unsaved = 0, storageError = null, onRetry }: { readonly status: SyncStatus; readonly pending: number; readonly unsaved?: number; readonly storageError?: string | null; readonly onRetry: () => void }): JSX.Element {
  return (
    <div role="status" aria-live="polite" style={{ color: TOKENS.textMuted, padding: TOKENS.spaceSmall }}>
      <span>{storageError !== null ? NOT_KEPT : unsaved > 0 && status === 'idle' ? WORDS.pending : WORDS[status]}</span>
      {pending > 0 ? <span> ({pending} waiting)</span> : null}
      {status === 'suspended' || status === 'backing_off' ? (
        <button type="button" onClick={onRetry} style={{ marginLeft: TOKENS.spaceSmall }}>
          Try now
        </button>
      ) : null}
    </div>
  );
}
