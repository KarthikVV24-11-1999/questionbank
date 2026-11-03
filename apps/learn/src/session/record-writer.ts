import { splitRecord, type EventRow, type EventState, type RecordMeta, type RecordStore, type SessionRecord } from './persistence.js';

/**
 * Gets the session's record onto the disk without making the learner wait for it (M8-15).
 *
 * **Why the screen does not wait.** A transaction that is on disk before it completes costs a disk sync, tens of milliseconds on a phone and more on a busy one, and a student
 * tapping through questions must not feel that per tap. So the session takes the answer into the engine's state and the screen shows it at once, and tells this writer the record
 * changed. The writer keeps **one commit in flight at a time**, and everything that changed while it was in flight goes in the next one (a group commit): ten taps while a commit is
 * out cost one more commit, not ten, and the cost per tap does not grow however slow the disk is.
 *
 * **Why the session does not send until it has.** An event is handed on to be sent only after the commit that holds it has resolved (`onDurable`). If it were sent first and
 * the browser were killed before the commit, the server would have an event the device had forgotten; the device would then number its next event after the last it remembered, and
 * two different events would carry one sequence number. Sending only what is on disk keeps "the server has it" a subset of "the device has it".
 *
 * **What it writes.** The difference between the record and the last one that is known to be on disk: the event rows that are new or whose state changed (acknowledged,
 * refused), and the facts if they changed. Nothing is written for a change that is already there.
 *
 * (DEC-M8-8 in docs/IMPLEMENTATION-DECISIONS.md.)
 *
 * **When a commit fails** (storage full, blocked, or not there) the writer says so (`onFailure`), keeps the record dirty, and tries again at the next write or `kick`. The session
 * decides what the learner is told and does; the writer does not hide it.
 */
export interface WriterHooks {
  /** Ids of events whose commit has resolved: they are on disk. */
  onDurable(eventIds: readonly string[]): void;
  onFailure(error: unknown): void;
  /** A commit resolved after one had failed. */
  onRecovered(): void;
}

export class RecordWriter {
  readonly #committedStates = new Map<string, EventState>();
  #committedMeta: string | null = null;
  #latest: SessionRecord | null = null;
  #written: SessionRecord | null = null;
  #flushing: Promise<void> = Promise.resolve();
  #active = false;
  #failed = false;

  constructor(
    private readonly store: RecordStore,
    private readonly hooks: WriterHooks,
  ) {}

  /** What is already on disk, from a read: the baseline the differences are taken against. */
  adopt(record: SessionRecord): void {
    const { meta, rows } = splitRecord(record);
    this.#committedMeta = JSON.stringify(meta);
    for (const row of rows) this.#committedStates.set(row.eventId, row.state);
  }

  /** The record changed. Starts a commit if none is in flight; otherwise the change goes in the next. */
  write(record: SessionRecord): void {
    this.#latest = record;
    this.kick();
  }

  /** Tries again if the last commit failed or a change is waiting; does nothing while one is in flight. */
  kick(): void {
    if (this.#active || this.#latest === this.#written) return;
    this.#active = true;
    this.#flushing = this.#flush();
  }

  /** Resolves when nothing is in flight. After a failure it resolves too, with the record still dirty. */
  async idle(): Promise<void> {
    await this.#flushing;
  }

  get dirty(): boolean {
    return this.#latest !== this.#written;
  }

  async #flush(): Promise<void> {
    try {
      while (this.#latest !== null && this.#latest !== this.#written) {
        const target = this.#latest;
        const { meta, rows } = splitRecord(target);
        const metaJson = JSON.stringify(meta);
        const changed = rows.filter((row) => this.#committedStates.get(row.eventId) !== row.state);
        if (changed.length > 0 || metaJson !== this.#committedMeta) {
          try {
            await this.store.commit({ meta: meta as RecordMeta, rows: changed as EventRow[], active: true });
          } catch (error) {
            this.#failed = true;
            this.hooks.onFailure(error);
            return;
          }
        }
        this.#committedMeta = metaJson;
        for (const row of changed) this.#committedStates.set(row.eventId, row.state);
        this.#written = target;
        if (this.#failed) {
          this.#failed = false;
          this.hooks.onRecovered();
        }
        if (changed.length > 0) this.hooks.onDurable(changed.map((row) => row.eventId));
      }
    } finally {
      this.#active = false;
    }
  }
}
