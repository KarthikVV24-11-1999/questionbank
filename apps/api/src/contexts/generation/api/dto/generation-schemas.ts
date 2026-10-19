import { z } from 'zod';

/**
 * Boundary validation (§8) for the generation HTTP surface, kept in step with
 * `openapi/generation.yaml` by `generation-contract.spec.ts`.
 *
 * Only what an operator may send is here. Nothing names a pin, an identifier or a
 * timestamp the system supplies for itself: a caller who could choose them could
 * backdate a run or claim a model that did not write a candidate. The proposal a
 * candidate carries is only ever read, never accepted from a client.
 */
const uuid = z.string().uuid();

export const startGenerationRunSchema = z
  .object({
    modelVersionId: uuid,
    promptVersionId: uuid,
    // What was asked for. Its shape is the pipeline's to define, so it is an object and no more.
    request: z.record(z.string(), z.unknown()),
    // What the run reserves from its month's budget (M5-41): a positive whole number of tokens.
    budgetTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const runIdSchema = z.object({ runId: uuid }).strict();
export const candidateIdSchema = z.object({ candidateId: uuid }).strict();

export type StartGenerationRunBody = z.infer<typeof startGenerationRunSchema>;
