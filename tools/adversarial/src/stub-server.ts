import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { projectResponses, type Projection, type ResponseEvent } from '@questionbank/attempt-engine';
import { aPackageDocument, aSigner, encode } from './signed-package.js';

/**
 * A server for the learner app to talk to, as far as the app can tell: the form package, signed over its exact bytes; the attempt with
 * a deadline the server fixes at start and never moves; events accepted and held; a submission; a result. It serves the built app too,
 * so a browser loads the real bundle from the same origin it will call.
 *
 * It is **not** the API. It speaks the assessment contract's shapes and keeps events in memory, so what an adversarial run can
 * say about the server's side is limited to what this holds: the events it was sent and the deadline it fixed. That is the right
 * thing to hold a client to — what reached the server, by whatever route — and the wrong thing to claim anything about the API with.
 * The API's own half is proven against Postgres in `apps/api`.
 *
 * The server's clock is a parameter, so a run can fix "now" and the deadline is then a statement about the server's clock alone.
 */
export interface StubOptions {
  readonly distDir: string;
  readonly durationMs: number;
  readonly intervalCapMs: number;
  /** The port to listen on. Default: any free one, which is a new origin for the browser each time; a test that needs the same origin twice names one. */
  readonly port?: number;
  /** The server's clock. Default: the system clock. */
  readonly now?: () => number;
  /** Fields added to every item of the package before it is signed: a server that leaks, to see what a client does with a leak. */
  readonly packageItemExtra?: Record<string, unknown>;
  /** A planted defect: events are acknowledged and not kept. */
  readonly dropEvents?: boolean;
  /** A planted defect: reading the attempt moves the deadline to a full duration from now. */
  readonly restartDeadlineOnRead?: boolean;
}

interface StoredAttempt {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly deadline: number;
  submission: { readonly reason: string; readonly submittedAt: number; readonly pastDeadline: boolean } | null;
}

