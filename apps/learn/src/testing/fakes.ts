import type { AssessmentApi, PracticeRequest } from '../api/assessment-api.js';
import type { LearningApi } from '../api/learning-api.js';
import type { DiagnosticReportDto, PaceAnalyticsDto, ReviewPlanDto } from '../api/learning-schemas.js';
import type { AttemptDto, AttemptWithLogDto, ResultDto } from '../api/schemas.js';
import type { PackageResponse, SigningKey } from '../package/load.js';
import { assembleRecord, saveRecord, type EventRow, type RecordChange, type RecordStore, type SessionRecord, type StoredAttempt } from '../session/persistence.js';
import type { AttemptTransport, KeyValueStore, MonotonicClock, SessionPorts, WallClock } from '../session/ports.js';
import { DEFAULT_SYNC_POLICY } from '../session/ports.js';

/** A clock the test moves. The origin is arbitrary, as a monotonic clock's is: only differences mean anything. */
export class ManualClock implements MonotonicClock {
  constructor(public reading = 1_000) {}
  now(): number {
    return this.reading;
  }
  advance(ms: number): void {
    this.reading += ms;
  }
}

/**
 * A wall clock the test sets, in epoch milliseconds. Its origin matters here (unlike the monotonic clock's): the offset to the server's clock is taken
 * against it, and a test moves it to say the device's clock was wrong.
 */
export class ManualWallClock implements WallClock {
  constructor(public reading = Date.parse('2026-10-21T08:30:00.000Z')) {}
  now(): number {
    return this.reading;
  }
}

export class MemoryStorage implements KeyValueStore {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/**
 * The device's disk, in memory. A commit lands in `attempts` and `rows` only when it resolves, as a real one is on disk only then; a test can hold every commit (`hold()`), release
 * them (`release()`), or make them fail (`failWith`). `peek` reads what is committed, as a restart would find it.
 */
export class MemoryRecords implements RecordStore {
  readonly attempts = new Map<string, unknown>();
  readonly rows = new Map<string, Map<string, EventRow>>();
  activeId: string | null = null;
  readonly commits: RecordChange[] = [];
  failWith: Error | null = null;
  #held: Array<() => void> | null = null;

  /** Commits wait, from now until `release()`. */
  hold(): void {
    this.#held ??= [];
  }

  release(): void {
    const waiting = this.#held ?? [];
    this.#held = null;
    for (const go of waiting) go();
  }

  async commit(change: RecordChange): Promise<void> {
    if (this.#held !== null) await new Promise<void>((resolve) => this.#held!.push(resolve));
    if (this.failWith !== null) throw this.failWith;
    this.commits.push(change);
    this.attempts.set(change.meta.attemptId, change.meta);
    const rows = this.rows.get(change.meta.attemptId) ?? new Map<string, EventRow>();
    for (const row of change.rows) rows.set(row.eventId, row);
    this.rows.set(change.meta.attemptId, rows);
    if (change.active) this.activeId = change.meta.attemptId;
  }

  async read(attemptId: string): Promise<StoredAttempt | null> {
    return this.attempts.has(attemptId) ? { meta: this.attempts.get(attemptId), rows: [...(this.rows.get(attemptId)?.values() ?? [])] } : null;
  }

  async active(): Promise<string | null> {
    return this.activeId;
  }

  /** Lets every commit that can finish, finish: a few turns of the microtask queue. */
  async settle(): Promise<void> {
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
  }

  /** What a restart would read for this attempt, right now. */
  peek(attemptId: string): SessionRecord | null {
    return assembleRecord(attemptId, this.attempts.has(attemptId) ? { meta: this.attempts.get(attemptId), rows: [...(this.rows.get(attemptId)?.values() ?? [])] } : null);
  }
}

export const attemptDto = (overrides: Partial<AttemptDto> = {}): AttemptDto => ({
  attemptId: 'att-1',
  formId: 'form-1',
  mode: 'mock',
  state: 'in_progress',
  sessionRef: 's',
  shiftId: 's',
  slotCount: 3,
  durationMs: 10_800_000,
  intervalCapMs: 90_000,
  windowClosesAt: '2026-10-21T12:00:00.000Z',
  startedAt: '2026-10-21T08:30:00.000Z',
  deadline: '2026-10-21T11:30:00.000Z',
  serverNow: '2026-10-21T08:30:00.000Z',
  submission: null,
  ...overrides,
});

export const attemptWithLogDto = (overrides: Partial<AttemptWithLogDto> = {}): AttemptWithLogDto => ({ ...attemptDto(), events: [], ...overrides });

/** The server, as far as the session can tell: online or not, holding what it was sent, refusing what a test says to refuse. */
export class FakeTransport implements AttemptTransport {
  online = true;
  readonly stored = new Map<string, unknown>();
  readonly sends: string[][] = [];
  readonly submissions: { reason: string; key: string }[] = [];
  refuseEventIds = new Set<string>();
  refuseSubmissionUntil = 0;
  submitAttempts = 0;
  resultAnswer: ResultDto | Error = { attemptId: 'att-1', status: 'pending' };
  acknowledgeNothing = false;
  /** What the server says is left, from its own clock; `null` leaves the attempt as it was started (a long time to go). */
  serverRemainingMs: number | null = null;

