import { randomUUID } from 'node:crypto';
import { Body, Controller, Headers, Inject, Ip, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ROLES } from '../../../platform/auth/roles.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import { isSaturation } from '../application/saturation.js';
import type { IdentityHandlers } from '../public/composition.js';
import type { Admission, RouteClass } from './admission.js';
import { statusForKind, toProblemDetails } from './problem-details.js';

export const IDENTITY_HANDLERS = Symbol('IDENTITY_HANDLERS');
export const IDENTITY_PRINCIPAL_RESOLVER = Symbol('IDENTITY_PRINCIPAL_RESOLVER');
export const IDENTITY_ADMISSION = Symbol('IDENTITY_ADMISSION');

/** What a route is limited by (M8-07). `null` on a route is a statement that it costs nothing worth limiting: a session ends, or is swapped for another. */
interface Limit {
  readonly route: RouteClass;
  readonly action: string;
  /** The text the caller named, or the signed-in user, or nobody. */
  readonly subject: { readonly text: unknown } | 'principal' | null;
}

/** How long a caller is told to wait when the work is saturated: long enough for a queue to drain a little, short enough not to be a lockout. */
const BUSY_RETRY_SECONDS = 5;

export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

interface Routed {
  readonly name: string;
  handle(input: never, context: ApplicationContext): Promise<{ ok: true; value: unknown } | { ok: false; error: ApplicationError }>;
}

/** Who a request is before it has logged in: nobody, with the one role the public routes admit. */
const ANONYMOUS = Object.freeze({ kind: 'human' as const, id: '00000000-0000-4000-8000-000000000000', roleContext: Object.freeze([ROLES.guest]) });

const BEARER = 'Bearer ';

/**
 * HTTP for identity (M8-01 to M8-04): registering, logging in, sessions, verification and recovery.
 *
 * Two kinds of route. The public ones (register, login, recovery, reset, verify) act as nobody; the others act as the principal the session middleware resolved for the
 * request, through the same `PrincipalResolver` port every other context takes. A route that needs the session's own token (logout, rotate, change of password) reads it from
 * the header it came in on: the principal says who, and does not say which of their sessions.
 *
 * Nothing here says whether an address is registered. Every public route answers the same for a known and an unknown one, and a refusal carries the same body whatever refused.
 */
@Controller()
export class IdentityController {
  constructor(
    @Inject(IDENTITY_HANDLERS) private readonly handlers: IdentityHandlers,
    @Inject(IDENTITY_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
    @Inject(IDENTITY_ADMISSION) private readonly admission: Admission,
  ) {}

  @Post('/v1/identity/register')
  async register(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.register, { email: field(body, 'email'), password: field(body, 'password') }, 202, 'anonymous', { route: 'register', action: 'register', subject: { text: field(body, 'email') } }, ip);
  }

