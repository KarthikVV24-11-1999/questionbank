/**
 * Where the two facts the mock completion rate is counted from are said (M8-54; D91 in docs/DEBT.md carries the rest of the thirty-one events): a port this context declares and the root fills with
 * the analytics emitter, because a context reaches `platform/` for the role vocabulary and nothing else. The event's id is derived from `factKey`, so a delivery that comes twice, or a start that is
 * answered twice, says it once. Saying an event never fails the work it describes.
 *
 *   - `mock.attempt_started`: said where the attempt is started, for an attempt on a form. The start is recorded when the server hears of it, so the learner was online: `is_offline` is false by
 *     construction, and an attempt begun on a device that had never reached the server cannot be said to have started until it has.
 *   - `mock.attempt_submitted`: said by the consumer of the outbox's `AttemptSubmitted`, so the event is made from a fact that was committed with the submission and is not lost to a crash after it.
 *     `sync_lag_ms` is **the time between the server last receiving a response event and the submission**, measured on the server's clock: the server holds no device wall times, so this is not
 *     the lag of the device's own queue, and is named after the field the taxonomy gave it.
 */
export interface MockEvents {
  emit(event: {
    readonly name: 'mock.attempt_started' | 'mock.attempt_submitted';
    readonly factKey: string;
    readonly occurredAt: string;
    readonly actor: string;
    readonly context: { readonly attempt_id: string };
    readonly payload: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void>;
}
