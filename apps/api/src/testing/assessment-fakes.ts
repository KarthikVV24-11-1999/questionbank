import { err, ok, type Result } from '../contexts/assessment/domain/result.js';
import { conflictError, notFoundError } from '../contexts/assessment/domain/assessment-error.js';
import { appendSlot, type Attempt, type AttemptSlot } from '../contexts/assessment/domain/attempt.js';
import type { AssessmentEvent } from '../contexts/assessment/domain/events/assessment-events.js';
import type { AttemptState } from '../contexts/assessment/domain/attempt-state.js';
import { closeForm, openForm, publishForm, scheduleForm, type Form, type ScheduleWindow } from '../contexts/assessment/domain/form.js';
import type { AttemptRepository, FormRepository, RepositoryError, ResponseLog, SolutionReleases } from '../contexts/assessment/domain/repository-ports.js';
import type { ResponseEvent } from '../contexts/assessment/domain/response-event.js';
import type { JsonValue } from '../contexts/assessment/domain/form-package.js';
import { Ed25519PackageSigner } from '../contexts/assessment/infrastructure/package-signer.js';
import { deriveDeliveryPolicy, type PracticePolicy } from '../contexts/assessment/domain/delivery-policy.js';
import { makeReleasedSlot, type ReleasedSlot } from '../contexts/assessment/domain/solution-release.js';
import type { AttemptPins, AttemptPinSource, FormContentReader, FormCorpus, LoadedCorpus, PracticePins, PracticePinSource, SolutionContent, SolutionSource } from '../contexts/assessment/application/ports.js';
import type { ApplicationError } from '../contexts/assessment/application/authorization.js';

/**
 * In-memory doubles for the application specs, which are about what the
 * handlers decide and not about Postgres (that is proven against the real
 * database elsewhere). Each follows the real repository's contract on the
 * points a handler depends on: a publish is idempotent, a move is decided by
 * the domain, a stale write is a conflict.
 */
const missing = (id: string): RepositoryError => notFoundError('NOT_FOUND', `no form ${id}`, 'form');

export class InMemoryForms implements FormRepository {
  readonly stored = new Map<string, Form>();
  /** When set, `save` fails with it. */
  failSaveWith: RepositoryError | null = null;
  readonly publishedAnchors = new Set<string>();

  async save(form: Form): Promise<Result<Form, RepositoryError>> {
    if (this.failSaveWith !== null) return err(this.failSaveWith);
    this.stored.set(form.formId, form);
    return ok(form);
  }

  async findById(formId: string): Promise<Result<Form, RepositoryError>> {
    const found = this.stored.get(formId);
    return found === undefined ? err(missing(formId)) : ok(found);
  }

  async publish(formId: string, now: string) {
    const found = this.stored.get(formId);
    if (found === undefined) return err(missing(formId));
    if (found.state !== 'draft') return ok(found);
    const published = publishForm(found, now, this.publishedAnchors);
    if (published.ok) this.stored.set(formId, published.value);
    return published;
  }

  async schedule(formId: string, window: ScheduleWindow, now: string) {
    return this.#move(formId, (form) => scheduleForm(form, window, now));
  }

  async open(formId: string, now: string) {
    return this.#move(formId, (form) => openForm(form, now));
  }

  async close(formId: string, now: string) {
    return this.#move(formId, (form) => closeForm(form, now));
  }

  async findDueToOpen(now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>> {
    return ok([...this.stored.values()].filter((f) => f.state === 'embargoed' && (f.scheduleWindow?.opensAt ?? '~') <= now).slice(0, limit));
  }

  async findDueToClose(now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>> {
    return ok([...this.stored.values()].filter((f) => f.state === 'active' && (f.scheduleWindow?.closesAt ?? '~') <= now).slice(0, limit));
  }

  async #move(formId: string, decide: (form: Form) => ReturnType<typeof publishForm>) {
    const found = this.stored.get(formId);
    if (found === undefined) return err(missing(formId));
    const moved = decide(found);
    if (moved.ok) this.stored.set(formId, moved.value);
    return moved;
  }
}

export class InMemoryAttempts implements AttemptRepository {
  readonly stored = new Map<string, Attempt>();
  readonly creationKeys = new Map<string, string>();
  /** Attempt ids whose save is refused as stale. */
  readonly stale = new Set<string>();
  /** When true, `findActiveMock` reports none even if one exists — so the store's own refusal is what a test meets. */
  blindToActiveMock = false;

