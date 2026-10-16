import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import type { Handler, HandlerRegistry } from '../application/handler-registry.js';
import { statusForKind, toProblemDetails, validationProblem } from './problem-details.js';
import { candidateIdSchema, runIdSchema, startGenerationRunSchema } from './dto/generation-schemas.js';

export const GENERATION_REGISTRY = Symbol('GENERATION_REGISTRY');
export const GENERATION_PRINCIPAL_RESOLVER = Symbol('GENERATION_PRINCIPAL_RESOLVER');

export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

type ParseOutcome =
  | { success: true; data: unknown }
  | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };

/**
 * HTTP for the generation context: **an operator starts a run and reads what it
 * produced, and that is all** (M5-38).
 *
 * Three routes, each an operator's act. Everything else the context does is not
 * reachable from here, and each absence is a decision:
 *
 *   - `ProposeCandidate` and `RunPrecheckBattery` call a model. A request path
 *     that reached one would put live inference behind an HTTP call (F33), where
 *     a slow or failing provider becomes a slow or failing request. They are the
 *     pipeline's work, run off any request path, as `SweepReviewAgeing` is a
 *     scheduler's and has no route (DEC-M4-15).
 *   - `RecordPrecheckVerdict` is the battery's own write; the verdicts are the
 *     audit trail a human decision rests on, and a route to write them would be a
 *     route to write the result one wanted.
 *   - `AcceptCandidate` and `RejectCandidate` are the human's decision and are
 *     not on this surface yet; see the Track G report.
 *
 * **These routes are authoring-family routes** (ADR-0009, ADR-0028): a candidate
 * carries a proposed item, and a proposed item carries its answer key. No route
 * here is student-facing and no learner role is admitted by any handler's policy.
 *
 * Controllers translate and delegate: parse, authenticate, resolve the handler,
 * map the typed result onto a status. No business rule lives here, and no
 * authorization decision either — those are at the handler.
 */
@Controller()
export class GenerationController {
  constructor(
    @Inject(GENERATION_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(GENERATION_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  @Post('/v1/authoring/generation-runs')
  async startGenerationRun(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'StartGenerationRun', 201, () => this.parse(startGenerationRunSchema, body));
  }

  @Get('/v1/authoring/generation-runs/:runId/candidates')
  async listRunCandidates(
    @Param('runId') runId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ListRunCandidates', 200, () => this.parse(runIdSchema, { runId }));
  }

  @Get('/v1/authoring/generation-candidates/:candidateId')
  async getCandidate(
    @Param('candidateId') candidateId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetCandidate', 200, () => this.parse(candidateIdSchema, { candidateId }));
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

    const result = await handler.handle(parsed.data, { principal, correlationId });
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
