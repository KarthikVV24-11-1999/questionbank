import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import type { ApplicationError } from '../application/authorization.js';
import type { Handler, HandlerRegistry } from '../application/handler-registry.js';
import type { ApplicationContext } from '../application/ports.js';
import { assembleDraftFormSchema, attemptIdSchema, createAttemptSchema, formIdSchema, ingestEventsSchema, scheduleFormSchema, submitAttemptSchema } from './dto/assessment-schemas.js';
import { statusForKind, toProblemDetails, validationProblem } from './problem-details.js';

/** What a package is served as: its own type, so nothing mistakes it for an API response. */
export const PACKAGE_MEDIA_TYPE = 'application/vnd.questionbank.form-package+json';

export const ASSESSMENT_REGISTRY = Symbol('ASSESSMENT_REGISTRY');
export const ASSESSMENT_PRINCIPAL_RESOLVER = Symbol('ASSESSMENT_PRINCIPAL_RESOLVER');

export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

type ParseOutcome =
  | { success: true; data: unknown }
  | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } };

/**
 * HTTP for the assessment context: **an operator assembles a draft form, reads it,
 * publishes it and schedules it** (M6-23).
 *
 * Four operator routes, each an operator's act, and two student-facing ones (below). `SweepWindows` is not reachable from here:
 * applying the clock to stored state is what a scheduler will call, and a command
 * only a scheduler would call has no route (D36, DEC-M4-15's precedent).
 *
 * **These are not authoring-family routes** (ADR-0009, ADR-0033). A form pins item
 * versions by id and holds no content, so no response here carries a stem, an
 * option, a key or a solution; the contract spec serializes real responses and
 * scans them for key material. The two package routes (M6-26) are the student-facing
 * ones: the signed bytes of an active form, and the public key that verifies them.
 *
 * Controllers translate and delegate: parse, authenticate, resolve the handler,
 * map the typed result onto a status. No business rule lives here, and no
 * authorization decision either — those are at the handler.
 */
@Controller()
export class AssessmentController {
  constructor(
    @Inject(ASSESSMENT_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(ASSESSMENT_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  @Post('/v1/assessment/forms')
  async assembleDraftForm(@Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'AssembleDraftForm', 201, () => this.parse(assembleDraftFormSchema, body));
  }

  @Get('/v1/assessment/forms/:formId')
  async getForm(@Param('formId') formId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetForm', 200, () => this.parse(formIdSchema, { formId }));
  }

  @Post('/v1/assessment/forms/:formId/publication')
  async publishForm(@Param('formId') formId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'PublishForm', 200, () => this.parse(formIdSchema, { formId }));
  }

  @Post('/v1/assessment/forms/:formId/schedule')
  async scheduleForm(
    @Param('formId') formId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ScheduleForm', 200, () =>
      this.parse(scheduleFormSchema, { ...this.object(body), formId }),
    );
  }

  /**
   * The package is the bytes themselves, not a JSON rendering of them: the
   * signature covers exactly what is sent, so the body is written untouched and
   * the digest, signature and key id travel in headers. The digest doubles as
   * the ETag, which is sound because the package is byte-identical for a form.
   * The API serves these bytes only until a CDN exists (D58).
   */
  @Get('/v1/assessment/forms/:formId/package')
  async getFormPackage(@Param('formId') formId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetFormPackage', 200, () => this.parse(formIdSchema, { formId }), (value) => this.sendPackage(response, value));
  }

  @Post('/v1/assessment/attempts')
  async createAttempt(@Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'CreateAttempt', 201, () => this.parse(createAttemptSchema, { ...this.object(body), idempotencyKey: headers['idempotency-key'] }), undefined, (value) =>
      (value as { replayed: boolean }).replayed ? 200 : 201,
    );
  }

  @Get('/v1/assessment/attempts/:attemptId')
  async getAttempt(@Param('attemptId') attemptId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetAttempt', 200, () => this.parse(attemptIdSchema, { attemptId }));
  }

  @Get('/v1/assessment/attempts/:attemptId/result')
  async getAttemptResult(@Param('attemptId') attemptId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetAttemptResult', 200, () => this.parse(attemptIdSchema, { attemptId }));
  }

  @Post('/v1/assessment/attempts/:attemptId/start')
  async startAttempt(@Param('attemptId') attemptId: string, @Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'StartAttempt', 200, () => this.parse(attemptIdSchema, { attemptId }));
  }

  @Post('/v1/assessment/attempts/:attemptId/events')
  async ingestEvents(
    @Param('attemptId') attemptId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'IngestResponseEvents', 200, () => this.parse(ingestEventsSchema, { ...this.object(body), attemptId }));
  }

  @Post('/v1/assessment/attempts/:attemptId/submission')
  async submitAttempt(
    @Param('attemptId') attemptId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'SubmitAttempt', 200, () => this.parse(submitAttemptSchema, { ...this.object(body), attemptId, idempotencyKey: headers['idempotency-key'] }));
  }

  @Get('/v1/assessment/package-signing-key')
  async getPackageSigningKey(@Headers() headers: Record<string, string>, @Res() response: Response): Promise<void> {
    await this.run(response, headers, 'GetPackageSigningKey', 200, () => ({ success: true, data: {} }));
  }

  private object(body: unknown): Record<string, unknown> {
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  }

  private sendPackage(response: Response, value: unknown): void {
    const built = value as { bytes: Uint8Array; digest: string; signature: string; keyId: string };
    response
      .status(200)
      .setHeader('Content-Type', PACKAGE_MEDIA_TYPE)
      .setHeader('X-Package-Digest', `sha256=${built.digest}`)
      .setHeader('X-Package-Signature', built.signature)
      .setHeader('X-Package-Key-Id', built.keyId)
      .setHeader('ETag', `"${built.digest}"`)
      // Private to this user and revalidated every time (the ETag is the digest): a copy may be kept, never reused unchecked.
      .setHeader('Cache-Control', 'private, no-cache')
      .send(Buffer.from(built.bytes));
  }

  private parse(schema: ZodType, value: unknown): ParseOutcome {
    const parsed = schema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: { issues: parsed.error.issues } };
  }

  private async run(
    response: Response,
    headers: Record<string, string>,
    handlerName: string,
    successStatus: number,
    build: () => ParseOutcome,
    respond?: (value: unknown) => void,
    statusFor?: (value: unknown) => number,
  ): Promise<void> {
    // Echoed on every response, error or not (§8).
    const correlationId = headers['x-correlation-id'] ?? randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    // Nothing here is for a cache to keep: not a student's attempt, their events, their result. The package route below says its own, and
    // the learner app's service worker never answers the attempt routes at all (M6-51); this is the same promise made to every other cache.
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

    const handler = this.registry.get(handlerName) as Handler<unknown, unknown> | undefined;
    if (handler === undefined) {
      this.fail(response, { kind: 'Unavailable', code: 'Unavailable', message: 'The operation is not available.' }, correlationId);
      return;
    }

    const result = await handler.handle(parsed.data, {
      principal,
      correlationId,
      stepUpSatisfied: headers['x-step-up'] === 'satisfied',
    });
    if (!result.ok) {
      this.fail(response, result.error, correlationId);
      return;
    }

    if (respond !== undefined) {
      respond(result.value);
      return;
    }
    response.status(statusFor === undefined ? successStatus : statusFor(result.value)).json(result.value);
  }

  private fail(response: Response, error: ApplicationError, correlationId: string): void {
    response.status(statusForKind(error.kind)).type('application/problem+json').json(toProblemDetails(error, correlationId));
  }
}