  async create(attempt: Attempt, creationKey?: string): Promise<Result<Attempt, RepositoryError>> {
    const live = [...this.stored.values()].find((a) => a.studentId === attempt.studentId && a.mode === 'mock' && (a.state === 'created' || a.state === 'in_progress'));
    if (attempt.mode === 'mock' && live !== undefined) return err(conflictError('CONFLICT', 'a concurrent write got there first (attempt_one_active_mock_per_student)', 'attempt_one_active_mock_per_student'));
    this.stored.set(attempt.attemptId, attempt);
    if (creationKey !== undefined) this.creationKeys.set(`${attempt.studentId}/${creationKey}`, attempt.attemptId);
    return ok(attempt);
  }

  async appendSlot(attemptId: string, slot: AttemptSlot, _writtenAt: string): Promise<Result<AttemptSlot, RepositoryError>> {
    const held = this.stored.get(attemptId);
    if (held === undefined) return err(notFoundError('NOT_FOUND', 'no attempt', 'attempt'));
    const grown = appendSlot(held, slot);
    if (!grown.ok) return err(conflictError('CONFLICT', grown.error.message, 'attempt_slot'));
    this.stored.set(attemptId, grown.value);
    return ok(slot);
  }

  async itemsSeenBy(studentId: string): Promise<Result<ReadonlySet<string>, RepositoryError>> {
    return ok(new Set([...this.stored.values()].filter((a) => a.studentId === studentId).flatMap((a) => a.slots.map((slot) => slot.itemId))));
  }

  async findByCreationKey(studentId: string, creationKey: string): Promise<Result<Attempt | undefined, RepositoryError>> {
    const id = this.creationKeys.get(`${studentId}/${creationKey}`);
    return ok(id === undefined ? undefined : this.stored.get(id));
  }

  /** Events written with a move, as the outbox would hold them: only for a move that happened. */
  readonly events: AssessmentEvent[] = [];

  async save(attempt: Attempt, expected: AttemptState, event?: AssessmentEvent): Promise<Result<Attempt, RepositoryError>> {
    if (this.stale.has(attempt.attemptId) || this.stored.get(attempt.attemptId)?.state !== expected) {
      return err(conflictError('CONFLICT', 'the attempt moved', 'state'));
    }
    this.stored.set(attempt.attemptId, attempt);
    if (event !== undefined) this.events.push(event);
    return ok(attempt);
  }

  async findById(attemptId: string): Promise<Result<Attempt, RepositoryError>> {
    const found = this.stored.get(attemptId);
    return found === undefined ? err(notFoundError('NOT_FOUND', 'no attempt', 'attempt')) : ok(found);
  }

  async findActiveMock(studentId?: string): Promise<Result<Attempt | undefined, RepositoryError>> {
    if (this.blindToActiveMock) return ok(undefined);
    return ok([...this.stored.values()].find((a) => a.studentId === studentId && a.mode === 'mock' && (a.state === 'created' || a.state === 'in_progress')));
  }

  failFindWith: RepositoryError | null = null;

  async findExpired(now: string, limit: number): Promise<Result<readonly Attempt[], RepositoryError>> {
    if (this.failFindWith !== null) return err(this.failFindWith);
    return ok([...this.stored.values()].filter((a) => a.state === 'in_progress' && a.deadline !== null && a.deadline <= now).slice(0, limit));
  }

  async findAbandonable(now: string, limit: number): Promise<Result<readonly Attempt[], RepositoryError>> {
    if (this.failFindWith !== null) return err(this.failFindWith);
    return ok(
      [...this.stored.values()]
        .filter((a) => (a.state === 'created' || a.state === 'in_progress') && a.windowClosesAt !== null && a.windowClosesAt <= now)
        .slice(0, limit),
    );
  }
}

/**
 * The response log as the database keeps it: idempotent on the event id, a different event under a used
 * id is a conflict, and an event is classified against the attempt's state when it is stored — `submitted`
 * makes it late, anything but in-progress or submitted refuses it. Given the attempts so that classification
 * can be made; without them every event counts.
 */
export class InMemoryResponses implements ResponseLog {
  readonly answered = new Map<string, number>();
  readonly events = new Map<string, ResponseEvent>();
  failFor: string | null = null;