  async getAttempt(): Promise<AttemptWithLogDto> {
    if (!this.online) throw new TypeError('network unreachable');
    if (this.serverRemainingMs === null) return attemptWithLogDto();
    return attemptWithLogDto({ serverNow: new Date(Date.parse(attemptDto().deadline!) - this.serverRemainingMs).toISOString() });
  }

  async sendEvents(_attemptId: string, _deviceRef: string, events: readonly unknown[]) {
    if (!this.online) throw new TypeError('network unreachable');
    const ids = (events as { eventId: string }[]).map((event) => event.eventId);
    this.sends.push(ids);
    if (this.acknowledgeNothing) return { acknowledged: [], rejected: [] };
    const rejected = ids.filter((id) => this.refuseEventIds.has(id));
    const acknowledged = ids.filter((id) => !this.refuseEventIds.has(id));
    for (const event of events as { eventId: string }[]) if (acknowledged.includes(event.eventId)) this.stored.set(event.eventId, event);
    return { acknowledged, rejected };
  }

  async submit(_attemptId: string, reason: 'manual' | 'expiry' | 'recovered', key: string): Promise<AttemptDto> {
    this.submitAttempts += 1;
    if (!this.online) throw new TypeError('network unreachable');
    if (this.submitAttempts <= this.refuseSubmissionUntil) throw new Error('an expiry submission is for an attempt whose deadline has passed');
    this.submissions.push({ reason, key });
    return attemptDto({ state: 'submitted', submission: { reason, submittedAt: '2026-10-21T11:30:00.000Z', pastDeadline: false } });
  }

  async getResult(): Promise<ResultDto> {
    if (this.resultAnswer instanceof Error) throw this.resultAnswer;
    return this.resultAnswer;
  }
}

export function aRig(overrides: Partial<SessionPorts> = {}) {
  const clock = new ManualClock();
  const wall = new ManualWallClock();
  const transport = new FakeTransport();
  const records = new MemoryRecords();
  let n = 0;
  const ports: SessionPorts = { clock, wall, transport, records, newId: () => `ev-${(n += 1)}`, syncPolicy: DEFAULT_SYNC_POLICY, ...overrides };
  return { clock, wall, transport, records, ports };
}

/** A whole fake server for the bootstrap: a signed package, a key, and the attempt routes. */
export class FakeApi implements AssessmentApi {
  readonly calls: string[] = [];
  createdKeys: string[] = [];
  attempt = attemptDto({ state: 'created', startedAt: null, deadline: null });
  stored: AttemptWithLogDto | null = null;

  constructor(
    public packageResponse: PackageResponse,
    public key: SigningKey | Error,
    private readonly transport: FakeTransport = new FakeTransport(),
  ) {}

