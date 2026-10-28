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