  constructor(private readonly attempts?: InMemoryAttempts) {}

  async append(event: ResponseEvent): Promise<Result<ResponseEvent, RepositoryError>> {
    const prior = this.events.get(event.eventId);
    if (prior !== undefined) {
      const same = JSON.stringify([prior.slotId, prior.sequence, prior.kind, prior.answer, prior.clientMonotonicMs, prior.deviceRef]) === JSON.stringify([event.slotId, event.sequence, event.kind, event.answer, event.clientMonotonicMs, event.deviceRef]);
      return same ? ok(prior) : err(conflictError('CONFLICT', 'an event with this id was already recorded with different content', 'eventId'));
    }
    const state = this.attempts?.stored.get(event.attemptId)?.state ?? 'in_progress';
    if (state !== 'in_progress' && state !== 'submitted') return err(conflictError('PERSISTENCE_REJECTED', `assessment_attempt_not_accepting_responses: attempt is ${state}`, 'assessment_attempt_not_accepting_responses'));
    const stored = Object.freeze({ ...event, afterSubmission: state === 'submitted' });
    this.events.set(event.eventId, stored);
    return ok(stored);
  }

  async findByAttempt(attemptId: string): Promise<Result<readonly ResponseEvent[], RepositoryError>> {
    return ok([...this.events.values()].filter((e) => e.attemptId === attemptId).sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : 1)));
  }

  async answeredSlotCount(attemptId: string): Promise<Result<number, RepositoryError>> {
    return attemptId === this.failFor ? err(conflictError('CONFLICT', 'unreadable', 'responses')) : ok(this.answered.get(attemptId) ?? 0);
  }
}

export class StubCorpus implements FormCorpus {
  readonly requests: unknown[] = [];
  constructor(private readonly outcome: LoadedCorpus | ApplicationError) {}

  async load(request: unknown): Promise<Result<LoadedCorpus, ApplicationError>> {
    this.requests.push(request);
    return 'candidates' in this.outcome ? ok(this.outcome) : err(this.outcome);
  }
}

/** Delivery views by version id, as content would serve them; an id it does not hold is NotFound. */
export class InMemoryContent implements FormContentReader {
  readonly items = new Map<string, JsonValue>();
  readonly stimuli = new Map<string, JsonValue>();
  readonly asked: string[] = [];
  failWith: ApplicationError | null = null;

  async itemVersion(itemVersionId: string): Promise<Result<JsonValue, ApplicationError>> {
    this.asked.push(`item ${itemVersionId}`);
    return this.#answer(this.items.get(itemVersionId), itemVersionId);
  }

  async stimulusVersion(stimulusVersionId: string): Promise<Result<JsonValue, ApplicationError>> {
    this.asked.push(`stimulus ${stimulusVersionId}`);
    return this.#answer(this.stimuli.get(stimulusVersionId), stimulusVersionId);
  }

  #answer(view: JsonValue | undefined, id: string): Result<JsonValue, ApplicationError> {
    if (this.failWith !== null) return err(this.failWith);
    return view === undefined ? err({ kind: 'NotFound', code: 'NOT_FOUND', message: `no published version ${id}` }) : ok(view);
  }
}

/** A fixed seed, so a test can pin a signature; never a real key. */
export const TEST_SIGNING_SEED = Buffer.alloc(32, 7).toString('base64');
export const aSigner = (seed = TEST_SIGNING_SEED) => new Ed25519PackageSigner(seed);

/** The pins an attempt copies from a profile: a three-hour sitting, as JEE Main's is. */
export const TEST_PINS: AttemptPins = Object.freeze({
  taxonomyVersionId: '000000a5-0000-4000-8000-000000000001',
  markingRuleSetHash: 'a'.repeat(64),
  durationMs: 3 * 3_600_000,
  deliveryPolicy: Object.freeze({ timing: Object.freeze({ totalDurationMinutes: 180 }) }),
});

