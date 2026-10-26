import type { AssessmentApi } from '../api/assessment-api.js';
import type { AttemptDto, ResultDto } from '../api/schemas.js';
import type { PackageResponse, SigningKey } from '../package/load.js';
import type { AttemptTransport, KeyValueStore, MonotonicClock, SessionPorts } from '../session/ports.js';
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

  async getAttempt(): Promise<AttemptDto> {
    if (!this.online) throw new TypeError('network unreachable');
    if (this.serverRemainingMs === null) return attemptDto();
    return attemptDto({ serverNow: new Date(Date.parse(attemptDto().deadline!) - this.serverRemainingMs).toISOString() });
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
  const transport = new FakeTransport();
  const storage = new MemoryStorage();
  let n = 0;
  const ports: SessionPorts = { clock, transport, storage, newId: () => `ev-${(n += 1)}`, syncPolicy: DEFAULT_SYNC_POLICY, ...overrides };
  return { clock, transport, storage, ports };
}

/** A whole fake server for the bootstrap: a signed package, a key, and the attempt routes. */
export class FakeApi implements AssessmentApi {
  readonly calls: string[] = [];
  createdKeys: string[] = [];
  attempt = attemptDto({ state: 'created', startedAt: null, deadline: null });
  stored: AttemptDtoLike | null = null;

  constructor(
    public packageResponse: PackageResponse,
    public key: SigningKey | Error,
    private readonly transport: FakeTransport = new FakeTransport(),
  ) {}

  async getPackage(): Promise<PackageResponse> {
    this.calls.push('getPackage');
    return this.packageResponse;
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
  async getAttempt(attemptId: string): Promise<AttemptDto> {
    this.calls.push('getAttempt');
    void attemptId;
    return this.stored ?? (await this.transport.getAttempt());
  }
  sendEvents = (...args: Parameters<FakeTransport['sendEvents']>) => this.transport.sendEvents(...args);
  submit = (...args: Parameters<FakeTransport['submit']>) => this.transport.submit(...args);
  getResult = () => this.transport.getResult();
}
type AttemptDtoLike = AttemptDto;
