import { z } from 'zod';

/**
 * Request validation at the HTTP boundary. Each schema mirrors the request body
 * of the operation with the same name in `packages/contracts/openapi/curriculum.yaml`;
 * the contract spec is the source of truth and the parity test keeps them together.
 */

const uuid = z.string().uuid();
const academicYear = z.string().regex(/^\d{4}(-\d{2})?$/u, 'academicYear must look like 2026 or 2026-27');
const unitInterval = z.number().min(0).max(1);

export const createTaxonomyDraftSchema = z
  .object({
    examFamily: z.string().min(1),
    academicYear,
  })
  .strict();

export const addConceptNodeSchema = z
  .object({
    conceptIdentityId: uuid,
    parentNodeId: uuid.optional(),
    displayName: z.string().min(1),
    examWeight: unitInterval,
    estimatedTeachingHours: z.number().min(0),
  })
  .strict();

export const moveConceptNodeSchema = z.object({ newParentNodeId: uuid }).strict();

export const addPrerequisiteEdgeSchema = z
  .object({
    fromConceptIdentityId: uuid,
    toConceptIdentityId: uuid,
    strength: unitInterval,
  })
  .strict();

export const createExamSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,31}$/u, 'code must be upper snake case'),
    displayName: z.string().min(1),
    jurisdiction: z.string().min(1),
    conductingBody: z.string().min(1),
  })
  .strict();

const sectionSpecSchema = z
  .object({
    ordinal: z.number().int().min(1),
    name: z.string().min(1),
    subject: z.string().min(1),
    itemCount: z.number().int().min(1),
    itemTypeMix: z.record(z.string(), z.number().int().min(0)),
    maxMarks: z.number().positive(),
    sectionTiming: z.object({ durationMinutes: z.number().int().positive() }).strict().optional(),
  })
  .strict();

const timingPolicySchema = z
  .object({
    totalDurationMinutes: z.number().int().positive(),
    sectionLocking: z.boolean(),
    warningThresholdsMinutes: z.array(z.number().int().positive()),
    autoSubmitOnExpiry: z.boolean(),
  })
  .strict();

const navigationPolicySchema = z
  .object({
    crossSectionNavigation: z.boolean(),
    allowMarkForReview: z.boolean(),
    allowAnswerChange: z.boolean(),
    allowClearResponse: z.boolean(),
  })
  .strict();

const conditionSchema = z.object({
  kind: z.enum([
    'UNATTEMPTED',
    'EXACT_MATCH',
    'NO_MATCH',
    'ALL_CORRECT_SELECTED',
    'PARTIAL_CORRECT_SELECTED',
    'ANY_INCORRECT_SELECTED',
    'MATCHING_PAIRS_CORRECT',
    'ALWAYS',
  ]),
  minCorrect: z.number().int().min(1).optional(),
  noIncorrect: z.boolean().optional(),
  count: z.number().int().min(1).optional(),
});

const awardSchema = z.object({
  kind: z.enum(['FIXED', 'PER_CORRECT', 'FULL_MARKS']),
  marks: z.number().optional(),
});

const markingRuleSetSchema = z
  .object({
    schemaVersion: z.number().int().min(1),
    rules: z
      .array(
        z
          .object({
            id: z.string().min(1),
            appliesTo: z
              .object({
                itemTypes: z.array(z.string().min(1)).min(1),
                sectionOrdinals: z.array(z.number().int().min(1)).optional(),
              })
              .strict(),
            condition: conditionSchema,
            award: awardSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const numericAnswerSpecSchema = z
  .object({
    expectedValue: z.string(),
    comparisonMode: z.enum([
      'EXACT',
      'ABSOLUTE_TOLERANCE',
      'RELATIVE_TOLERANCE',
      'SIGNIFICANT_FIGURES',
      'RANGE',
    ]),
    toleranceValue: z.string().optional(),
    significantFigures: z.number().int().min(1).optional(),
    rangeMin: z.string().optional(),
    rangeMax: z.string().optional(),
    unit: z
      .object({
        canonical: z.string().min(1),
        acceptedEquivalents: z.array(z.string()),
        required: z.boolean(),
      })
      .strict()
      .optional(),
    acceptedForms: z.array(z.enum(['DECIMAL', 'FRACTION', 'SCIENTIFIC'])).min(1),
    normalization: z
      .object({
        trimWhitespace: z.boolean(),
        stripThousandsSeparator: z.boolean(),
        unicodeMinusToAscii: z.boolean(),
        caseInsensitiveUnit: z.boolean(),
      })
      .partial()
      .optional(),
  })
  .strict();

const itemTypeAllowanceSchema = z
  .object({
    itemType: z.string().min(1),
    sectionOrdinals: z.array(z.number().int().min(1)),
  })
  .strict();

export const profileDraftContentSchema = z
  .object({
    sections: z.array(sectionSpecSchema).min(1),
    totalMarks: z.number().positive(),
    timingPolicy: timingPolicySchema,
    navigationPolicy: navigationPolicySchema,
    markingRuleSet: markingRuleSetSchema,
    toleranceDefault: numericAnswerSpecSchema.optional(),
    itemTypeAllowances: z.array(itemTypeAllowanceSchema).min(1),
  })
  .strict();

export const createProfileDraftSchema = profileDraftContentSchema.extend({
  examId: uuid,
  academicYear,
  taxonomyVersionId: uuid,
});

export const publishProfileVersionSchema = z.object({ activate: z.boolean().optional() }).strict();

export const createMigrationSchema = z
  .object({ fromVersionId: uuid, toVersionId: uuid })
  .strict();

export const addMappingSchema = z
  .object({
    kind: z.enum(['IDENTITY', 'RENAME', 'MOVE', 'SPLIT', 'MERGE', 'REMOVAL']),
    from: z.array(uuid),
    to: z.array(uuid),
    disposition: z.enum(['pending', 'accepted', 'rejected']).optional(),
  })
  .strict();

export const executeMigrationSchema = z
  .object({ chunkSize: z.number().int().min(1).max(1000).optional() })
  .strict();

export const listQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .passthrough();

export const conceptSubtreeQuerySchema = z
  .object({
    rootNodeId: uuid,
    depthLimit: z.coerce.number().int().min(0).max(20).optional(),
  })
  .strict();
