import { useSyncExternalStore } from 'react';
import type { AttemptSession, SessionSnapshot } from '../session/attempt-session.js';

/**
 * Reads the session as an external store. This hook is the only way a component learns anything about the attempt, and what it returns is a
 * snapshot derived from the engine's values — a component that wanted to remember an answer itself would have nowhere to take it from and
 * nothing to compare it with. A rule (`learn-rules.ts`) fails the build on a component that tries.
 */
export function useSession(session: AttemptSession): SessionSnapshot {
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getSnapshot(),
  );
}
