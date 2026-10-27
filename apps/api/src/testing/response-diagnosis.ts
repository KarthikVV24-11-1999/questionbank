import type { Pool } from 'pg';
import { onTestFailed } from 'vitest';

/**
 * Says which kind of 404 a route gave (M7-20), without saying it on the wire.
 *
 * There are three, and the intermittent failure turned out to be the third (D73). **ABSENT** and **EXCLUDED** are the two the application can mean; the third,
 * **CONTROLLER_DID_NOT_RUN**, is a 404 the application did not write at all — the controller sets `X-Correlation-Id` before it does anything else, so a response
 * without it did not come from a route of ours. It is how a request answered by some other process on the same port reads.
 *
 * `404 no attempt <id>` is the answer to two different facts, and the application means it to be: an attempt that does not exist, and an attempt that
 * exists and is not the caller's (`ownAttempt`), so that the route discloses nothing about which ids are real. A reason on the response would be the
 * disclosure. So the distinction is made here, in the test, by reading the row directly at the moment a route 404s: **ABSENT** (no row with that id) or
 * **EXCLUDED** (a row, which the lookup did not hand over), with what the row says. The same for the `412` the scoring spec saw once, which reads
 * the attempt's state: a result is refused for an attempt that is not submitted.
 *
 * It records what the supertest requests answered, and on a failing test prints the classification of every response of interest — the evidence the
 * intermittent failure (D73) needs, in the one run that has it. Nothing in the application changes and nothing is asserted: it only observes.
 */
export interface Observed {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly detail: string | undefined;
  /** The start of what the route wrote, whatever its content type: a route that matched and a route that did not read differently. */
  readonly text: string | undefined;
  /** The headers the route wrote. The controller sets `X-Correlation-Id` before it does anything else, so its absence says the controller did not run. */
  readonly headers: Record<string, unknown> | undefined;
  readonly authorization: string | undefined;
  /** Where the connection actually went: the socket was a reused keep-alive one, and the port at its far end against the port supertest had just opened. */
  /** The status line and raw headers as they came off the wire, and the request line as it was sent. */
  readonly wire?: { readonly statusMessage: string | undefined; readonly rawHeaders: readonly string[] | undefined; readonly requestLine: string };
  readonly connection?: { readonly reusedSocket: boolean | undefined; readonly remotePort: number | undefined; readonly serverPort: number | undefined };
}

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';
const VERBS: readonly Verb[] = ['get', 'post', 'put', 'patch', 'delete'];

interface Response {
  status: number;
  /** supertest leaves `body` empty for `application/problem+json`; the text is what the route wrote. */
  text?: string;
  body: { detail?: unknown };
  headers?: Record<string, unknown>;
  res?: { statusMessage?: string; rawHeaders?: string[]; httpVersion?: string };
  req?: { path?: string; method?: string; getHeader(name: string): unknown; reusedSocket?: boolean; socket?: { remotePort?: number; localPort?: number } };
}
interface Chainable {
  on(event: 'response', listener: (response: Response) => void): unknown;
  /** supertest's own listener, started when the request is built. */
  _server?: { address(): { port?: number } | string | null };
}

function detailOf(response: Response): string | undefined {
  if (typeof response.body?.detail === 'string') return response.body.detail;
  try {
    const parsed = JSON.parse(response.text ?? '') as { detail?: unknown };
    return typeof parsed.detail === 'string' ? parsed.detail : undefined;
  } catch {
    return undefined;
  }
}

const subOf = (authorization: string | undefined): string | undefined => {
  const token = authorization?.replace(/^Bearer /u, '').split('.')[1];
  if (token === undefined) return undefined;
  try {
    return (JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { sub?: string }).sub;
  } catch {
    return undefined;
  }
};

export type Kind =
  | { readonly kind: 'CONTROLLER_DID_NOT_RUN'; readonly wrote: string }
  | { readonly kind: 'ABSENT'; readonly attemptId: string }
  | { readonly kind: 'EXCLUDED'; readonly attemptId: string; readonly callerIsOwner: boolean; readonly state: string; readonly row: Record<string, unknown> }
  | { readonly kind: 'NOT_SUBMITTED'; readonly attemptId: string; readonly state: string; readonly row: Record<string, unknown> };

export async function classify(pool: Pool, observed: Observed): Promise<Kind | undefined> {
  if (observed.status === 404 && observed.headers !== undefined && observed.headers['x-correlation-id'] === undefined) {
    return { kind: 'CONTROLLER_DID_NOT_RUN', wrote: JSON.stringify({ text: observed.text ?? '', headers: observed.headers }) };
  }
  const attemptId = /\/attempts\/([0-9a-f-]{36})/u.exec(observed.url)?.[1];
  if (attemptId === undefined) return undefined;
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT attempt_id, student_id, state, mode, form_id, started_at, deadline_at, submitted_at, created_at FROM assessment.attempt WHERE attempt_id = $1',
    [attemptId],
  );
  const row = rows[0];
  if (observed.status === 404 && /^no attempt /u.test(observed.detail ?? '')) {
    return row === undefined
      ? { kind: 'ABSENT', attemptId }
      : { kind: 'EXCLUDED', attemptId, callerIsOwner: row['student_id'] === subOf(observed.authorization), state: String(row['state']), row };
  }
  if (observed.status === 412 && row !== undefined) return { kind: 'NOT_SUBMITTED', attemptId, state: String(row['state']), row };
  return undefined;
}

/**
 * Wraps a supertest agent. When a request answers 404 or 412, the test is marked to print, if it fails, what the database held at that moment for the attempt.
 * `where` names which spec is observing, so two specs' output can be told apart.
 */
export function observing<T extends object>(agent: T, pool: () => Pool, where: string): T {
  return new Proxy(agent, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || !(VERBS as readonly string[]).includes(property) || typeof value !== 'function') return value;
      return (url: string, ...rest: unknown[]) => {
        const test = (value as (...a: unknown[]) => Chainable).call(target, url, ...rest);
        test.on('response', (response) => {
          if (response.status !== 404 && response.status !== 412) return;
          const text = response.text?.slice(0, 300);
          const detail = detailOf(response);
          const observed: Observed = { method: property, url, status: response.status, detail, text, headers: response.headers, wire: { statusMessage: response.res?.statusMessage, rawHeaders: response.res?.rawHeaders, requestLine: `${response.req?.method} ${response.req?.path}` }, authorization: response.req?.getHeader('authorization') as string | undefined, connection: { reusedSocket: response.req?.reusedSocket, remotePort: response.req?.socket?.remotePort, serverPort: typeof test._server?.address() === 'object' ? (test._server?.address() as { port?: number } | null)?.port : undefined } };
          // read at the moment of the response, not at the moment the test fails: the row can change in between
          const reading = classify(pool(), observed).then((kind) => ({ observed, kind }), (error: unknown) => ({ observed, kind: { error: String(error) } }));
          onTestFailed(async () => {
            const { kind } = await reading;
            // eslint-disable-next-line no-console
            console.error(`[${where}] ${observed.status} ${observed.method.toUpperCase()} ${observed.url} :: ${observed.detail ?? '(no detail)'} | wrote: ${observed.text ?? '(nothing)'} | headers: ${JSON.stringify(observed.headers)} | connection: ${JSON.stringify(observed.connection)} | wire: ${JSON.stringify(observed.wire)} => ${JSON.stringify(kind)}`);
          });
        });
        return test;
      };
    },
  });
}
