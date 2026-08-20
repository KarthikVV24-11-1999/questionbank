// GENERATED FILE — do not edit.
//
// Produced by `scripts/generate-zod.mjs` from `openapi/content.yaml`, which is the source
// of truth (BACKEND-ARCHITECTURE §3, closing D18 for this context). The
// contract spec regenerates it and fails on any difference, so an edit here is
// caught rather than merged.
//
// Regenerate with: pnpm --filter @questionbank/contracts run generate:content

import { z } from 'zod';

export const ErrorCodeSchema = z.enum(["Validation", "Authentication", "Authorization", "Entitlement", "NotFound", "Conflict", "PreconditionFailed", "RuleViolation", "RateLimited", "Unavailable"]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ProblemDetailsSchema = z.object({
  "type": z.string(),
  "title": z.string(),
  "status": z.number().int(),
  "detail": z.string().optional(),
  "code": ErrorCodeSchema,
  "retryable": z.boolean(),
  "correlationId": z.string(),
  "location": z.string().optional(),
}).strict();

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const ItemTypeSchema = z.enum(["SINGLE_CORRECT_MCQ", "MULTIPLE_CORRECT_MCQ", "MATCHING", "NUMERIC"]);

export type ItemType = z.infer<typeof ItemTypeSchema>;

export const LifecycleStateSchema = z.enum(["draft", "in_review", "changes_requested", "approved", "rejected", "published", "suspended", "retired"]);

export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

export const DifficultyBandSchema = z.enum(["foundational", "moderate", "challenging", "advanced"]);

export type DifficultyBand = z.infer<typeof DifficultyBandSchema>;

export const StimulusTypeSchema = z.enum(["passage", "diagram", "dataset", "reaction_scheme"]);

export type StimulusType = z.infer<typeof StimulusTypeSchema>;

export const AssetTypeSchema = z.enum(["photograph", "diagram", "chart", "graph", "reaction_scheme"]);

export type AssetType = z.infer<typeof AssetTypeSchema>;

export const ReviewOutcomeSchema = z.enum(["approve", "approve_with_edits", "request_changes", "reject"]);

export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

export const LicensingStatusValueSchema = z.enum(["owned", "licensed", "public_domain", "unresolved"]);

export type LicensingStatusValue = z.infer<typeof LicensingStatusValueSchema>;

export const ContentBodySchema = z.object({
  "schemaVersion": z.number().int(),
  "blocks": z.array(z.record(z.string(), z.unknown())),
}).strict();

export type ContentBody = z.infer<typeof ContentBodySchema>;

export const LicensingStatusSchema = z.object({
  "status": LicensingStatusValueSchema,
  "licenseRef": z.string().optional(),
  "attribution": z.string().optional(),
  "expiresAt": z.string().optional(),
}).strict();

export type LicensingStatus = z.infer<typeof LicensingStatusSchema>;

export const TaxonomyTagSchema = z.object({
  "conceptIdentityId": z.string(),
  "taxonomyVersionId": z.string(),
  "weight": z.number(),
  "isPrimary": z.boolean(),
}).strict();

export type TaxonomyTag = z.infer<typeof TaxonomyTagSchema>;

export const ProvenanceSchema = z.object({
  "sourceType": z.enum(["original", "previous_year", "licensed", "ai_generated", "ai_assisted"]),
  "sourceExam": z.string().optional(),
  "sourceYear": z.number().int().optional(),
  "sourceSession": z.string().optional(),
  "authorRef": z.string().optional(),
  "modelVersionId": z.string().optional(),
  "promptVersionId": z.string().optional(),
  "generationRunId": z.string().optional(),
  "confidence": z.number().optional(),
  "importBatchId": z.string().optional(),
}).strict();

export type Provenance = z.infer<typeof ProvenanceSchema>;

export const UnitSpecSchema = z.object({
  "canonical": z.string(),
  "acceptedEquivalents": z.array(z.string()),
  "required": z.boolean(),
}).strict();

export type UnitSpec = z.infer<typeof UnitSpecSchema>;

export const NumericAnswerSpecSchema = z.object({
  "expectedValue": z.string(),
  "comparisonMode": z.enum(["EXACT", "ABSOLUTE_TOLERANCE", "RELATIVE_TOLERANCE", "SIGNIFICANT_FIGURES", "RANGE"]),
  "toleranceValue": z.string().optional(),
  "significantFigures": z.number().int().optional(),
  "rangeMin": z.string().optional(),
  "rangeMax": z.string().optional(),
  "unit": UnitSpecSchema.optional(),
  "acceptedForms": z.array(z.enum(["DECIMAL", "SCIENTIFIC", "FRACTION", "INTEGER"])),
}).strict();

export type NumericAnswerSpec = z.infer<typeof NumericAnswerSpecSchema>;

export const AuthoringOptionSchema = z.object({
  "optionId": z.string(),
  "ordinal": z.number().int(),
  "body": ContentBodySchema,
}).strict();

export type AuthoringOption = z.infer<typeof AuthoringOptionSchema>;

export const AuthoringMatchingMemberSchema = z.object({
  "memberId": z.string(),
  "ordinal": z.number().int(),
  "body": ContentBodySchema,
}).strict();

export type AuthoringMatchingMember = z.infer<typeof AuthoringMatchingMemberSchema>;

export const AuthoringResponseSpecSchema = z.object({
  "itemType": ItemTypeSchema,
  "options": z.array(AuthoringOptionSchema).optional(),
  "correctOptionId": z.string().optional(),
  "correctOptionIds": z.array(z.string()).optional(),
  "left": z.array(AuthoringMatchingMemberSchema).optional(),
  "right": z.array(AuthoringMatchingMemberSchema).optional(),
  "pairs": z.array(z.object({
    "left": z.string(),
    "right": z.string(),
  }).strict()).optional(),
  "spec": NumericAnswerSpecSchema.optional(),
}).strict();

export type AuthoringResponseSpec = z.infer<typeof AuthoringResponseSpecSchema>;

export const AuthoringItemContentSchema = z.object({
  "stem": ContentBodySchema,
  "responseSpec": AuthoringResponseSpecSchema,
  "taxonomyTags": z.array(TaxonomyTagSchema),
  "difficultyEstimate": DifficultyBandSchema,
  "provenance": ProvenanceSchema,
  "licensing": LicensingStatusSchema.optional(),
  "stimulusVersionRef": z.string().optional(),
}).strict();

export type AuthoringItemContent = z.infer<typeof AuthoringItemContentSchema>;

export const AuthoringItemVersionSchema = z.object({
  "versionId": z.string(),
  "versionNo": z.number().int(),
  "itemType": ItemTypeSchema,
  "stem": ContentBodySchema,
  "responseSpec": AuthoringResponseSpecSchema,
  "taxonomyTags": z.array(TaxonomyTagSchema),
  "difficultyEstimate": DifficultyBandSchema,
  "provenance": ProvenanceSchema,
  "licensing": LicensingStatusSchema,
  "stimulusVersionRef": z.string().optional(),
  "authoredById": z.string(),
  "createdAt": z.string(),
}).strict();

export type AuthoringItemVersion = z.infer<typeof AuthoringItemVersionSchema>;

export const AuthoringItemSchema = z.object({
  "itemId": z.string(),
  "itemType": ItemTypeSchema,
  "lifecycleState": LifecycleStateSchema,
  "currentPublishedVersionId": z.string().optional(),
  "versions": z.array(AuthoringItemVersionSchema),
  "stateEnteredAt": z.string().optional(),
  "authoringSubject": z.string().optional(),
}).strict();

export type AuthoringItem = z.infer<typeof AuthoringItemSchema>;

export const AuthoringItemPageSchema = z.object({
  "items": z.array(AuthoringItemSchema),
}).strict();

export type AuthoringItemPage = z.infer<typeof AuthoringItemPageSchema>;

export const AuthoringCreateItemRequestSchema = z.object({
  "itemType": ItemTypeSchema,
  "content": AuthoringItemContentSchema,
  "subject": z.string().optional(),
}).strict();

export type AuthoringCreateItemRequest = z.infer<typeof AuthoringCreateItemRequestSchema>;

export const AuthoringUpdateItemRequestSchema = z.object({
  "content": AuthoringItemContentSchema,
  "idempotencyKey": z.string(),
}).strict();

export type AuthoringUpdateItemRequest = z.infer<typeof AuthoringUpdateItemRequestSchema>;

export const AuthoringDeriveVersionRequestSchema = z.object({
  "fromVersionId": z.string(),
}).strict();

export type AuthoringDeriveVersionRequest = z.infer<typeof AuthoringDeriveVersionRequestSchema>;

export const AuthoringDeleteDraftRequestSchema = z.object({
  "justification": z.string(),
}).strict();

export type AuthoringDeleteDraftRequest = z.infer<typeof AuthoringDeleteDraftRequestSchema>;

export const AuthoringAttachStimulusRequestSchema = z.object({
  "stimulusId": z.string(),
}).strict();

export type AuthoringAttachStimulusRequest = z.infer<typeof AuthoringAttachStimulusRequestSchema>;

export const AuthoringReviewDecisionRequestSchema = z.object({
  "itemVersionId": z.string(),
  "outcome": ReviewOutcomeSchema,
  "justification": z.string().optional(),
}).strict();

export type AuthoringReviewDecisionRequest = z.infer<typeof AuthoringReviewDecisionRequestSchema>;

export const AuthoringStimulusReviewDecisionRequestSchema = z.object({
  "stimulusVersionId": z.string(),
  "outcome": ReviewOutcomeSchema,
  "justification": z.string().optional(),
}).strict();

export type AuthoringStimulusReviewDecisionRequest = z.infer<typeof AuthoringStimulusReviewDecisionRequestSchema>;

export const AuthoringSolutionReviewDecisionRequestSchema = z.object({
  "solutionVersionId": z.string(),
  "outcome": ReviewOutcomeSchema,
  "justification": z.string().optional(),
}).strict();

export type AuthoringSolutionReviewDecisionRequest = z.infer<typeof AuthoringSolutionReviewDecisionRequestSchema>;

export const AuthoringMediaReviewDecisionRequestSchema = z.object({
  "assetVersionId": z.string(),
  "outcome": ReviewOutcomeSchema,
  "justification": z.string().optional(),
}).strict();

export type AuthoringMediaReviewDecisionRequest = z.infer<typeof AuthoringMediaReviewDecisionRequestSchema>;

export const AuthoringPublishVersionRequestSchema = z.object({
  "itemVersionId": z.string(),
}).strict();

export type AuthoringPublishVersionRequest = z.infer<typeof AuthoringPublishVersionRequestSchema>;

export const AuthoringPublishStimulusRequestSchema = z.object({
  "stimulusVersionId": z.string(),
}).strict();

export type AuthoringPublishStimulusRequest = z.infer<typeof AuthoringPublishStimulusRequestSchema>;

export const AuthoringPublishSolutionRequestSchema = z.object({
  "solutionVersionId": z.string(),
}).strict();

export type AuthoringPublishSolutionRequest = z.infer<typeof AuthoringPublishSolutionRequestSchema>;

export const AuthoringPublishMediaRequestSchema = z.object({
  "assetVersionId": z.string(),
}).strict();

export type AuthoringPublishMediaRequest = z.infer<typeof AuthoringPublishMediaRequestSchema>;

export const AuthoringJustificationRequestSchema = z.object({
  "justification": z.string(),
}).strict();

export type AuthoringJustificationRequest = z.infer<typeof AuthoringJustificationRequestSchema>;

export const AuthoringRetireItemRequestSchema = z.object({
  "retirementReason": z.string(),
  "replacedByItemId": z.string().optional(),
}).strict();

export type AuthoringRetireItemRequest = z.infer<typeof AuthoringRetireItemRequestSchema>;

export const AuthoringRetirementRequestSchema = z.object({
  "retirementReason": z.string(),
}).strict();

export type AuthoringRetirementRequest = z.infer<typeof AuthoringRetirementRequestSchema>;

export const AuthoringStimulusVersionSchema = z.object({
  "versionId": z.string(),
  "versionNo": z.number().int(),
  "body": ContentBodySchema,
  "licensing": LicensingStatusSchema,
  "authoredById": z.string(),
  "createdAt": z.string(),
}).strict();

export type AuthoringStimulusVersion = z.infer<typeof AuthoringStimulusVersionSchema>;

export const AuthoringStimulusSchema = z.object({
  "stimulusId": z.string(),
  "stimulusType": StimulusTypeSchema,
  "lifecycleState": LifecycleStateSchema,
  "currentPublishedVersionId": z.string().optional(),
  "versions": z.array(AuthoringStimulusVersionSchema),
}).strict();

export type AuthoringStimulus = z.infer<typeof AuthoringStimulusSchema>;

export const AuthoringCreateStimulusRequestSchema = z.object({
  "stimulusType": StimulusTypeSchema,
  "subject": z.string(),
  "body": ContentBodySchema,
  "licensing": LicensingStatusSchema.optional(),
}).strict();

export type AuthoringCreateStimulusRequest = z.infer<typeof AuthoringCreateStimulusRequestSchema>;

export const AuthoringUpdateStimulusRequestSchema = z.object({
  "subject": z.string(),
  "body": ContentBodySchema,
  "licensing": LicensingStatusSchema.optional(),
  "idempotencyKey": z.string(),
}).strict();

export type AuthoringUpdateStimulusRequest = z.infer<typeof AuthoringUpdateStimulusRequestSchema>;

export const AuthoringSolutionStepSchema = z.object({
  "ordinal": z.number().int(),
  "body": ContentBodySchema,
  "conceptRefs": z.array(z.string()),
}).strict();

export type AuthoringSolutionStep = z.infer<typeof AuthoringSolutionStepSchema>;

export const AuthoringFinalAnswerSchema = z.object({
  "kind": z.enum(["OPTION", "OPTION_SET", "PAIRS", "NUMERIC"]),
  "optionId": z.string().optional(),
  "optionIds": z.array(z.string()).optional(),
  "pairs": z.array(z.object({
    "left": z.string(),
    "right": z.string(),
  }).strict()).optional(),
  "value": z.string().optional(),
  "unit": z.string().optional(),
}).strict();

export type AuthoringFinalAnswer = z.infer<typeof AuthoringFinalAnswerSchema>;

export const AuthoringSolutionContentSchema = z.object({
  "finalAnswerAssertion": AuthoringFinalAnswerSchema,
  "steps": z.array(AuthoringSolutionStepSchema),
  "distractorAnalyses": z.array(z.object({
    "optionId": z.string(),
    "misconception": ContentBodySchema,
  }).strict()).optional(),
  "alternateApproaches": z.array(z.object({
    "label": z.string(),
    "steps": z.array(AuthoringSolutionStepSchema),
    "applicabilityNote": z.string().optional(),
  }).strict()).optional(),
}).strict();

export type AuthoringSolutionContent = z.infer<typeof AuthoringSolutionContentSchema>;

export const AuthoringSolutionVersionSchema = z.object({
  "versionId": z.string(),
  "versionNo": z.number().int(),
  "finalAnswerAssertion": AuthoringFinalAnswerSchema,
  "steps": z.array(AuthoringSolutionStepSchema),
  "authoredById": z.string(),
  "createdAt": z.string(),
}).strict();

export type AuthoringSolutionVersion = z.infer<typeof AuthoringSolutionVersionSchema>;

export const AuthoringSolutionSchema = z.object({
  "solutionId": z.string(),
  "itemId": z.string(),
  "targetItemVersionId": z.string(),
  "lifecycleState": LifecycleStateSchema,
  "currentPublishedVersionId": z.string().optional(),
  "versions": z.array(AuthoringSolutionVersionSchema),
}).strict();

export type AuthoringSolution = z.infer<typeof AuthoringSolutionSchema>;

export const AuthoringCreateSolutionRequestSchema = z.object({
  "itemId": z.string(),
  "targetItemVersionId": z.string(),
  "subject": z.string(),
  "content": AuthoringSolutionContentSchema,
}).strict();

export type AuthoringCreateSolutionRequest = z.infer<typeof AuthoringCreateSolutionRequestSchema>;

export const AuthoringUpdateSolutionRequestSchema = z.object({
  "subject": z.string(),
  "content": AuthoringSolutionContentSchema,
  "idempotencyKey": z.string(),
}).strict();

export type AuthoringUpdateSolutionRequest = z.infer<typeof AuthoringUpdateSolutionRequestSchema>;

export const AuthoringMediaVersionInputSchema = z.object({
  "storageKey": z.string(),
  "mimeType": z.string(),
  "width": z.number().int(),
  "height": z.number().int(),
  "altText": z.string(),
  "longDescription": z.string().optional(),
  "licensing": LicensingStatusSchema.optional(),
}).strict();

export type AuthoringMediaVersionInput = z.infer<typeof AuthoringMediaVersionInputSchema>;

export const AuthoringRegisterMediaRequestSchema = z.object({
  "assetType": AssetTypeSchema,
  "subject": z.string(),
  "version": AuthoringMediaVersionInputSchema,
}).strict();

export type AuthoringRegisterMediaRequest = z.infer<typeof AuthoringRegisterMediaRequestSchema>;

export const AuthoringAddMediaVersionRequestSchema = z.object({
  "subject": z.string(),
  "version": AuthoringMediaVersionInputSchema,
}).strict();

export type AuthoringAddMediaVersionRequest = z.infer<typeof AuthoringAddMediaVersionRequestSchema>;

export const AuthoringMediaAssetSchema = z.object({
  "assetId": z.string(),
  "assetType": AssetTypeSchema,
  "lifecycleState": LifecycleStateSchema,
  "latestVersionId": z.string(),
  "storageKey": z.string(),
  "mimeType": z.string(),
  "width": z.number().int(),
  "height": z.number().int(),
  "altText": z.string(),
  "longDescription": z.string().optional(),
}).strict();

export type AuthoringMediaAsset = z.infer<typeof AuthoringMediaAssetSchema>;

export const AuthoringMediaAssetPageSchema = z.object({
  "items": z.array(AuthoringMediaAssetSchema),
}).strict();

export type AuthoringMediaAssetPage = z.infer<typeof AuthoringMediaAssetPageSchema>;

export const AuthoringFindingSchema = z.object({
  "code": z.string(),
  "severity": z.enum(["blocking", "warning"]),
  "message": z.string(),
  "location": z.string(),
}).strict();

export type AuthoringFinding = z.infer<typeof AuthoringFindingSchema>;

export const AuthoringValidationReportSchema = z.object({
  "findings": z.array(AuthoringFindingSchema),
  "blocking": z.array(AuthoringFindingSchema),
  "warnings": z.array(AuthoringFindingSchema),
  "maySubmit": z.boolean(),
  "duplicateCheckState": z.enum(["not_evaluated", "none_found", "candidates_found"]),
}).strict();

export type AuthoringValidationReport = z.infer<typeof AuthoringValidationReportSchema>;

export const AuthoringImportBatchRequestSchema = z.object({
  "contents": z.string(),
}).strict();

export type AuthoringImportBatchRequest = z.infer<typeof AuthoringImportBatchRequestSchema>;

export const AuthoringImportReportSchema = z.object({
  "batchId": z.string(),
  "source": z.string(),
  "totalRecords": z.number().int(),
  "imported": z.array(z.object({
    "lineNumber": z.number().int(),
    "recordId": z.string(),
    "itemId": z.string(),
  }).strict()),
  "rejected": z.array(z.object({
    "lineNumber": z.number().int(),
    "recordId": z.string(),
    "code": z.string(),
    "message": z.string(),
    "location": z.string().optional(),
  }).strict()),
  "duplicateCheckState": z.enum(["deferred"]),
}).strict();

export type AuthoringImportReport = z.infer<typeof AuthoringImportReportSchema>;

export const DeliveryOptionSchema = z.object({
  "optionId": z.string(),
  "ordinal": z.number().int(),
  "body": ContentBodySchema,
}).strict();

export type DeliveryOption = z.infer<typeof DeliveryOptionSchema>;

export const DeliveryMatchingMemberSchema = z.object({
  "memberId": z.string(),
  "ordinal": z.number().int(),
  "body": ContentBodySchema,
}).strict();

export type DeliveryMatchingMember = z.infer<typeof DeliveryMatchingMemberSchema>;

export const DeliveryNumericInputSchema = z.object({
  "unitCanonical": z.string().optional(),
  "unitRequired": z.boolean(),
  "acceptedForms": z.array(z.enum(["DECIMAL", "SCIENTIFIC", "FRACTION", "INTEGER"])),
}).strict();

export type DeliveryNumericInput = z.infer<typeof DeliveryNumericInputSchema>;

export const DeliveryItemSchema = z.object({
  "itemId": z.string(),
  "itemVersionId": z.string(),
  "versionNo": z.number().int(),
  "itemType": ItemTypeSchema,
  "stem": ContentBodySchema,
  "stimulusVersionId": z.string().optional(),
  "options": z.array(DeliveryOptionSchema).optional(),
  "matchingLeft": z.array(DeliveryMatchingMemberSchema).optional(),
  "matchingRight": z.array(DeliveryMatchingMemberSchema).optional(),
  "numericInput": DeliveryNumericInputSchema.optional(),
}).strict();

export type DeliveryItem = z.infer<typeof DeliveryItemSchema>;

export const DeliveryStimulusSchema = z.object({
  "stimulusId": z.string(),
  "stimulusVersionId": z.string(),
  "versionNo": z.number().int(),
  "stimulusType": StimulusTypeSchema,
  "body": ContentBodySchema,
}).strict();

export type DeliveryStimulus = z.infer<typeof DeliveryStimulusSchema>;

export const DeliverySolutionStepSchema = z.object({
  "ordinal": z.number().int(),
  "body": ContentBodySchema,
  "conceptRefs": z.array(z.string()),
}).strict();

export type DeliverySolutionStep = z.infer<typeof DeliverySolutionStepSchema>;

export const DeliverySolutionSchema = z.object({
  "solutionVersionId": z.string(),
  "targetItemVersionId": z.string(),
  "steps": z.array(DeliverySolutionStepSchema),
  "distractorAnalyses": z.array(z.object({
    "optionId": z.string(),
    "misconception": ContentBodySchema,
  }).strict()).optional(),
  "alternateApproaches": z.array(z.object({
    "label": z.string(),
    "steps": z.array(DeliverySolutionStepSchema),
    "applicabilityNote": z.string().optional(),
  }).strict()).optional(),
}).strict();

export type DeliverySolution = z.infer<typeof DeliverySolutionSchema>;
