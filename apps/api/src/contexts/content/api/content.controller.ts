import { Controller, Get, Headers, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HandlerRegistry } from '../application/handler-registry.js';
import {
  CONTENT_PRINCIPAL_RESOLVER,
  CONTENT_REGISTRY,
  runOperation,
  type PrincipalResolver,
} from './http-runner.js';
import {
  publishedItemSchema,
  publishedSolutionSchema,
  publishedStimulusSchema,
} from './dto/delivery-schemas.js';

/**
 * The delivery HTTP surface — what a student's client reads.
 *
 * **This controller imports no `Authoring*` shape, and the import graph is
 * what says so** (ADR-0009 condition 3, asserted at M3-44). It reads
 * `delivery-schemas.ts`, which reaches nothing from the authoring family.
 *
 * Every response here is built by a delivery view constructor that names its
 * fields one at a time, so no key can arrive by spread.
 */
@Controller()
export class ContentController {
  constructor(
    @Inject(CONTENT_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(CONTENT_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  private get deps() {
    return { registry: this.registry, principals: this.principals };
  }

  @Get('/v1/items/:itemId')
  async getPublishedItem(
    @Param('itemId') itemId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetPublishedItem', 200, publishedItemSchema, { itemId });
  }

  @Get('/v1/stimuli/:stimulusId')
  async getPublishedStimulus(
    @Param('stimulusId') stimulusId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetPublishedStimulus', 200, publishedStimulusSchema, {
      stimulusId,
    });
  }

  @Get('/v1/solutions/:itemVersionId')
  async getPublishedSolution(
    @Param('itemVersionId') itemVersionId: string,
    @Query('depth') depth: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetPublishedSolution', 200, publishedSolutionSchema, {
      itemVersionId,
      depth,
    });
  }
}
