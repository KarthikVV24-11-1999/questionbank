import { z } from 'zod';
import {
  AuthoringAddMediaVersionRequestSchema,
  AuthoringAttachStimulusRequestSchema,
  AuthoringCreateItemRequestSchema,
  AuthoringCreateSolutionRequestSchema,
  AuthoringCreateStimulusRequestSchema,
  AuthoringDeleteDraftRequestSchema,
  AuthoringDeriveVersionRequestSchema,
  AuthoringImportBatchRequestSchema,
  AuthoringJustificationRequestSchema,
  AuthoringMediaReviewDecisionRequestSchema,
  AuthoringPublishMediaRequestSchema,
  AuthoringPublishSolutionRequestSchema,
  AuthoringPublishStimulusRequestSchema,
  AuthoringPublishVersionRequestSchema,
  AuthoringRegisterMediaRequestSchema,
  AuthoringRetireItemRequestSchema,
  AuthoringRetirementRequestSchema,
  AuthoringReviewDecisionRequestSchema,
  AuthoringSolutionReviewDecisionRequestSchema,
  AuthoringStimulusReviewDecisionRequestSchema,
  AuthoringUpdateItemRequestSchema,
  AuthoringUpdateSolutionRequestSchema,
  AuthoringUpdateStimulusRequestSchema,
} from '@questionbank/contracts/content-schemas';

/**
 * Boundary validation for the authoring surface (§8, ADR-0009).
 *
 * **Every schema here is generated from `openapi/content.yaml`** and imported,
 * not restated — D18's point is that one contract has one description. What
 * this module adds is the *composition*: a handler's command is a path
 * parameter plus a body, and the composition is where a controller would
 * otherwise hand-roll an object and get a field name wrong.
 *
 * **This module carries the answer key, and only the authoring controller may
 * import it** (ADR-0009 condition 3). The delivery controller imports
 * `delivery-schemas.ts`, which reaches none of these.
 */

const uuid = z.string().uuid();

/** Composes a path parameter with a validated body. */
function withParam<TParam extends string, TBody extends z.ZodTypeAny>(
  param: TParam,
  body: TBody,
): z.ZodType<{ [K in TParam]: string } & z.infer<TBody>> {
  return z
    .object({ [param]: uuid })
    .and(body) as unknown as z.ZodType<{ [K in TParam]: string } & z.infer<TBody>>;
}

export const createItemDraftSchema = AuthoringCreateItemRequestSchema;
export const updateItemDraftSchema = withParam('itemId', AuthoringUpdateItemRequestSchema);
export const deriveDraftSchema = withParam('itemId', AuthoringDeriveVersionRequestSchema);
export const deleteItemDraftSchema = withParam('itemId', AuthoringDeleteDraftRequestSchema);
export const attachStimulusSchema = withParam('itemId', AuthoringAttachStimulusRequestSchema);

export const itemIdSchema = z.object({ itemId: uuid }).strict();
export const itemVersionSchema = z.object({ itemId: uuid, itemVersionId: uuid }).strict();
export const authorIdSchema = z.object({ authorId: uuid }).strict();
export const listMediaAssetsSchema = z.object({}).strict();

export const recordItemDecisionSchema = withParam('itemId', AuthoringReviewDecisionRequestSchema);
export const publishItemVersionSchema = withParam('itemId', AuthoringPublishVersionRequestSchema);
export const suspendItemSchema = withParam('itemId', AuthoringJustificationRequestSchema);
export const retireItemSchema = withParam('itemId', AuthoringRetireItemRequestSchema);

export const createStimulusSchema = AuthoringCreateStimulusRequestSchema;
export const updateStimulusSchema = withParam('stimulusId', AuthoringUpdateStimulusRequestSchema);
export const stimulusIdSchema = z.object({ stimulusId: uuid }).strict();
export const recordStimulusDecisionSchema = withParam(
  'stimulusId',
  AuthoringStimulusReviewDecisionRequestSchema,
);
export const publishStimulusSchema = withParam('stimulusId', AuthoringPublishStimulusRequestSchema);
export const retireStimulusSchema = withParam('stimulusId', AuthoringRetirementRequestSchema);

export const createSolutionSchema = AuthoringCreateSolutionRequestSchema;
export const updateSolutionSchema = withParam('solutionId', AuthoringUpdateSolutionRequestSchema);
export const solutionIdSchema = z.object({ solutionId: uuid }).strict();
export const recordSolutionDecisionSchema = withParam(
  'solutionId',
  AuthoringSolutionReviewDecisionRequestSchema,
);
export const publishSolutionSchema = withParam('solutionId', AuthoringPublishSolutionRequestSchema);

export const registerMediaSchema = AuthoringRegisterMediaRequestSchema;
export const addMediaVersionSchema = withParam('assetId', AuthoringAddMediaVersionRequestSchema);
export const assetIdSchema = z.object({ assetId: uuid }).strict();
export const recordMediaDecisionSchema = withParam('assetId', AuthoringMediaReviewDecisionRequestSchema);
export const publishMediaSchema = withParam('assetId', AuthoringPublishMediaRequestSchema);
export const retireMediaSchema = withParam('assetId', AuthoringRetirementRequestSchema);

export const importBatchSchema = AuthoringImportBatchRequestSchema;
