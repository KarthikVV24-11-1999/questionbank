import { z } from 'zod';

/**
 * Boundary validation (§8). Generated from `openapi/scoring.yaml`'s shapes and
 * kept in step by `scoring-contract.spec.ts`.
 *
 * **Nothing here accepts or emits an answer key, a correct option or an
 * expected value** (§9 rule 10), and marks are strings so an exact decimal
 * never becomes a double on the way out.
 */

const uuid = z.string().uuid();

export const scoreAttemptSchema = z
  .object({
    attemptId: uuid,
    examProfileVersionId: uuid,
    idempotencyKey: z.string().min(1),
  })
  .strict();

export const draftRescoringSchema = z
  .object({
    trigger: z.enum(['CHALLENGE_UPHELD', 'KEY_DEFECT_CONFIRMED', 'RULE_CORRECTION']),
    scope: z.enum(['ITEM_VERSION', 'RULE_CHANGE', 'FORM']),
    scopeRef: z.string().min(1),
    // A change to published results that nobody can account for afterwards is
    // the failure this prevents.
    reason: z.string().min(1),
  })
  .strict();

export const attemptIdSchema = z.object({ attemptId: uuid }).strict();
export const operationIdSchema = z.object({ operationId: uuid }).strict();

export type ScoreAttemptBody = z.infer<typeof scoreAttemptSchema>;
export type DraftRescoringBody = z.infer<typeof draftRescoringSchema>;