  @Post('/v1/identity/login')
  async login(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.login, { email: field(body, 'email'), password: field(body, 'password') }, 200, 'anonymous', { route: 'login', action: 'login', subject: { text: field(body, 'email') } }, ip);
  }

  @Post('/v1/identity/password/recovery')
  async requestRecovery(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.requestPasswordRecovery, { email: field(body, 'email') }, 202, 'anonymous', { route: 'recovery', action: 'recovery', subject: { text: field(body, 'email') } }, ip);
  }

  @Post('/v1/identity/password/reset')
  async resetPassword(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.resetPassword, { token: field(body, 'token'), newPassword: field(body, 'newPassword') }, 200, 'anonymous', { route: 'reset', action: 'reset', subject: null }, ip);
  }

  @Post('/v1/identity/email/verify')
  async verifyEmail(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.verifyEmail, { token: field(body, 'token') }, 200, 'anonymous', { route: 'verification', action: 'verify-submit', subject: null }, ip);
  }

  @Post('/v1/identity/logout')
  async logout(@Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.logout, { sessionToken: bearerOf(headers) }, 200, 'session', null, ip);
  }

  @Post('/v1/identity/logout-all')
  async logoutAll(@Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.logoutAll, {}, 200, 'session', null, ip);
  }

  @Post('/v1/identity/session/rotate')
  async rotate(@Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.rotateSession, { sessionToken: bearerOf(headers) }, 200, 'session', null, ip);
  }

  @Post('/v1/identity/password/change')
  async changePassword(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.changePassword, { sessionToken: bearerOf(headers), currentPassword: field(body, 'currentPassword'), newPassword: field(body, 'newPassword') }, 200, 'session', { route: 'passwordChange', action: 'password-change', subject: 'principal' }, ip);
  }

  @Post('/v1/identity/email/verification')
  async requestVerification(@Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.requestEmailVerification, {}, 202, 'session', { route: 'verification', action: 'verify-issue', subject: 'principal' }, ip);
  }

  /** Admin only, and it derives nothing, so no limit of its own (M8-12): the cost of a call is two row locks and an update. */
  @Post('/v1/identity/roles/assign')
  async assignRole(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.assignRole, { email: field(body, 'email'), role: field(body, 'role') }, 200, 'session', null, ip);
  }

  @Post('/v1/identity/roles/remove')
  async removeRole(@Body() body: unknown, @Headers() headers: Record<string, string>, @Ip() ip: string, @Res() response: Response): Promise<void> {
    await this.run(response, headers, this.handlers.removeRole, { email: field(body, 'email'), role: field(body, 'role') }, 200, 'session', null, ip);
  }

  private async run<I>(response: Response, headers: Record<string, string>, handler: Routed, input: I, success: number, as: 'anonymous' | 'session', limit: Limit | null, ip: string): Promise<void> {
    const correlationId = headers['x-correlation-id'] ?? randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    // A session token, a verification code: nothing here is for a cache to keep.
    response.setHeader('Cache-Control', 'no-store');

    const principal = as === 'anonymous' ? ANONYMOUS : this.principals.resolve(headers);
    if (principal === null) {
      this.fail(response, { kind: 'Authentication', code: 'Authentication', message: 'Authentication is required.' }, correlationId);
      return;
    }
    if (limit !== null) {
      // Before the handler, so that a limited request costs a counter and nothing else: no lookup of the address, no derive.
      const subject = limit.subject === null ? null : limit.subject === 'principal' ? principal.id : typeof limit.subject.text === 'string' ? limit.subject.text : '';
      const admitted = await this.admission.check({ route: limit.route, action: limit.action, ip, subject }, correlationId);
      if (!admitted.allowed) {
        if (admitted.kind === 'limited') {
          response.setHeader('Retry-After', String(admitted.retryAfterSeconds));
          this.fail(response, { kind: 'RateLimited', code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' }, correlationId);
        } else {
          this.fail(response, { kind: 'Unavailable', code: 'UNAVAILABLE', message: 'The service is unavailable. Try again shortly.' }, correlationId);
        }
        return;
      }
    }
    let result: Awaited<ReturnType<Routed['handle']>>;
    try {
      result = await handler.handle(input as never, { principal, correlationId });
    } catch (error) {
      if (!isSaturation(error)) throw error;
      // The same answer for every caller whatever they asked about: a full queue is not a reason to tell an address from another.
      this.admission.record('WORK_SATURATED', error.reason, limit?.action ?? handler.name, correlationId);
      response.setHeader('Retry-After', String(BUSY_RETRY_SECONDS));
      this.fail(response, { kind: 'Unavailable', code: 'BUSY', message: 'The service is busy. Try again shortly.' }, correlationId);
      return;
    }
    if (!result.ok) {
      this.fail(response, result.error, correlationId);
      return;
    }
    response.status(success).json(result.value);
  }

  private fail(response: Response, error: ApplicationError, correlationId: string): void {
    response.status(statusForKind(error.kind)).type('application/problem+json').json(toProblemDetails(error, correlationId));
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
}

function bearerOf(headers: Record<string, string>): string | undefined {
  const raw = headers['authorization'];
  return typeof raw === 'string' && raw.startsWith(BEARER) ? raw.slice(BEARER.length) : undefined;
}