  async getPackage(): Promise<PackageResponse> {
    this.calls.push('getPackage');
    return this.packageResponse;
  }
  /** The practice run's package, as served; absent, the run is not the caller's. */
  practicePackageResponse: PackageResponse | Error | null = null;
  async getPracticePackage(attemptId: string): Promise<PackageResponse> {
    this.calls.push(`getPracticePackage ${attemptId}`);
    if (this.practicePackageResponse instanceof Error) throw this.practicePackageResponse;
    if (this.practicePackageResponse === null) throw Object.assign(new Error('no such run'), { problem: { status: 404 } });
    return this.practicePackageResponse;
  }
  async getSigningKey(): Promise<SigningKey> {
    this.calls.push('getSigningKey');
    if (this.key instanceof Error) throw this.key;
    return this.key;
  }
  async createAttempt(_formId: string, _sessionRef: string, idempotencyKey: string): Promise<AttemptDto> {
    this.calls.push('createAttempt');
    this.createdKeys.push(idempotencyKey);
    return this.attempt;
  }
  async startAttempt(): Promise<AttemptDto> {
    this.calls.push('startAttempt');
    return attemptDto();
  }
  readonly practiceRequests: { request: PracticeRequest; key: string }[] = [];
  async createPracticeAttempt(request: PracticeRequest, key: string): Promise<AttemptDto> {
    this.calls.push('createPracticeAttempt');
    this.practiceRequests.push({ request, key });
    return attemptDto({ attemptId: 'run-1', mode: 'practice', formId: null, sessionRef: null, shiftId: null, durationMs: null, windowClosesAt: null, state: 'created', slotCount: request.count });
  }
  /** When set, the server is out of reach for `getAttempt` with this failure; the package and the key are still served (as the service worker's copy would be). */
  attemptFailure: Error | null = null;
  async getAttempt(attemptId: string): Promise<AttemptWithLogDto> {
    this.calls.push('getAttempt');
    void attemptId;
    if (this.attemptFailure !== null) throw this.attemptFailure;
    return this.stored ?? (await this.transport.getAttempt());
  }
  sendEvents = (...args: Parameters<FakeTransport['sendEvents']>) => this.transport.sendEvents(...args);
  submit = (...args: Parameters<FakeTransport['submit']>) => this.transport.submit(...args);
  getResult = () => this.transport.getResult();
}


/** Learning as far as a screen can tell: the answers a test sets, and the order in which the screen asked. */
export class FakeLearningApi implements LearningApi {
  readonly calls: string[] = [];
  plan: ReviewPlanDto | Error = { asOf: '2026-10-28T10:00:00.000Z', due: [], escalated: [] };
  weakest: readonly string[] | Error = [];
  reports = new Map<string, DiagnosticReportDto | Error>();
  paces = new Map<string, PaceAnalyticsDto | Error>();

  async getReviewPlan(): Promise<ReviewPlanDto> {
    this.calls.push('getReviewPlan');
    if (this.plan instanceof Error) throw this.plan;
    return this.plan;
  }
  async suggestRemediation(taxonomyVersionId: string): Promise<readonly string[]> {
    this.calls.push(`suggestRemediation ${taxonomyVersionId}`);
    if (this.weakest instanceof Error) throw this.weakest;
    return this.weakest;
  }
  async getReport(attemptId: string): Promise<DiagnosticReportDto> {
    this.calls.push(`getReport ${attemptId}`);
    const report = this.reports.get(attemptId) ?? new Error('REPORT_NOT_FOUND');
    if (report instanceof Error) throw report;
    return report;
  }
  async getPace(attemptId: string): Promise<PaceAnalyticsDto> {
    this.calls.push(`getPace ${attemptId}`);
    const pace = this.paces.get(attemptId) ?? new Error('PACE_NOT_FOUND');
    if (pace instanceof Error) throw pace;
    return pace;
  }
}

/** What a restart would read for an attempt once the session's pending commits have landed. */
export async function stored(rig: { readonly records: MemoryRecords }, attemptId: string): Promise<SessionRecord | null> {
  await rig.records.settle();
  return rig.records.peek(attemptId);
}

/** Rewrites what the device holds for an attempt, as a device whose record was of another shape or another build would hold it. */
export async function tamper(rig: { readonly records: MemoryRecords }, attemptId: string, change: (record: SessionRecord) => SessionRecord): Promise<void> {
  await saveRecord(rig.records, change((await stored(rig, attemptId))!));
}
