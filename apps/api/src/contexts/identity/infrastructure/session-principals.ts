import type { PrincipalRef } from '@questionbank/domain-types';
import type { SessionAuthenticator, Authentication } from '../application/session-authenticator.js';

/**
 * The seam between a request and `PrincipalResolver` (M8-03), whose `resolve(headers)` is synchronous and cannot ask a database.
 *
 * A middleware, before any controller, authenticates the request's bearer token against the session table and records the answer against the request's own `headers`
 * object. `PostgresPrincipalResolver` is the port the contexts already take: it hands back what was recorded for the headers it is given. A call with headers that no request
 * went through (a copy, a hand-made object, a call outside a request) finds nothing recorded and is refused, so the failure mode of a miswired call site is a 401 and not an
 * open door. No controller changed to make this work.
 */
export type ResolutionRefusal = Extract<Authentication, { ok: false }>['code'] | 'LOOKUP_UNAVAILABLE' | 'NOT_RESOLVED';

/** The record the platform's log gets for a refusal: one entry, the code as an attribute, and never a token. */
export interface AuthLogger {
  log(entry: { readonly level: 'warn'; readonly message: string; readonly correlationId: string; readonly context: string; readonly attributes: { readonly errorCode: string } }): void;
}

export class SessionResolutions {
  readonly #byHeaders = new WeakMap<object, Authentication | { readonly ok: false; readonly code: 'LOOKUP_UNAVAILABLE' }>();

  record(headers: object, answer: Authentication | { readonly ok: false; readonly code: 'LOOKUP_UNAVAILABLE' }): void {
    this.#byHeaders.set(headers, answer);
  }

  recorded(headers: object): Authentication | { readonly ok: false; readonly code: 'LOOKUP_UNAVAILABLE' } | undefined {
    return this.#byHeaders.get(headers);
  }
}

export interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

export function sessionAuthentication(authenticator: SessionAuthenticator, resolutions: SessionResolutions) {
  return (request: RequestLike, _response: unknown, next: (error?: unknown) => void): void => {
    const header = request.headers['authorization'];
    authenticator.authenticate(typeof header === 'string' ? header : undefined).then(
      (answer) => {
        resolutions.record(request.headers, answer);
        next();
      },
      () => {
        resolutions.record(request.headers, { ok: false, code: 'LOOKUP_UNAVAILABLE' });
        next();
      },
    );
  };
}

export class PostgresPrincipalResolver {
  constructor(
    private readonly resolutions: SessionResolutions,
    private readonly logger?: AuthLogger,
  ) {}

  resolve(headers: Record<string, string | string[] | undefined>): PrincipalRef | null {
    const answer = this.resolutions.recorded(headers);
    if (answer === undefined) return this.refuse('NOT_RESOLVED');
    return answer.ok ? answer.principal : this.refuse(answer.code);
  }

  private refuse(code: ResolutionRefusal): null {
    this.logger?.log({ level: 'warn', message: 'authentication refused', correlationId: 'n/a', context: 'identity.auth', attributes: { errorCode: code } });
    return null;
  }
}
