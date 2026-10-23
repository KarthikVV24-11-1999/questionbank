import {
  acknowledge,
  advance,
  captureResponse,
  createAttempt,
  createSyncQueue,
  enqueue,
  nextBatch,
  projectAttempt,
  recordFailure,
  remainingMs,
  resumeSync,
  startAttempt,
  startTimer,
  submitAttempt,
  syncStatus,
  type Attempt,
  type AttemptTimer,
  type Projection,
  type ResponseAnswer,
  type ResponseEvent,
  type SubmissionReason,
  type SyncQueue,
  type SyncStatus,
} from '@questionbank/attempt-engine';
import type { AttemptDto, ResultDto } from '../api/schemas.js';
import { saveRecord, type SessionRecord } from './persistence.js';
import type { SessionPorts } from './ports.js';

/**
 * The learner's attempt on this device (M6-47): **the one place its state lives, and all of it is the engine's.**
 *
 * The response log, the attempt's state, the queue of what is still unsent and the timer are the attempt engine's values, held here
 * in private fields and changed only by calling the engine's functions. Nothing a screen shows about the attempt is kept anywhere
 * else: the answers are the engine's projection, the question on screen is the slot of the log's open visit, the time left is the
 * engine's timer read at the clock's moment, whether it is synced is the engine's `syncStatus`. A component reads a snapshot of
 * these and calls the actions below; it keeps no copy, so it cannot disagree with the engine and cannot lose what the engine holds.
 *
 * The projection uses `intervalCapMs` **as the server pinned it**, given at the start and never chosen here.
 *
 * Time is the clock port's monotonic reading, never the wall clock; the network is the transport port; the disk is the storage
 * port. `pump()` is how the outside world says "some time has passed": it advances the timer, submits at the deadline, and sends
 * what is due. Nothing in this class sets a timer of its own.
 */
export type Phase = 'in_progress' | 'submitting' | 'submitted';

export interface SessionSnapshot {
  readonly attemptId: string;
  readonly phase: Phase;
  /** The engine's projection of the log, over the cap the server pinned. */
  readonly projection: Projection;
  /** The slot with an open visit in the log, or `null` between questions. */
  readonly currentSlot: string | null;
  /** Slots the learner has flagged, as the log says. */
  readonly remainingMs: number;
  /** The engine's own account of whether what was captured has been sent. */
  readonly sync: SyncStatus;
  readonly pending: number;
  /** Events the server refused for good; they stay in the log and are not sent again. */
  readonly rejected: number;
  readonly submission: { readonly reason: SubmissionReason } | null;
  readonly intervalCapMs: number;
  readonly result: ResultDto | null;
  /** The last thing that stopped a submission going through, for a person to read; `null` once it does. */
  readonly submissionNote: string | null;
}

export interface SessionStart {
  readonly attemptId: string;
  readonly deviceRef: string;
  /** From the attempt response — read, not chosen. */
  readonly intervalCapMs: number;
  /** The server's deadline and the server's reading of its clock when it said so: what is left is their difference. */
  readonly deadline: string;
  readonly serverNow: string;
}

export interface ResumeFromRecord {
  readonly record: SessionRecord;
  /** A fresh read of the attempt: the deadline is the server's, so a reload resumes against it and does not restart it. */
  readonly server: AttemptDto;
}


/** A new attempt, started. The engine always starts a created one, so there is no refusal to handle. */
function freshAttempt(attemptId: string): Attempt {
  return (startAttempt(createAttempt(attemptId)) as { attempt: Attempt }).attempt;
}

function lastSequence(attempt: Attempt): number {
  return attempt.log.events.at(-1)?.sequence ?? 0;
}

export class AttemptSession {
  #attempt: Attempt;
  #queue: SyncQueue;
  #timer: AttemptTimer;
  #phase: Phase;
  #acknowledged = new Set<string>();
  #rejected = new Set<string>();
  #result: ResultDto | null = null;
  #note: string | null = null;
  #sending = false;
  #listeners = new Set<() => void>();
  #cached: SessionSnapshot | null = null;

  private constructor(
    private readonly init: { readonly attemptId: string; readonly deviceRef: string; readonly intervalCapMs: number; readonly deadline: string },
    private readonly ports: SessionPorts,
    attempt: Attempt,
    timer: AttemptTimer,
    phase: Phase,
  ) {
    this.#attempt = attempt;
    this.#timer = timer;
    this.#phase = phase;
    this.#queue = createSyncQueue(init.attemptId, ports.syncPolicy);
  }

  /** A new attempt that has just been started on the server. */
  static begin(start: SessionStart, ports: SessionPorts): AttemptSession {
    const session = new AttemptSession(
      { attemptId: start.attemptId, deviceRef: start.deviceRef, intervalCapMs: start.intervalCapMs, deadline: start.deadline },
      ports,
      freshAttempt(start.attemptId),
      AttemptSession.timerFor(start.deadline, start.serverNow, ports),
      'in_progress',
    );
    session.#persist();
    return session;
  }

