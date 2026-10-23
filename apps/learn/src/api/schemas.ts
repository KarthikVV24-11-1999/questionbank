import { z } from 'zod';

/**
 * The assessment responses the learner app reads, validated at the boundary by the contracts client. Mirrored from
 * `openapi/assessment.yaml` by hand (the generator covers the content document only, D18), so `assessment-api.spec.ts` reads the
 * document and holds these to its required fields: a field the server starts or stops sending fails there, not on a learner's device.
 */
export const attemptSchema = z.object({
  attemptId: z.string(),
  formId: z.string(),
  mode: z.enum(['mock', 'diagnostic']),
  state: z.enum(['created', 'in_progress', 'submitted', 'abandoned']),
  sessionRef: z.string(),
  shiftId: z.string(),
  slotCount: z.number().int(),
  durationMs: z.number().int(),
  /** The one cap on a visit's time on item. Read, never chosen: the projection the learner sees uses this and no other. */
  intervalCapMs: z.number().int().min(1),
  windowClosesAt: z.string(),
  startedAt: z.string().nullable(),
  deadline: z.string().nullable(),
  serverNow: z.string(),
  submission: z.object({ reason: z.enum(['manual', 'expiry', 'recovered']), submittedAt: z.string(), pastDeadline: z.boolean() }).nullable(),
});
export type AttemptDto = z.infer<typeof attemptSchema>;

export const createdAttemptSchema = z.object({ attempt: attemptSchema, replayed: z.boolean() });

export const ingestReportSchema = z.object({
  attemptId: z.string(),
  state: z.string(),
  results: z.array(z.object({ eventId: z.string(), outcome: z.enum(['accepted', 'late', 'replayed', 'rejected']), code: z.string().optional(), message: z.string().optional() })),
  acknowledged: z.array(z.string()),
});
export type IngestReportDto = z.infer<typeof ingestReportSchema>;

export const resultSchema = z.object({
  attemptId: z.string(),
  status: z.enum(['pending', 'scored']),
  score: z
    .object({
      scoreRecordId: z.string(),
      attemptId: z.string(),
      generation: z.number().int(),
      totalRaw: z.string(),
      totalMaxAvailable: z.string(),
      computedAt: z.string(),
      sectionScores: z.array(z.unknown()),
      itemOutcomes: z.array(z.object({ slotId: z.string(), correctness: z.string(), marksAwarded: z.string(), marksAvailable: z.string(), ruleAppliedId: z.string() }).passthrough()),
    })
    .passthrough()
    .optional(),
});
export type ResultDto = z.infer<typeof resultSchema>;

export const signingKeySchema = z.object({ algorithm: z.literal('Ed25519'), keyId: z.string(), publicKey: z.string() });
