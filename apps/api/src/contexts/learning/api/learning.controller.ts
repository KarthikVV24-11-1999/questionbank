import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import type { LearningForLearner } from '../public/composition.js';
import { attemptIdSchema, createBookmarkSchema, errorEntriesSchema, remediationConceptsSchema, setErrorCauseSchema } from './dto/learning-schemas.js';
import { statusForKind, toProblemDetails, validationProblem } from './problem-details.js';

export const LEARNING_HANDLERS = Symbol('LEARNING_HANDLERS');
export const LEARNING_PRINCIPAL_RESOLVER = Symbol('LEARNING_PRINCIPAL_RESOLVER');

export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

type ParseOutcome =
  | { success: true; data: unknown }
  | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };

interface Routed {
  readonly name: string;
  handle(input: unknown, context: ApplicationContext): Promise<{ ok: true; value: unknown } | { ok: false; error: ApplicationError }>;
}

/**
 * HTTP for the learner's own Learning surface (M7-52, M7-53): **a learner reads their report, their pace, their review plan and what to practise next, and keeps their own error notebook and bookmarks.**
 *
 * Every route is the learner's own. The learner is the authenticated principal and is never a parameter, a body field or a query, so the handlers
 * read the caller's rows and no route can name another's. An attempt that is not the caller's is answered exactly as one that does not exist, a
 * `404` and never a `403`, because a refusal would confirm that the attempt is there.
 *
 * Controllers translate and delegate: parse, authenticate, resolve the handler, map the typed result onto a status. No business rule lives here, and
 * no authorization decision either — those are at the handler. `GenerateDiagnosticReport`, `RecordMasteryEvidence` and `PublishMasteryRuleSet` are not
 * reachable from here; `learning-contract.spec.ts` names each with the reason.
 */
@Controller()
export class LearningController {
  private readonly handlers: ReadonlyMap<string, Routed>;

  constructor(
    @Inject(LEARNING_HANDLERS) offered: LearningForLearner,
    @Inject(LEARNING_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {
    this.handlers = new Map((Object.values(offered) as unknown as Routed[]).map((handler) => [handler.name, handler]));
  }

  @Get('/v1/learning/attempts/:attemptId/report')
  async getDiagnosticReport(@Param('attemptId') attemptId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetDiagnosticReport', () => this.parse(attemptIdSchema, { attemptId }));
  }

  @Get('/v1/learning/attempts/:attemptId/pace')
  async getPaceAnalytics(@Param('attemptId') attemptId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetPaceAnalytics', () => this.parse(attemptIdSchema, { attemptId }));
  }

  @Get('/v1/learning/review-plan')
  async getReviewPlan(@Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetReviewPlan', () => ({ success: true, data: {} }));
  }

  @Get('/v1/learning/remediation-concepts')
  async suggestRemediationConcepts(@Query() query: Record<string, unknown>, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'SuggestRemediationConcepts', () => this.parse(remediationConceptsSchema, query));
  }

  @Get('/v1/learning/error-entries')
  async listErrorEntries(@Query() query: Record<string, unknown>, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'ListErrorEntries', () => this.parse(errorEntriesSchema, query));
  }

  @Put('/v1/learning/error-entries/:errorEntryId/cause')
  async setErrorCause(@Param('errorEntryId') errorEntryId: string, @Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'SetErrorCause', () => this.parse(setErrorCauseSchema, { ...this.object(body), errorEntryId }));
  }

  @Get('/v1/learning/bookmarks')
  async listBookmarks(@Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'ListBookmarks', () => ({ success: true, data: {} }));
  }

  @Post('/v1/learning/bookmarks')
  async createBookmark(@Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'CreateBookmark', () => this.parse(createBookmarkSchema, this.object(body)), 201);
  }

  private object(body: unknown): Record<string, unknown> {
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }

  private parse(schema: ZodType, value: unknown): ParseOutcome {
    const parsed = schema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: { issues: parsed.error.issues } };
  }

  private async run(response: Response, headers: Record<string, string>, handlerName: string, build: () => ParseOutcome, successStatus = 200): Promise<void> {
    // Echoed on every response, error or not (§8).
    const correlationId = headers['x-correlation-id'] ?? randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    // Nothing here is for a cache to keep: it is one learner's standing, and a stale copy of it is a wrong answer.
    response.setHeader('Cache-Control', 'no-store');

    const principal = this.principals.resolve(headers);
    if (principal === null) {
      this.fail(response, { kind: 'Authentication', code: 'Authentication', message: 'Authentication is required.' }, correlationId);
      return;
    }

    const parsed = build();
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`).join('; ');
      response.status(400).type('application/problem+json').json(validationProblem(detail, correlationId));
      return;
    }

    const handler = this.handlers.get(handlerName);
    if (handler === undefined) {
      this.fail(response, { kind: 'Unavailable', code: 'Unavailable', message: 'The operation is not available.' }, correlationId);
      return;
    }

    const result = await handler.handle(parsed.data, { principal, correlationId, stepUpSatisfied: headers['x-step-up'] === 'satisfied' });
    if (!result.ok) {
      this.fail(response, result.error, correlationId);
      return;
    }
    response.status(successStatus).json(result.value);
  }

  private fail(response: Response, error: ApplicationError, correlationId: string): void {
    response.status(statusForKind(error.kind)).type('application/problem+json').json(toProblemDetails(error, correlationId));
  }
}
