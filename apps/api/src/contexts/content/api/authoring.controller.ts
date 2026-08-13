import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { HandlerRegistry } from '../application/handler-registry.js';
import {
  CONTENT_PRINCIPAL_RESOLVER,
  CONTENT_REGISTRY,
  runOperation,
  type PrincipalResolver,
} from './http-runner.js';
import {
  addMediaVersionSchema,
  assetIdSchema,
  attachStimulusSchema,
  authorIdSchema,
  createItemDraftSchema,
  createSolutionSchema,
  createStimulusSchema,
  deleteItemDraftSchema,
  deriveDraftSchema,
  importBatchSchema,
  itemIdSchema,
  itemVersionSchema,
  listMediaAssetsSchema,
  publishItemVersionSchema,
  publishMediaSchema,
  publishSolutionSchema,
  publishStimulusSchema,
  recordItemDecisionSchema,
  recordMediaDecisionSchema,
  recordSolutionDecisionSchema,
  recordStimulusDecisionSchema,
  registerMediaSchema,
  retireItemSchema,
  retireMediaSchema,
  retireStimulusSchema,
  solutionIdSchema,
  stimulusIdSchema,
  suspendItemSchema,
  updateItemDraftSchema,
  updateSolutionSchema,
  updateStimulusSchema,
} from './dto/authoring-schemas.js';

/**
 * The authoring HTTP surface — `/v1/authoring/**` and nothing else.
 *
 * **This is the one controller that carries the answer key** (ADR-0009). Every
 * route here is on the enumerated `x-authoring-routes` list in
 * `openapi/content.yaml`, and the contract spec asserts the list against the
 * document in both directions.
 *
 * Controllers translate and delegate: parse, authenticate, resolve the
 * handler, map the typed result onto a status. No business rule lives here and
 * no authorization decision either.
 */
@Controller()
export class AuthoringController {
  constructor(
    @Inject(CONTENT_REGISTRY) private readonly registry: HandlerRegistry,
    @Inject(CONTENT_PRINCIPAL_RESOLVER) private readonly principals: PrincipalResolver,
  ) {}

  private get deps() {
    return { registry: this.registry, principals: this.principals };
  }

  // ── Items ────────────────────────────────────────────────────────────────

  @Post('/v1/authoring/items')
  async createItemDraft(@Body() body: unknown, @Headers() headers: Record<string, string>, @Res() response: Response) {
    await runOperation(this.deps, response, headers, 'CreateItemDraft', 201, createItemDraftSchema, body);
  }

  @Get('/v1/authoring/items/:itemId')
  async getItemDraft(
    @Param('itemId') itemId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetItemDraft', 200, itemIdSchema, { itemId });
  }