export class StubPins implements AttemptPinSource, PracticePinSource {
  readonly asked: string[] = [];
  failWith: ApplicationError | null = null;

  async pinsFor(examProfileVersionId: string): Promise<Result<AttemptPins, ApplicationError>> {
    this.asked.push(examProfileVersionId);
    return this.failWith === null ? ok(TEST_PINS) : err(this.failWith);
  }

  async practicePinsFor(examProfileVersionId: string, policy: PracticePolicy): Promise<Result<PracticePins, ApplicationError>> {
    this.asked.push(examProfileVersionId);
    if (this.failWith !== null) return err(this.failWith);
    const derived = deriveDeliveryPolicy({ kind: 'practice', policy });
    return ok(
      Object.freeze({
        taxonomyVersionId: TEST_PINS.taxonomyVersionId,
        markingRuleSetHash: TEST_PINS.markingRuleSetHash,
        isTimed: derived.isTimed,
        durationMs: derived.durationMs,
        deliveryPolicy: derived.document,
      }),
    );
  }
}

/** Scoring's read as the result handler uses it: a record per attempt, or NotFound while it is still pending. */
export class StubScoreRecords {
  readonly records = new Map<string, Record<string, unknown>>();
  readonly asked: { attemptId: string; ownerUserId: string }[] = [];
  failWith: ApplicationError | null = null;

  async handle(query: { attemptId: string; ownerUserId: string }): Promise<Result<never, ApplicationError>> {
    this.asked.push(query);
    if (this.failWith !== null) return err(this.failWith);
    const record = this.records.get(query.attemptId);
    return (record === undefined ? err({ kind: 'NotFound', code: 'NOT_FOUND', message: 'no score record' }) : ok(record)) as never;
  }
}

/** A response judge that answers by the answer it is given: `"right"` is correct, anything else is incorrect. Records what it was asked. */
export class StubJudge {
  readonly asked: { slotId: string; answer: unknown }[] = [];
  failWith: ApplicationError | null = null;

  async judge(_attempt: Attempt, slotId: string, answer: unknown): Promise<Result<string, ApplicationError>> {
    this.asked.push({ slotId, answer });
    if (this.failWith !== null) return err(this.failWith);
    return ok(answer === 'right' ? 'correct' : 'incorrect');
  }
}

/** An effort gate whose answers are set by the test: the slots named are released, with the version each pinned. The real gate is the database's view. */
export class InMemorySolutionReleases implements SolutionReleases {
  readonly #open = new Map<string, string>();

  open(attemptId: string, slotId: string, itemVersionId: string): void {
    this.#open.set(`${attemptId}/${slotId}`, itemVersionId);
  }

  async releasedSlot(attemptId: string, slotId: string): Promise<Result<ReleasedSlot | undefined, RepositoryError>> {
    const version = this.#open.get(`${attemptId}/${slotId}`);
    return ok(version === undefined ? undefined : makeReleasedSlot(attemptId, slotId, version));
  }
}

/** A solution source that serves one fixed solution and records which released slots it was asked for. */
export class StubSolutions implements SolutionSource {
  readonly asked: { itemVersionId: string; depth: 'basic' | 'full' }[] = [];
  failWith: ApplicationError | null = null;

  async solutionFor(slot: ReleasedSlot, depth: 'basic' | 'full'): Promise<Result<SolutionContent, ApplicationError>> {
    this.asked.push({ itemVersionId: slot.itemVersionId, depth });
    if (this.failWith !== null) return err(this.failWith);
    const step = (ordinal: number, text: string) => ({ ordinal, body: { blocks: [{ text }] }, conceptRefs: [] });
    return ok({
      solutionVersionId: '00000000-0000-4000-8000-0000000005a1',
      targetItemVersionId: slot.itemVersionId,
      steps: [step(1, 'Square both sides.'), step(2, 'So the answer is 9.')],
      ...(depth === 'full'
        ? {
            distractorAnalyses: [{ optionId: 'b', misconception: { blocks: [{ text: 'Doubling is not squaring.' }] } }],
            alternateApproaches: [{ label: 'By substitution', steps: [step(1, 'Try x = 3.')], applicabilityNote: 'Quick when the options are small.' }],
          }
        : {}),
    });
  }
}
