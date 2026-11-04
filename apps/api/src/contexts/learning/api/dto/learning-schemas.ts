import { z } from 'zod';

/**
 * Boundary validation (§8) for the learner's HTTP surface, kept in step with `openapi/learning.yaml` by `learning-contract.spec.ts`.
 *
 * Nothing here names a learner. The learner is the authenticated principal at every route, so there is no field a client could set to read someone
 * else's report, pace, plan or notebook.
 */
const uuid = z.string().uuid();

export const attemptIdSchema = z.object({ attemptId: uuid }).strict();

export const remediationConceptsSchema = z
  .object({
    taxonomyVersionId: uuid,
    limit: z
      .string()
      .regex(/^\d+$/u)
      .transform(Number)
      .optional(),
  })
  .strict()
  .transform(({ taxonomyVersionId, limit }) => ({ taxonomyVersionId, ...(limit === undefined ? {} : { limit }) }));

export const errorEntriesSchema = z
  .object({ openOnly: z.enum(['true', 'false']).optional() })
  .strict()
  .transform(({ openOnly }) => (openOnly === undefined ? {} : { openOnly: openOnly === 'true' }));

/** The cause is checked against the closed list by the handler, which owns it; the boundary checks only that one was sent. */
export const setErrorCauseSchema = z.object({ errorEntryId: uuid, cause: z.string().min(1) }).strict();

export const createBookmarkSchema = z.object({ itemId: uuid }).strict();

/**
 * The profile (M8-20). A partial update: whatever fields arrive are the step being taken. The handler judges the values (it owns the lists and the ranges); the boundary checks their
 * shape, so a body that is not what the form sends never reaches it.
 */
export const updateProfileSchema = z
  .object({
    examCode: z.string().min(1).max(64).optional(),
    targetYear: z.string().regex(/^\d{4}(-\d{2})?$/u).optional(),
    currentClass: z.enum(['class_11', 'class_12', 'repeater']).optional(),
    priorScore: z.object({ value: z.number().finite(), outOf: z.number().finite() }).strict().nullable().optional(),
    scopeNodeIds: z.array(uuid).max(2000).nullable().optional(),
  })
  .strict();

const pageNumber = z.string().regex(/^\d+$/u).transform(Number);

/** One concept's responses, a page at a time (M8-28). The handler judges the page's size; the boundary checks that what arrived is a number and a concept. */
export const conceptEvidenceSchema = z
  .object({ conceptIdentityId: uuid, limit: pageNumber.optional(), offset: pageNumber.optional() })
  .strict()
  .transform(({ conceptIdentityId, limit, offset }) => ({ conceptIdentityId, ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }) }));

/** The names of concepts in one syllabus (M8-29): a comma-separated list, because a query carries no array. How many is the handler's to judge. */
export const conceptNamesSchema = z
  .object({ taxonomyVersionId: uuid, conceptIdentityIds: z.string().max(4_000) })
  .strict()
  .transform(({ taxonomyVersionId, conceptIdentityIds }) => ({ taxonomyVersionId, conceptIdentityIds: conceptIdentityIds === '' ? [] : conceptIdentityIds.split(',') }));
