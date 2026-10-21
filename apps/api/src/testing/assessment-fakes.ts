import { err, ok, type Result } from '../contexts/assessment/domain/result.js';
import { conflictError, notFoundError } from '../contexts/assessment/domain/assessment-error.js';
import type { Attempt } from '../contexts/assessment/domain/attempt.js';
import type { AttemptState } from '../contexts/assessment/domain/attempt-state.js';
import { closeForm, openForm, publishForm, scheduleForm, type Form, type ScheduleWindow } from '../contexts/assessment/domain/form.js';
import type { AttemptRepository, FormRepository, RepositoryError, ResponseLog } from '../contexts/assessment/domain/repository-ports.js';
import type { ResponseEvent } from '../contexts/assessment/domain/response-event.js';
import type { JsonValue } from '../contexts/assessment/domain/form-package.js';
import { Ed25519PackageSigner } from '../contexts/assessment/infrastructure/package-signer.js';
import type { FormContentReader, FormCorpus, LoadedCorpus } from '../contexts/assessment/application/ports.js';
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
  /** Attempt ids whose save is refused as stale. */
  readonly stale = new Set<string>();

  async create(attempt: Attempt): Promise<Result<Attempt, RepositoryError>> {
    this.stored.set(attempt.attemptId, attempt);
    return ok(attempt);
  }

  async save(attempt: Attempt, expected: AttemptState): Promise<Result<Attempt, RepositoryError>> {
    if (this.stale.has(attempt.attemptId) || this.stored.get(attempt.attemptId)?.state !== expected) {
      return err(conflictError('CONFLICT', 'the attempt moved', 'state'));
    }
    this.stored.set(attempt.attemptId, attempt);
    return ok(attempt);
  }

  async findById(attemptId: string): Promise<Result<Attempt, RepositoryError>> {
    const found = this.stored.get(attemptId);
    return found === undefined ? err(notFoundError('NOT_FOUND', 'no attempt', 'attempt')) : ok(found);
  }

  async findActiveMock(): Promise<Result<Attempt | undefined, RepositoryError>> {
    return ok(undefined);
  }

  failFindWith: RepositoryError | null = null;

  async findAbandonable(now: string, limit: number): Promise<Result<readonly Attempt[], RepositoryError>> {
    if (this.failFindWith !== null) return err(this.failFindWith);
    return ok(
      [...this.stored.values()]
        .filter((a) => (a.state === 'created' || a.state === 'in_progress') && a.windowClosesAt <= now)
        .slice(0, limit),
    );
  }
}

export class InMemoryResponses implements ResponseLog {
  readonly answered = new Map<string, number>();
  failFor: string | null = null;

  async append(event: ResponseEvent): Promise<Result<ResponseEvent, RepositoryError>> {
    return ok(event);
  }

  async findByAttempt(): Promise<Result<readonly ResponseEvent[], RepositoryError>> {
    return ok([]);
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
