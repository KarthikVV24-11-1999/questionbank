import type { SessionRecord } from './persistence.js';

/**
 * The offset between this device's clock and the server's, as the analytics events are stamped with it (§1 of the event taxonomy). It used to be read out of the response log's record
 * each time an event was made, which was a read of `localStorage` and is now a read of the disk; this keeps the latest in memory instead. It starts from what the last session left on
 * disk and is moved by the session as it takes a fresher one (`observe`). Nothing here is the learner's: a stale or missing offset makes an analytics timestamp wrong by that much and
 * touches no answer.
 */
export function createClockFacts(lastKnown: SessionRecord | null): { readonly offsetMs: () => number; readonly observe: (record: SessionRecord) => void } {
  let offset = lastKnown?.serverOffsetMs ?? 0;
  return {
    offsetMs: () => offset,
    observe: (record) => {
      if (record.serverOffsetMs !== null) offset = record.serverOffsetMs;
    },
  };
}
