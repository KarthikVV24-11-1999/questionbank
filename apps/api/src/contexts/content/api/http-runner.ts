import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import type { Handler, HandlerRegistry } from '../application/handler-registry.js';
import { statusForKind, toProblemDetails, validationProblem } from './problem-details.js';

/**
 * What both content controllers do with a request, in one place: echo the
 * correlation id, authenticate, validate at the boundary, resolve the handler,
 * map the typed result onto a status.
 *
 * **No business rule and no authorization decision lives here.** Authorization
 * is at the handler, where a background worker also passes; a controller that
 * decided it would leave the import path and the worker path disagreeing.
 *
 * It is shared by the authoring and delivery controllers and carries no DTO of
 * either family, so sharing it does not make an `Authoring*` shape reachable
 * from delivery (ADR-0009 condition 3).
 */

export const CONTENT_REGISTRY = Symbol('CONTENT_REGISTRY');
export const CONTENT_PRINCIPAL_RESOLVER = Symbol('CONTENT_PRINCIPAL_RESOLVER');

export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

export interface HttpRunnerDependencies {
  readonly registry: HandlerRegistry;
  readonly principals: PrincipalResolver;
}

export async function runOperation(
  deps: HttpRunnerDependencies,
  response: Response,
  headers: Record<string, string>,
  handlerName: string,
  successStatus: number,
  schema: ZodType,
  input: unknown,
): Promise<void> {
  // Echoed on every response, error or not (§8).
  const correlationId = headers['x-correlation-id'] ?? randomUUID();
  response.setHeader('X-Correlation-Id', correlationId);

  const principal = deps.principals.resolve(headers);
  if (principal === null) {
    fail(
      response,
      { kind: 'Authentication', code: 'Authentication', message: 'Authentication is required.' },
      correlationId,
    );
    return;
  }

  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
      .join('; ');
    response.status(400).type('application/problem+json').json(validationProblem(detail, correlationId));
    return;
  }

  const handler = deps.registry.get(handlerName) as Handler<unknown, unknown> | undefined;
  if (handler === undefined) {
    fail(
      response,
      { kind: 'Unavailable', code: 'Unavailable', message: 'The operation is not available.' },
      correlationId,
    );
    return;
  }

  const context: ApplicationContext = {
    principal,
    correlationId,
    stepUpSatisfied: headers['x-step-up'] === 'satisfied',
  };

  const result = await handler.handle(parsed.data, context);
  if (!result.ok) {
    fail(response, result.error, correlationId);
    return;
  }

  if (successStatus === 204) {
    response.status(204).end();
    return;
  }
  response.status(successStatus).json(result.value);
}

function fail(response: Response, error: ApplicationError, correlationId: string): void {
  response
    .status(statusForKind(error.kind))
    .type('application/problem+json')
    .json(toProblemDetails(error, correlationId));
}