const FORM_ID = '00000000-0000-4000-8000-0000000000f1';
const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export class StubServer {
  /**
   * `'503'`: every call under `/v1` is answered 503, the backend is down. `'reset'`: the connection is dropped without an answer, the
   * way a network that goes away does. `'off'`: up.
   */
  outage: 'off' | '503' | 'reset' = 'off';
  /** The analytics edge is down: every request to it is answered 503, whatever `outage` says. */
  analyticsDown = false;
  /** What reached the analytics route: the events in each request and the status it was answered with. */
  readonly analytics: Array<{ readonly status: number; readonly events: unknown[] }> = [];
  readonly events = new Map<string, ResponseEvent>();
  readonly requests: Array<{ readonly method: string; readonly path: string }> = [];
  #attempt: StoredAttempt | null = null;
  #server: Server | null = null;
  readonly #signer = aSigner();
  readonly #bytes: Uint8Array;
  readonly #now: () => number;

  constructor(private readonly options: StubOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#bytes = encode(aPackageDocument(options.packageItemExtra));
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  get attempt(): StoredAttempt | null {
    return this.#attempt;
  }

  /** What the server derives from what it holds, over the cap it pinned: the same function the device and the API use. */
  projection(): Projection {
    return projectResponses([...this.events.values()], { intervalCapMs: this.options.intervalCapMs });
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve) => this.#server!.listen(this.options.port ?? 0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://x');
    const method = request.method ?? 'GET';
    if (url.pathname.startsWith('/v1/')) {
      this.requests.push({ method, path: url.pathname });
      if (this.outage === 'reset') {
        request.socket.destroy();
        return;
      }
      if (this.outage === '503') return this.#json(response, 503, { type: 'about:blank', title: 'Service Unavailable', status: 503 });
      return this.#api(method, url.pathname, request, response);
    }
    return this.#static(url.pathname, response);
  }

  async #static(pathname: string, response: ServerResponse): Promise<void> {
    const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/u, '');
    try {
      const body = await readFile(join(this.options.distDir, relative));
      response.writeHead(200, { 'content-type': TYPES[extname(relative)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  }

  #json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  async #body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text.length === 0 ? {} : JSON.parse(text);
  }

  #dto() {
    const attempt = this.#attempt;
    const now = this.#now();
    return {
      attemptId: attempt?.attemptId ?? randomUUID(),
      formId: FORM_ID,
      mode: 'mock',
      state: attempt === null ? 'created' : attempt.submission === null ? 'in_progress' : 'submitted',
      sessionRef: '2026-01-27/shift-1',
      shiftId: '2026-01-27/shift-1',
      slotCount: 3,
      durationMs: this.options.durationMs,
      intervalCapMs: this.options.intervalCapMs,
      windowClosesAt: new Date(now + 86_400_000).toISOString(),
      startedAt: attempt === null ? null : new Date(attempt.startedAt).toISOString(),
      deadline: attempt === null ? null : new Date(attempt.deadline).toISOString(),
      serverNow: new Date(now).toISOString(),
      submission:
        attempt?.submission == null
          ? null
          : { reason: attempt.submission.reason, submittedAt: new Date(attempt.submission.submittedAt).toISOString(), pastDeadline: attempt.submission.pastDeadline },
    };
  }

  async #api(method: string, path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (method === 'GET' && path === `/v1/assessment/forms/${FORM_ID}/package`) {
      const signed = this.#signer.sign(this.#bytes);
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-package-signature': signed.signature,
        'x-package-digest': signed.digest,
        'x-package-key-id': this.#signer.keyId,
        'cache-control': 'private, no-cache',
      });
      response.end(Buffer.from(this.#bytes));
      return;
    }
    if (method === 'POST' && path === '/v1/analytics/events') {
      const { events } = (await this.#body(request)) as { events?: unknown[] };
      const sent = Array.isArray(events) ? events : [];
      const status = this.analyticsDown ? 503 : 202;
      this.analytics.push({ status, events: sent });
      if (status === 503) return this.#json(response, 503, { type: 'about:blank', title: 'Service Unavailable', status: 503 });
      return this.#json(response, 202, { results: sent.map((_, index) => ({ index, outcome: 'accepted' })) });
    }
    // the report screen's one required read (M7-59): a scored mock with one finding
    const reported = /^\/v1\/learning\/attempts\/([^/]+)\/report$/u.exec(path);
    if (method === 'GET' && reported !== null) {
      const concept = '00000000-0000-4000-8000-0000000000c1';
      const taxonomy = '00000000-0000-4000-8000-0000000000d1';
      return this.#json(response, 200, {
        reportId: randomUUID(),
        attemptId: reported[1],
        scoreRecordId: randomUUID(),
        generatedAt: new Date(this.#now()).toISOString(),
        findings: [{ rank: 1, conceptIdentityId: concept, taxonomyVersionId: taxonomy, marksLost: '4', marksAvailable: '8', slots: 2, skipped: 0, remediation: { strategy: 'targeted', taxonomyVersionId: taxonomy, conceptIdentityId: concept, selected: true } }],
      });
    }
    if (method === 'GET' && path === '/v1/assessment/package-signing-key') {
      return this.#json(response, 200, { algorithm: 'Ed25519', keyId: this.#signer.keyId, publicKey: this.#signer.publicKey });
    }
    if (method === 'POST' && path === '/v1/assessment/attempts') {
      await this.#body(request);
      const replayed = this.#attempt !== null;
      this.#attempt ??= { attemptId: randomUUID(), startedAt: 0, deadline: 0, submission: null };
      return this.#json(response, replayed ? 200 : 201, { attempt: { ...this.#dto(), state: this.#attempt.startedAt === 0 ? 'created' : 'in_progress', startedAt: null, deadline: null }, replayed });
    }
    const match = /^\/v1\/assessment\/attempts\/([^/]+)(\/start|\/events|\/submission|\/result)?$/u.exec(path);
    const attempt = this.#attempt;
    if (match === null || attempt === null || match[1] !== attempt.attemptId) return this.#json(response, 404, { type: 'about:blank', title: 'Not Found', status: 404 });
    const tail = match[2] ?? '';
    if (method === 'POST' && tail === '/start') {
      if (attempt.startedAt === 0) {
        const startedAt = this.#now();
        this.#attempt = { ...attempt, startedAt, deadline: startedAt + this.options.durationMs };
      }
      return this.#json(response, 200, this.#dto());
    }
    if (method === 'GET' && tail === '') {
      if (this.options.restartDeadlineOnRead === true && attempt.startedAt !== 0) this.#attempt = { ...attempt, deadline: this.#now() + this.options.durationMs };
      // The attempt with the log of what the server holds, in its order (D68): the client sequence, then the event id.
      const log = [...this.events.values()].sort((a, b) => a.sequence - b.sequence || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
      return this.#json(response, 200, { ...this.#dto(), events: log });
    }
    if (method === 'POST' && tail === '/events') {
      const body = (await this.#body(request)) as { events: ResponseEvent[] };
      const results = body.events.map((event) => {
        const seen = this.events.has(event.eventId);
        if (!seen && this.options.dropEvents !== true) this.events.set(event.eventId, event);
        return { eventId: event.eventId, outcome: attempt.submission !== null ? 'late' : seen ? 'replayed' : 'accepted' };
      });
      return this.#json(response, 200, { attemptId: attempt.attemptId, state: attempt.submission === null ? 'in_progress' : 'submitted', results, acknowledged: results.map((result) => result.eventId) });
    }
    if (method === 'POST' && tail === '/submission') {
      const { reason } = (await this.#body(request)) as { reason: string };
      const now = this.#now();
      if (attempt.submission === null) {
        if (reason === 'expiry' && now < attempt.deadline) return this.#json(response, 409, { type: 'about:blank', title: 'Conflict', status: 409, reason: 'NOT_EXPIRED' });
        attempt.submission = { reason, submittedAt: now, pastDeadline: now > attempt.deadline };
      }
      return this.#json(response, 200, this.#dto());
    }
    if (method === 'GET' && tail === '/result') return this.#json(response, 200, { attemptId: attempt.attemptId, status: 'pending' });
    return this.#json(response, 404, { type: 'about:blank', title: 'Not Found', status: 404 });
  }
}
