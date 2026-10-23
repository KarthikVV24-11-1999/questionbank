import type { z } from 'zod';
import { ProblemDetailsSchema, type ProblemDetails } from './content-schemas.js';

/**
 * The typed HTTP client — F15's subject (§9 rule 15). "No hand-written API
 * call — everything through the generated client" has had no subject since
 * M1, because there was no generated client. This is that client: a thin
 * `fetch` wrapper typed **from the existing generated artifacts**
 * (`content-schemas.ts`'s Zod schemas here; `curriculum.ts`'s
 * openapi-typescript types for callers that need them) — it generates no
 * types of its own, because a second type source is a second thing to drift
 * from the document.
 *
 * **A response is parsed through the generated Zod schema at the boundary.**
 * An unexpected shape is a thrown `ResponseSchemaError`, not a cast — the
 * boundary is exactly where "trust the network" stops and "the schema says
 * so" starts.
 *
 * **No retry, no cache, no TanStack Query.** A walking skeleton needs none of
 * them, and adding one is a decision this file does not make on its own.
 */

export class ApiProblemError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiProblemError';
    this.problem = problem;
  }
}

export class ResponseSchemaError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    const fields = issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    super(`response failed schema validation at: ${fields}`);
    this.name = 'ResponseSchemaError';
    this.issues = issues;
  }
}

export class UnparseableErrorResponse extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`request failed with status ${status} and a body that is not problem-details shaped`);
    this.name = 'UnparseableErrorResponse';
    this.status = status;
  }
}

export interface ClientConfig {
  readonly baseUrl: string;
  /** Read fresh on every request — a token issued after the client was built must still be picked up. */
  readonly getToken: () => string | null;
  /** Overridable so a spec never touches the network (§5). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Overridable so a spec's correlation id is not random. Defaults to `crypto.randomUUID`. */
  readonly correlationId?: () => string;
}

export interface RequestOptions<T> {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** Extra request headers, such as an `Idempotency-Key`. They never replace the ones the client sets. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Validates the success response. */
  readonly responseSchema: z.ZodType<T>;
}

/** A response whose body is bytes to be kept exactly as sent — a signed package — with the headers that vouch for them. */
export interface BytesResponse {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
}

export interface ApiClient {
  request<T>(options: RequestOptions<T>): Promise<T>;
  /**
   * For a body that must reach the caller untouched: not parsed, not re-serialised, so a signature over it still means something.
   * A failure is a problem-details error exactly as for `request`.
   */
  requestBytes(options: Omit<RequestOptions<never>, 'responseSchema' | 'body'>): Promise<BytesResponse>;
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions<unknown>['query']): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function createClient(config: ClientConfig): ApiClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const nextCorrelationId = config.correlationId ?? (() => crypto.randomUUID());

  function send(options: Omit<RequestOptions<never>, 'responseSchema'>, accept: string): Promise<Response> {
    const headers: Record<string, string> = {
      ...options.headers,
      'X-Correlation-Id': nextCorrelationId(),
      Accept: accept,
    };
    const token = config.getToken();
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchImpl(buildUrl(config.baseUrl, options.path, options.query), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  /** A non-2xx response is a problem-details error, or an unparseable one; it never leaks the raw body. */
  function failure(response: Response, bodyText: string): never {
    let json: unknown;
    try {
      json = bodyText.length === 0 ? undefined : JSON.parse(bodyText);
    } catch {
      throw new UnparseableErrorResponse(response.status);
    }
    const problem = ProblemDetailsSchema.safeParse(json);
    if (!problem.success) throw new UnparseableErrorResponse(response.status);
    throw new ApiProblemError(problem.data);
  }

  async function request<T>(options: RequestOptions<T>): Promise<T> {
    const response = await send(options, 'application/json');
    const bodyText = await response.text();
    if (!response.ok) return failure(response, bodyText);
    let json: unknown;
    try {
      json = bodyText.length === 0 ? undefined : JSON.parse(bodyText);
    } catch {
      throw new ResponseSchemaError([]);
    }

    const parsed = options.responseSchema.safeParse(json);
    if (!parsed.success) throw new ResponseSchemaError(parsed.error.issues);
    return parsed.data;
  }

  async function requestBytes(options: Omit<RequestOptions<never>, 'responseSchema' | 'body'>): Promise<BytesResponse> {
    const response = await send(options, '*/*');
    if (!response.ok) return failure(response, await response.text());
    return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
  }

  return { request, requestBytes };
}