  /**
   * An attempt this device was already sitting, rebuilt through the engine from what it wrote down. **The deadline is read afresh from the
   * server**, and the time left is the difference between it and the server's own reading of its clock — so a reload resumes against the
   * same deadline and never restarts it, however long the app was closed.
   */
  static resume({ record, server }: ResumeFromRecord, ports: SessionPorts): AttemptSession {
    let current = freshAttempt(record.attemptId);
    for (const event of record.events) {
      const captured = captureResponse(current, event);
      if (!captured.ok) throw new Error(`the stored log does not rebuild: ${captured.reason}`);
      current = captured.attempt;
    }
    const submitted = record.submissionReason !== null || server.state === 'submitted';
    if (submitted) {
      const reason = record.submissionReason ?? server.submission?.reason ?? 'manual';
      // An in-progress attempt with no submission always takes one, so the result is the attempt.
      current = (submitAttempt(current, { reason, idempotencyKey: `submission:${record.attemptId}` }) as { attempt: Attempt }).attempt;
    }
    const session = new AttemptSession(
      { attemptId: record.attemptId, deviceRef: record.deviceRef, intervalCapMs: server.intervalCapMs, deadline: server.deadline ?? record.deadline },
      ports,
      current,
      AttemptSession.timerFor(server.deadline ?? record.deadline, server.serverNow, ports),
      server.state === 'submitted' ? 'submitted' : submitted ? 'submitting' : 'in_progress',
    );
    session.#acknowledged = new Set(record.acknowledgedIds);
    session.#rejected = new Set(record.rejectedIds);
    for (const event of current.log.events) {
      if (!session.#acknowledged.has(event.eventId) && !session.#rejected.has(event.eventId)) session.#enqueue(event);
    }
    session.#persist();
    return session;
  }

  private static timerFor(deadline: string, serverNow: string, ports: SessionPorts): AttemptTimer {
    const left = Math.max(0, Date.parse(deadline) - Date.parse(serverNow));
    return startTimer(left, ports.clock.now());
  }

  /* ---------------------------------------------------------------- reading */

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** Stable between changes, so a React store can compare it by identity. Everything in it is derived from the engine's values. */
  getSnapshot(): SessionSnapshot {
    if (this.#cached === null) this.#cached = this.#derive();
    return this.#cached;
  }

  #derive(): SessionSnapshot {
    const now = this.ports.clock.now();
    return Object.freeze({
      attemptId: this.init.attemptId,
      phase: this.#phase,
      projection: projectAttempt(this.#attempt, { intervalCapMs: this.init.intervalCapMs }),
      currentSlot: this.#openVisit(),
      remainingMs: remainingMs(this.#timer, now),
      sync: syncStatus(this.#queue, now),
      pending: this.#queue.pending.length,
      rejected: this.#rejected.size,
      submission: this.#attempt.submission === null ? null : Object.freeze({ reason: this.#attempt.submission.reason }),
      intervalCapMs: this.init.intervalCapMs,
      result: this.#result,
      submissionNote: this.#note,
    });
  }

  /** Whether a slot is flagged, from the log: the last flag or unflag for it. */
  isFlagged(slot: string): boolean {
    return this.getSnapshot().projection.slots.find((entry) => entry.slot === slot)?.flagged ?? false;
  }

  /** The slot of the log's last visit, if no leave has followed it. */
  #openVisit(): string | null {
    for (let index = this.#attempt.log.events.length - 1; index >= 0; index -= 1) {
      const event = this.#attempt.log.events[index]!;
      if (event.kind === 'leave') return null;
      if (event.kind === 'visit') return event.slot;
    }
    return null;
  }

  /* ---------------------------------------------------------------- acting */

  /** Moves to a question: leaving the one on screen and visiting the next, as two events, so time on item is the engine's to compute. */
  goTo(slot: string): void {
    const open = this.#openVisit();
    if (open === slot) return;
    if (open !== null) this.#record('leave', open);
    this.#record('visit', slot);
  }

  /** Leaves the question on screen without visiting another: the learner went to the palette, or put the app away. */
  leave(): void {
    const open = this.#openVisit();
    if (open !== null) this.#record('leave', open);
  }

  /** Records an answer: the first for a slot is a `select`, a later one a `change`, as the engine's projection defines them. */
  select(slot: string, answer: ResponseAnswer): void {
    const existing = this.getSnapshot().projection.slots.find((entry) => entry.slot === slot);
    this.#record(existing === undefined || existing.answer === null ? 'select' : 'change', slot, answer);
  }

  clear(slot: string): void {
    this.#record('clear', slot);
  }

  flag(slot: string, on: boolean): void {
    this.#record(on ? 'flag' : 'unflag', slot);
  }

  #record(kind: ResponseEvent['kind'], slot: string, answer?: ResponseAnswer): void {
    const base = {
      eventId: this.ports.newId(),
      attemptId: this.init.attemptId,
      slot,
      sequence: lastSequence(this.#attempt) + 1,
      monotonicMs: Math.round(this.ports.clock.now()),
    };
    const event = (answer === undefined ? { ...base, kind } : { ...base, kind, answer }) as ResponseEvent;
    const captured = captureResponse(this.#attempt, event);
    if (!captured.ok) return; // not in progress: the engine takes no response, and says so by taking none
    this.#attempt = captured.attempt;
    this.#enqueue(event);
    this.#changed();
  }

  #enqueue(event: ResponseEvent): void {
    const queued = enqueue(this.#queue, event);
    if (queued.ok) this.#queue = queued.queue;
  }

  /* ---------------------------------------------------------------- time passing */

  /**
   * "Some time has passed." Advances the timer, submits at the deadline, and sends what is due. The learner's device may have been
   * asleep, backgrounded or reloaded: none of that extends the deadline, which is the server's and is re-read on resume.
   */
  async pump(): Promise<void> {
    const now = this.ports.clock.now();
    this.#timer = advance(this.#timer, now);
    this.#changed(false);
    if (this.#phase === 'in_progress' && remainingMs(this.#timer, now) === 0) {
      await this.submit('expiry');
      return;
    }
    if (this.#phase === 'submitting') await this.#finishSubmission();
    else await this.#send();
  }

  /** A person asked, or the network came back: forget the back-off and try now. */
  async syncNow(): Promise<void> {
    this.#queue = resumeSync(this.#queue);
    this.#changed(false);
    if (this.#phase === 'submitting') await this.#finishSubmission();
    else await this.#send();
  }

  async #send(): Promise<void> {
    if (this.#sending) return;
    this.#sending = true;
    try {
      for (;;) {
        const now = this.ports.clock.now();
        const batch = nextBatch(this.#queue, now);
        if (batch.length === 0) return;
        try {
          const answered = await this.ports.transport.sendEvents(this.init.attemptId, this.init.deviceRef, batch);
          // A refused event is final: the verdict does not change by asking again. It stays in the log; it leaves the queue.
          for (const id of answered.rejected) this.#rejected.add(id);
          for (const id of answered.acknowledged) this.#acknowledged.add(id);
          this.#queue = acknowledge(this.#queue, [...answered.acknowledged, ...answered.rejected]);
          this.#changed();
          if (answered.acknowledged.length + answered.rejected.length === 0) return;
        } catch {
          this.#queue = recordFailure(this.#queue, this.ports.clock.now());
          this.#changed();
          return;
        }
      }
    } finally {
      this.#sending = false;
    }
  }

  /* ---------------------------------------------------------------- submitting */

  /**
   * Submits. The engine takes the submission first, so nothing more is captured; then what is unsent is sent; then the server is told.
   * The reason is the caller's and goes through as it is: `expiry` for the deadline, `manual` for the learner's own.
   */
  async submit(reason: SubmissionReason): Promise<void> {
    if (this.#phase === 'submitted') return;
    if (this.#attempt.submission === null) {
      // An attempt with no submission is in progress (a submitted one has one), and an in-progress attempt always takes it.
      this.#attempt = (submitAttempt(this.#attempt, { reason, idempotencyKey: `submission:${this.init.attemptId}` }) as { attempt: Attempt }).attempt;
      this.#phase = 'submitting';
      this.#changed();
    }
    await this.#finishSubmission();
  }

  async #finishSubmission(): Promise<void> {
    await this.#send();
    if (this.#queue.pending.length > 0) return; // still offline or backing off: tried again at the next pump
    // Only reached with a submission in hand: `submit` takes it first, and a resumed attempt is rebuilt with it.
    const submission = this.#attempt.submission as NonNullable<Attempt['submission']>;
    try {
      await this.ports.transport.submit(this.init.attemptId, submission.reason, submission.idempotencyKey);
      this.#phase = 'submitted';
      this.#note = null;
      this.#changed();
    } catch (error) {
      // Not final: an expiry sent a hair before the server's own deadline is refused, and offline it simply does not arrive. Tried again.
      this.#note = error instanceof Error ? error.message : 'the submission has not reached the server yet';
      this.#changed();
    }
  }

  async refreshResult(): Promise<void> {
    if (this.#phase !== 'submitted') return;
    try {
      this.#result = await this.ports.transport.getResult(this.init.attemptId);
      this.#changed();
    } catch {
      // not ready, or not reachable: the screen says "pending" and asks again
    }
  }

  /* ---------------------------------------------------------------- bookkeeping */

  #record_(): SessionRecord {
    return {
      version: 1,
      attemptId: this.init.attemptId,
      deviceRef: this.init.deviceRef,
      intervalCapMs: this.init.intervalCapMs,
      deadline: this.init.deadline,
      submissionReason: this.#attempt.submission?.reason ?? null,
      events: this.#attempt.log.events,
      acknowledgedIds: [...this.#acknowledged],
      rejectedIds: [...this.#rejected],
    };
  }

  #persist(): void {
    saveRecord(this.ports.storage, this.#record_());
  }

  #changed(persist = true): void {
    this.#cached = null;
    if (persist) this.#persist();
    for (const listener of this.#listeners) listener();
  }
}

