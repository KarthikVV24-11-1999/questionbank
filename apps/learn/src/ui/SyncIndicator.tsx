import type { JSX } from 'react';
import type { SyncStatus } from '@questionbank/attempt-engine';
import { TOKENS } from '../tokens.js';

/**
 * Says whether what the learner has done is saved (§7: calm, not an alarm).
 *
 * **The engine's own `syncStatus` is the only input** — there is no second notion of connectivity here: no `navigator.onLine`, no
 * ping, no flag of its own. "Am I synced" has one source, and when the engine says it is backing off the screen says the answers are
 * kept and will be sent, in the same quiet type as everything else.
 */
const WORDS: Readonly<Record<SyncStatus, string>> = {
  idle: 'All answers saved',
  pending: 'Saving your answers…',
  backing_off: 'Your answers are kept on this device and will be sent when the connection is back',
  suspended: 'Your answers are kept on this device. Sending is paused.',
};

export function SyncIndicator({ status, pending, onRetry }: { readonly status: SyncStatus; readonly pending: number; readonly onRetry: () => void }): JSX.Element {
  return (
    <div role="status" aria-live="polite" style={{ color: TOKENS.textMuted, padding: TOKENS.spaceSmall }}>
      <span>{WORDS[status]}</span>
      {pending > 0 ? <span> ({pending} waiting)</span> : null}
      {status === 'suspended' || status === 'backing_off' ? (
        <button type="button" onClick={onRetry} style={{ marginLeft: TOKENS.spaceSmall }}>
          Try now
        </button>
      ) : null}
    </div>
  );
}
