import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ZodType } from 'zod';
import type { Result } from '../domain/result.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import type { Handler, HandlerRegistry } from '../application/handler-registry.js';
import { statusForKind, toProblemDetails, validationProblem } from './problem-details.js';
import {
  addConceptNodeSchema,
  addMappingSchema,
  addPrerequisiteEdgeSchema,
  conceptSubtreeQuerySchema,
  createExamSchema,
  createMigrationSchema,
  createProfileDraftSchema,
  createTaxonomyDraftSchema,
  executeMigrationSchema,
  listQuerySchema,
  moveConceptNodeSchema,
  profileDraftContentSchema,
  publishProfileVersionSchema,
} from './dto/curriculum-schemas.js';

export const CURRICULUM_REGISTRY = Symbol('CURRICULUM_REGISTRY');
export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');

/**
 * Turns an authenticated request into a `PrincipalRef`. Token verification is
 * the Identity context's job; the curriculum context only consumes the result.
 */
export interface PrincipalResolver {
  resolve(headers: Record<string, string | string[] | undefined>): ApplicationContext['principal'] | null;
}

interface RequestEnvelope {
  readonly context: ApplicationContext;
  readonly correlationId: string;
}

/**
 * HTTP for the curriculum context. Controllers translate and delegate: they
 * parse, authenticate, resolve the handler, and map the typed result onto a
 * status code. No business rule lives here.
 */
