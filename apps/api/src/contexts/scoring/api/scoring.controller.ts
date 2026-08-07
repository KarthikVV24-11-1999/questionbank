import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import type { Handler, HandlerRegistry } from '../application/handler-registry.js';
import { statusForKind, toProblemDetails, validationProblem } from './problem-details.js';
import { attemptIdSchema, draftRescoringSchema, operationIdSchema, scoreAttemptSchema } from './dto/scoring-schemas.js';

export const SCORING_REGISTRY = Symbol('SCORING_REGISTRY');
export const SCORING_PRINCIPAL_RESOLVER = Symbol('SCORING_PRINCIPAL_RESOLVER');

export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

type ParseOutcome =
  | { success: true; data: unknown }
  | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };

/**
 * HTTP for the scoring context. Controllers translate and delegate: parse,
 * authenticate, resolve the handler, map the typed result onto a status. No
 * business rule lives here, and no authorization decision either — those are
 * at the handler, where a background worker also passes.
 */
@Controller()
export class ScoringController {
  constructor(
    @Inject(SCORING_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(SCORING_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  @Post('/v1/score-records')
  async scoreAttempt(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ScoreAttempt', 201, () => this.parse(scoreAttemptSchema, body));
  }

  @Get('/v1/attempts/:attemptId/score-records/current')
  async getScoreRecord(
    @Param('attemptId') attemptId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetScoreRecord', 200, () => this.parse(attemptIdSchema, { attemptId }));
  }

  @Get('/v1/attempts/:attemptId/score-records')
  async listScoreRecordGenerations(
    @Param('attemptId') attemptId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ListScoreRecordGenerations', 200, () =>
      this.parse(attemptIdSchema, { attemptId }),
    );
  }

  @Post('/v1/rescoring-operations')
  async draftRescoring(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'DraftRescoring', 201, () => this.parse(draftRescoringSchema, body));
  }

  @Post('/v1/rescoring-operations/:operationId/dry-run')
  async runRescoringDryRun(
    @Param('operationId') operationId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'RunRescoringDryRun', 200, () =>
      this.parse(operationIdSchema, { operationId }),
    );
  }

  @Get('/v1/rescoring-operations/:operationId/dry-run')
  async getRescoringDryRun(
    @Param('operationId') operationId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetRescoringDryRun', 200, () =>
      this.parse(operationIdSchema, { operationId }),
    );
  }

  @Post('/v1/rescoring-operations/:operationId/approval')
  async approveRescoring(
    @Param('operationId') operationId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ApproveRescoring', 200, () =>
      this.parse(operationIdSchema, { operationId }),
    );
  }

  @Post('/v1/rescoring-operations/:operationId/execution')
  async executeRescoring(
    @Param('operationId') operationId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ExecuteRescoring', 200, () =>
      this.parse(operationIdSchema, { operationId }),
    );
  }

  private parse(schema: ZodType, value: unknown): ParseOutcome {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false, error: { issues: parsed.error.issues } };
  }

  private async run(
    response: Response,
    headers: Record<string, string>,
    handlerName: string,
    successStatus: number,
    build: () => ParseOutcome,
  ): Promise<void> {
    // Echoed on every response, error or not (§8).
    const correlationId = headers['x-correlation-id'] ?? randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);

    const principal = this.principals.resolve(headers);
    if (principal === null) {
      this.fail(response, { kind: 'Authentication', code: 'Authentication', message: 'Authentication is required.' }, correlationId);
      return;
    }

    const parsed = build();
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; ');
      response.status(400).type('application/problem+json').json(validationProblem(detail, correlationId));
      return;
    }

    const handler = this.registry.get(handlerName) as Handler<unknown, unknown> | undefined;
    if (handler === undefined) {
      this.fail(response, { kind: 'Unavailable', code: 'Unavailable', message: 'The operation is not available.' }, correlationId);
      return;
    }

    const context: ApplicationContext = {
      principal,
      correlationId,
      stepUpSatisfied: headers['x-step-up'] === 'satisfied',
    };

    const result = await handler.handle(parsed.data, context);
    if (!result.ok) {
      this.fail(response, result.error, correlationId);
      return;
    }

    response.status(successStatus).json(result.value);
  }

  private fail(response: Response, error: ApplicationError, correlationId: string): void {
    response
      .status(statusForKind(error.kind))
      .type('application/problem+json')
      .json(toProblemDetails(error, correlationId));
  }
}