  @Patch('/v1/authoring/items/:itemId')
  async updateItemDraft(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'UpdateItemDraft', 200, updateItemDraftSchema, {
      ...body,
      itemId,
    });
  }

  @Delete('/v1/authoring/items/:itemId')
  async deleteItemDraft(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'DeleteItemDraft', 204, deleteItemDraftSchema, {
      ...body,
      itemId,
    });
  }

  @Post('/v1/authoring/items/:itemId/versions')
  async deriveDraftFromVersion(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'DeriveDraftFromVersion', 201, deriveDraftSchema, {
      ...body,
      itemId,
    });
  }

  @Get('/v1/authoring/items/:itemId/versions/:itemVersionId')
  async getItemVersionForAuthoring(
    @Param('itemId') itemId: string,
    @Param('itemVersionId') itemVersionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetItemVersionForAuthoring', 200, itemVersionSchema, {
      itemId,
      itemVersionId,
    });
  }

  @Get('/v1/authoring/items/:itemId/validation-findings')
  async getValidationFindings(
    @Param('itemId') itemId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'GetValidationFindings', 200, itemIdSchema, { itemId });
  }

  @Post('/v1/authoring/items/:itemId/stimulus')
  async attachStimulusToItem(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'AttachStimulusToItem', 200, attachStimulusSchema, {
      ...body,
      itemId,
    });
  }

  @Get('/v1/authoring/drafts')
  async listMyDrafts(
    @Query('authorId') authorId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'ListMyDrafts', 200, authorIdSchema, { authorId });
  }

  // ── Item lifecycle ───────────────────────────────────────────────────────

  @Post('/v1/authoring/items/:itemId/review-submission')
  async submitItemForReview(
    @Param('itemId') itemId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'SubmitItemForReview', 200, itemIdSchema, { itemId });
  }

  @Delete('/v1/authoring/items/:itemId/review-submission')
  async withdrawItemFromReview(
    @Param('itemId') itemId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'WithdrawItemFromReview', 200, itemIdSchema, { itemId });
  }

  @Post('/v1/authoring/items/:itemId/review-decisions')
  async recordItemReviewDecision(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'RecordItemReviewDecision', 200, recordItemDecisionSchema, {
      ...body,
      itemId,
    });
  }

  @Post('/v1/authoring/items/:itemId/publication')
  async publishItemVersion(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'PublishItemVersion', 200, publishItemVersionSchema, {
      ...body,
      itemId,
    });
  }

  @Post('/v1/authoring/items/:itemId/suspension')
  async suspendItem(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'SuspendItem', 200, suspendItemSchema, { ...body, itemId });
  }

  @Post('/v1/authoring/items/:itemId/retirement')
  async retireItem(
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'RetireItem', 200, retireItemSchema, { ...body, itemId });
  }

  // ── Stimuli ──────────────────────────────────────────────────────────────

  @Post('/v1/authoring/stimuli')
  async createStimulusDraft(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'CreateStimulusDraft', 201, createStimulusSchema, body);
  }

  @Patch('/v1/authoring/stimuli/:stimulusId')
  async updateStimulusDraft(
    @Param('stimulusId') stimulusId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'UpdateStimulusDraft', 200, updateStimulusSchema, {
      ...body,
      stimulusId,
    });
  }

  @Post('/v1/authoring/stimuli/:stimulusId/review-submission')
  async submitStimulusForReview(
    @Param('stimulusId') stimulusId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'SubmitStimulusForReview', 200, stimulusIdSchema, {
      stimulusId,
    });
  }

  @Post('/v1/authoring/stimuli/:stimulusId/review-decisions')
  async recordStimulusReviewDecision(
    @Param('stimulusId') stimulusId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(
      this.deps,
      response,
      headers,
      'RecordStimulusReviewDecision',
      200,
      recordStimulusDecisionSchema,
      { ...body, stimulusId },
    );
  }

  @Post('/v1/authoring/stimuli/:stimulusId/publication')
  async publishStimulusVersion(
    @Param('stimulusId') stimulusId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'PublishStimulusVersion', 200, publishStimulusSchema, {
      ...body,
      stimulusId,
    });
  }

  @Post('/v1/authoring/stimuli/:stimulusId/retirement')
  async retireStimulus(
    @Param('stimulusId') stimulusId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'RetireStimulus', 200, retireStimulusSchema, {
      ...body,
      stimulusId,
    });
  }

  // ── Solutions ────────────────────────────────────────────────────────────

  @Post('/v1/authoring/solutions')
  async createSolutionDraft(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'CreateSolutionDraft', 201, createSolutionSchema, body);
  }

  @Patch('/v1/authoring/solutions/:solutionId')
  async updateSolutionDraft(
    @Param('solutionId') solutionId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'UpdateSolutionDraft', 200, updateSolutionSchema, {
      ...body,
      solutionId,
    });
  }

  @Post('/v1/authoring/solutions/:solutionId/review-submission')
  async submitSolutionForReview(
    @Param('solutionId') solutionId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'SubmitSolutionForReview', 200, solutionIdSchema, {
      solutionId,
    });
  }

  @Post('/v1/authoring/solutions/:solutionId/review-decisions')
  async recordSolutionReviewDecision(
    @Param('solutionId') solutionId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(
      this.deps,
      response,
      headers,
      'RecordSolutionReviewDecision',
      200,
      recordSolutionDecisionSchema,
      { ...body, solutionId },
    );
  }

  @Post('/v1/authoring/solutions/:solutionId/publication')
  async publishSolutionVersion(
    @Param('solutionId') solutionId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'PublishSolutionVersion', 200, publishSolutionSchema, {
      ...body,
      solutionId,
    });
  }

  // ── Media assets ─────────────────────────────────────────────────────────

  @Get('/v1/authoring/media-assets')
  async listMediaAssets(@Headers() headers: Record<string, string>, @Res() response: Response) {
    await runOperation(this.deps, response, headers, 'ListMediaAssets', 200, listMediaAssetsSchema, {});
  }

  @Post('/v1/authoring/media-assets')
  async registerMediaAsset(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'RegisterMediaAsset', 201, registerMediaSchema, body);
  }

  @Post('/v1/authoring/media-assets/:assetId/versions')
  async addMediaAssetVersion(
    @Param('assetId') assetId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'AddMediaAssetVersion', 201, addMediaVersionSchema, {
      ...body,
      assetId,
    });
  }

  @Post('/v1/authoring/media-assets/:assetId/review-submission')
  async submitMediaAssetForReview(
    @Param('assetId') assetId: string,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'SubmitMediaAssetForReview', 200, assetIdSchema, {
      assetId,
    });
  }

  @Post('/v1/authoring/media-assets/:assetId/review-decisions')
  async recordMediaAssetReviewDecision(
    @Param('assetId') assetId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(
      this.deps,
      response,
      headers,
      'RecordMediaAssetReviewDecision',
      200,
      recordMediaDecisionSchema,
      { ...body, assetId },
    );
  }

  @Post('/v1/authoring/media-assets/:assetId/publication')
  async publishMediaAssetVersion(
    @Param('assetId') assetId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'PublishMediaAssetVersion', 200, publishMediaSchema, {
      ...body,
      assetId,
    });
  }

  @Post('/v1/authoring/media-assets/:assetId/retirement')
  async retireMediaAsset(
    @Param('assetId') assetId: string,
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'RetireMediaAsset', 200, retireMediaSchema, {
      ...body,
      assetId,
    });
  }

  // ── Import ───────────────────────────────────────────────────────────────

  @Post('/v1/authoring/import-batches')
  async importItemBatch(
    @Body() body: unknown,
    @Headers() headers: Record<string, string>,
    @Res() response: Response,
  ) {
    await runOperation(this.deps, response, headers, 'ImportItemBatch', 200, importBatchSchema, body);
  }
}