@Controller()
export class CurriculumController {
  constructor(
    @Inject(CURRICULUM_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  // ── Taxonomy ──────────────────────────────────────────────────────────────

  @Post('/v1/taxonomy-versions')
  async createTaxonomyDraft(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'CreateTaxonomyDraft', 201, () =>
      this.parse(createTaxonomyDraftSchema, body),
    );
  }

  @Get('/v1/taxonomy-versions')
  async listTaxonomyVersions(
    @Query() query: Record<string, string>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ListTaxonomyVersions', 200, () => {
      const page = listQuerySchema.safeParse(query);
      if (!page.success) return page;
      return { success: true as const, data: { examFamily: query['examFamily'] ?? '' } };
    });
  }

  @Get('/v1/taxonomy-versions/:taxonomyVersionId')
  async getTaxonomyVersion(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetTaxonomyVersion', 200, () => ({
      success: true as const,
      data: { taxonomyVersionId },
    }));
  }

  @Post('/v1/taxonomy-versions/:taxonomyVersionId/concept-nodes')
  async addConceptNode(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'AddConceptNode', 201, (expectedAggregateVersion) => {
      const parsed = this.parse(addConceptNodeSchema, body);
      return parsed.success
        ? { success: true as const, data: { ...parsed.data, taxonomyVersionId, expectedAggregateVersion } }
        : parsed;
    });
  }

  @Patch('/v1/taxonomy-versions/:taxonomyVersionId/concept-nodes/:conceptNodeId')
  async moveConceptNode(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Param('conceptNodeId') conceptNodeId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'MoveConceptNode', 200, (expectedAggregateVersion) => {
      const parsed = this.parse(moveConceptNodeSchema, body);
      return parsed.success
        ? {
            success: true as const,
            data: { taxonomyVersionId, conceptNodeId, ...parsed.data, expectedAggregateVersion },
          }
        : parsed;
    });
  }

  @Delete('/v1/taxonomy-versions/:taxonomyVersionId/concept-nodes/:conceptNodeId')
  async removeConceptNode(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Param('conceptNodeId') conceptNodeId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'RemoveConceptNode', 200, (expectedAggregateVersion) => ({
      success: true as const,
      data: { taxonomyVersionId, conceptNodeId, expectedAggregateVersion },
    }));
  }

  @Post('/v1/taxonomy-versions/:taxonomyVersionId/prerequisite-edges')
  async addPrerequisiteEdge(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'AddPrerequisiteEdge', 201, (expectedAggregateVersion) => {
      const parsed = this.parse(addPrerequisiteEdgeSchema, body);
      return parsed.success
        ? { success: true as const, data: { taxonomyVersionId, ...parsed.data, expectedAggregateVersion } }
        : parsed;
    });
  }

  @Post('/v1/taxonomy-versions/:taxonomyVersionId/publication')
  async publishTaxonomyVersion(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const idempotency = this.requireIdempotencyKey(headers, response);
    if (!idempotency) return;

    await this.runVersioned(response, headers, 'PublishTaxonomyVersion', 200, (expectedAggregateVersion) => ({
      success: true as const,
      data: { taxonomyVersionId, expectedAggregateVersion },
    }));
  }

  @Get('/v1/taxonomy-versions/:taxonomyVersionId/concept-subtree')
  async getConceptSubtree(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Query() query: Record<string, string>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetConceptSubtree', 200, () => {
      const parsed = this.parse(conceptSubtreeQuerySchema, query);
      return parsed.success
        ? { success: true as const, data: { taxonomyVersionId, ...parsed.data } }
        : parsed;
    });
  }

  @Get('/v1/taxonomy-versions/:taxonomyVersionId/concepts/:conceptIdentityId/prerequisites')
  async getConceptPrerequisites(
    @Param('taxonomyVersionId') taxonomyVersionId: string,
    @Param('conceptIdentityId') conceptIdentityId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetConceptPrerequisites', 200, () => ({
      success: true as const,
      data: { taxonomyVersionId, conceptIdentityId },
    }));
  }

  // ── Exams and profiles ────────────────────────────────────────────────────

  @Post('/v1/exams')
  async createExam(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'CreateExam', 201, () => this.parse(createExamSchema, body));
  }

  @Get('/v1/exams')
  async listExams(
    @Query() query: Record<string, string>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'ListExams', 200, () => {
      const parsed = listQuerySchema.safeParse(query);
      return parsed.success ? { success: true as const, data: { limit: parsed.data.limit } } : parsed;
    });
  }

  @Post('/v1/exam-profile-versions')
  async createProfileDraft(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'CreateProfileDraft', 201, () =>
      this.parse(createProfileDraftSchema, body),
    );
  }

  @Get('/v1/exam-profile-versions/:profileVersionId')
  async getExamProfileVersion(
    @Param('profileVersionId') profileVersionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetExamProfileVersion', 200, () => ({
      success: true as const,
      data: { profileVersionId },
    }));
  }

  @Put('/v1/exam-profile-versions/:profileVersionId')
  async updateProfileDraft(
    @Param('profileVersionId') profileVersionId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'UpdateProfileDraft', 200, (expectedAggregateVersion) => {
      const parsed = this.parse(profileDraftContentSchema, body);
      return parsed.success
        ? { success: true as const, data: { profileVersionId, ...parsed.data, expectedAggregateVersion } }
        : parsed;
    });
  }

  @Post('/v1/exam-profile-versions/:profileVersionId/publication')
  async publishProfileVersion(
    @Param('profileVersionId') profileVersionId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const idempotency = this.requireIdempotencyKey(headers, response);
    if (!idempotency) return;

    await this.runVersioned(response, headers, 'PublishProfileVersion', 200, (expectedAggregateVersion) => {
      const parsed = this.parse(publishProfileVersionSchema, body ?? {});
      return parsed.success
        ? { success: true as const, data: { profileVersionId, ...parsed.data, expectedAggregateVersion } }
        : parsed;
    });
  }

  @Post('/v1/exam-profile-versions/:profileVersionId/supersession')
  async supersedeProfileVersion(
    @Param('profileVersionId') profileVersionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const idempotency = this.requireIdempotencyKey(headers, response);
    if (!idempotency) return;

    await this.runVersioned(response, headers, 'SupersedeProfileVersion', 200, (expectedAggregateVersion) => ({
      success: true as const,
      data: { profileVersionId, expectedAggregateVersion },
    }));
  }

  // ── Migrations ────────────────────────────────────────────────────────────

  @Post('/v1/taxonomy-migrations')
  async createMigration(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'CreateMigration', 201, () => this.parse(createMigrationSchema, body));
  }

  @Post('/v1/taxonomy-migrations/:migrationId/mappings')
  async addMapping(
    @Param('migrationId') migrationId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'AddMapping', 201, (expectedAggregateVersion) => {
      const parsed = this.parse(addMappingSchema, body);
      return parsed.success
        ? { success: true as const, data: { migrationId, ...parsed.data, expectedAggregateVersion } }
        : parsed;
    });
  }

  @Post('/v1/taxonomy-migrations/:migrationId/dry-run')
  async runDryRun(
    @Param('migrationId') migrationId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.runVersioned(response, headers, 'RunDryRun', 200, (expectedAggregateVersion) => ({
      success: true as const,
      data: { migrationId, expectedAggregateVersion },
    }));
  }

  @Get('/v1/taxonomy-migrations/:migrationId/dry-run')
  async getMigrationDryRun(
    @Param('migrationId') migrationId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    await this.run(response, headers, 'GetMigrationDryRun', 200, () => ({
      success: true as const,
      data: { migrationId },
    }));
  }

  @Post('/v1/taxonomy-migrations/:migrationId/execution')
  async executeMigration(
    @Param('migrationId') migrationId: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ): Promise<void> {
    const idempotency = this.requireIdempotencyKey(headers, response);
    if (!idempotency) return;

    await this.runVersioned(response, headers, 'ExecuteMigration', 200, (expectedAggregateVersion) => {
      const parsed = this.parse(executeMigrationSchema, body ?? {});
      return parsed.success
        ? { success: true as const, data: { migrationId, ...parsed.data, expectedAggregateVersion } }
        : parsed;
    });
  }

  // ── Translation plumbing ──────────────────────────────────────────────────

  private parse<T>(
    schema: ZodType<T>,
    body: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } } {
    const parsed = schema.safeParse(body);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: parsed.error };
  }

  private envelope(headers: Record<string, string>, response: Response): RequestEnvelope | null {
    const correlationId = headers['x-correlation-id'] ?? randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);

    const principal = this.principals.resolve(headers);
    if (principal === null) {
      response
        .status(401)
        .type('application/problem+json')
        .json(
          toProblemDetails(
            { kind: 'Authentication', code: 'Authentication', message: 'Authentication is required.' },
            correlationId,
          ),
        );
      return null;
    }

    return {
      correlationId,
      context: {
        principal,
        correlationId,
        stepUpSatisfied: headers['x-step-up'] === 'satisfied',
      },
    };
  }

  private requireIdempotencyKey(headers: Record<string, string>, response: Response): boolean {
    const key = headers['idempotency-key'];
    if (key !== undefined && key.length >= 8) return true;

    const correlationId = headers['x-correlation-id'] ?? randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    response
      .status(400)
      .type('application/problem+json')
      .json(
        validationProblem(
          [{ field: 'Idempotency-Key', message: 'An Idempotency-Key header of at least 8 characters is required.' }],
          correlationId,
        ),
      );
    return false;
  }

  private async run(
    response: Response,
    headers: Record<string, string>,
    handlerName: string,
    successStatus: number,
    build: () => { success: true; data: unknown } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } },
  ): Promise<void> {
    const envelope = this.envelope(headers, response);
    if (envelope === null) return;

    const input = build();
    if (!input.success) {
      response
        .status(400)
        .type('application/problem+json')
        .json(
          validationProblem(
            input.error.issues.map((issue) => ({
              field: issue.path.map(String).join('.') || '(body)',
              message: issue.message,
            })),
            envelope.correlationId,
          ),
        );
      return;
    }

    const handler = this.registry.get(handlerName) as Handler<unknown, unknown> | undefined;
    if (handler === undefined) {
      response
        .status(500)
        .type('application/problem+json')
        .json(
          toProblemDetails(
            { kind: 'Unavailable', code: 'Unavailable', message: 'The operation is not available.' },
            envelope.correlationId,
          ),
        );
      return;
    }

    const outcome = (await handler.handle(input.data, envelope.context)) as Result<
      unknown,
      ApplicationError
    >;

    if (!outcome.ok) {
      response
        .status(statusForKind(outcome.error.kind))
        .type('application/problem+json')
        .json(toProblemDetails(outcome.error, envelope.correlationId));
      return;
    }

    const value = outcome.value as { aggregateVersion?: number } | null;
    if (value !== null && typeof value === 'object' && typeof value.aggregateVersion === 'number') {
      response.setHeader('ETag', `"${value.aggregateVersion}"`);
    }
    response.status(successStatus).json(outcome.value ?? null);
  }

  /** Adds `If-Match` → `expectedAggregateVersion` to the translation. */
  private async runVersioned(
    response: Response,
    headers: Record<string, string>,
    handlerName: string,
    successStatus: number,
    build: (
      expectedAggregateVersion: number,
    ) => { success: true; data: unknown } | { success: false; error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } },
  ): Promise<void> {
    const ifMatch = headers['if-match'];
    const expected = Number(ifMatch?.replaceAll('"', ''));

    if (ifMatch === undefined || !Number.isInteger(expected) || expected < 1) {
      const correlationId = headers['x-correlation-id'] ?? randomUUID();
      response.setHeader('X-Correlation-Id', correlationId);
      response
        .status(428)
        .type('application/problem+json')
        .json({
          type: 'https://questionbank.example/problems/preconditionfailed',
          title: 'Precondition required',
          status: 428,
          detail: 'An If-Match header carrying the aggregate version is required.',
          code: 'PreconditionFailed' as const,
          retryable: false,
          correlationId,
        });
      return;
    }

    await this.run(response, headers, handlerName, successStatus, () => build(expected));
  }
}
