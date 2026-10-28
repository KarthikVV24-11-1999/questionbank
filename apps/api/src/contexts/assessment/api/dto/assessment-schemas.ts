import { z } from 'zod';
import { BLUEPRINT_DIFFICULTY_BANDS, BLUEPRINT_ITEM_TYPES } from '../../domain/blueprint.js';

/**
 * Boundary validation (§8) for the assessment HTTP surface, kept in step with
 * `openapi/assessment.yaml` by `assessment-contract.spec.ts`.
 *
 * Only what an operator may send is here. Nothing names a form id, a slot id, a
 * session an attempt sits, a publication time or a window the system supplies
 * for itself: the ids and moments are the server's, and the window is set by
 * scheduling and nothing else.
 */
const uuid = z.string().uuid();
const counts = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.partialRecord(z.enum(keys), z.number().int().min(0)).transform((value) => value as Partial<Record<T[number], number>>);

const sectionBlueprint = z
  .object({
    ordinal: z.number().int().min(0),
    sectionSpecRef: z.string().min(1),
    itemCount: z.number().int().min(1),
    typeMix: counts(BLUEPRINT_ITEM_TYPES),
    marksPerItem: z.number().int().min(1),
    difficultyTarget: counts(BLUEPRINT_DIFFICULTY_BANDS),
  })
  .strict();

export const assembleDraftFormSchema = z
  .object({
    blueprint: z
      .object({
        examProfileVersionId: uuid,
        formType: z.enum(['mock', 'diagnostic']),
        totalMarks: z.number().int().min(1),
        difficultyTolerance: z.number().int().min(0),
        sections: z.array(sectionBlueprint).min(1),
      })
      .strict(),
    sessionRefs: z.array(z.string().min(1)).min(1),
    subject: z.string().min(1).optional(),
    maxSteps: z.number().int().min(1).optional(),
  })
  .strict();

export const formIdSchema = z.object({ formId: uuid }).strict();

export const scheduleFormSchema = z
  .object({
    formId: uuid,
    opensAt: z.string().datetime({ offset: false }),
    closesAt: z.string().datetime({ offset: false }),
  })
  .strict();

/**
 * The student's attempt routes (M6-30 to M6-34).
 *
 * **Nothing here can set a deadline, a duration or a window**, and this schema does not refuse them either: an
 * unknown field is dropped, so a client that sends `deadline` or `durationMs` is ignored rather than rejected —
 * the server's own are what the attempt carries, and a spec sends them to prove it. The idempotency key is the
 * `Idempotency-Key` header, joined to the body by the controller.
 */
const idempotencyKey = z.string().min(1).max(200);

export const createAttemptSchema = z.object({
  formId: uuid,
  sessionRef: z.string().min(1),
  shiftId: z.string().min(1).optional(),
  idempotencyKey,
});

export const attemptIdSchema = z.object({ attemptId: uuid }).strict();

/**
 * A practice run (M7-53, D78). The strategy and the scope are checked by the domain, which owns the vocabulary and says which part is wrong; the
 * boundary checks the shape. `count` is checked against the run's bound by the handler. Nothing here can set a form, a window or a deadline: a run has none.
 */
export const createPracticeAttemptSchema = z
  .object({
    examProfileVersionId: uuid,
    selectionStrategy: z.string().min(1),
    scopeFilter: z
      .object({ conceptIdentityIds: z.array(uuid).optional(), subject: z.string().min(1).nullable().optional(), itemTypes: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
    difficultyBand: z.string().min(1).nullable().optional(),
    excludeRecentlySeen: z.boolean().optional(),
    count: z.number().int(),
    idempotencyKey,
  })
  .strict();

export const growPracticeAttemptSchema = z.object({ attemptId: uuid, count: z.number().int() }).strict();

export const practiceFeedbackSchema = z.object({ attemptId: uuid, slotId: uuid }).strict();

export const attemptResultSchema = attemptIdSchema;

export const slotSolutionSchema = z
  .object({ attemptId: uuid, slotId: uuid, depth: z.enum(['basic', 'full']).default('basic') })
  .strict();

export const submitAttemptSchema = z
  .object({
    attemptId: uuid,
    reason: z.enum(['manual', 'expiry', 'recovered']),
    idempotencyKey,
  })
  .strict();

/**
 * A batch of events from a device, in the shape the attempt engine produces (`slot`, `monotonicMs`). Only the
 * envelope is checked here: each event is validated one by one by the domain, so one malformed event is refused
 * alone, with its reason, and the rest of a three-hour log is not rejected with it.
 */
export const ingestEventsSchema = z
  .object({
    attemptId: uuid,
    deviceRef: z.string().min(1),
    events: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  })
  .strict()
  .transform(({ attemptId, deviceRef, events }) => ({
    attemptId,
    events: events.map((event) => ({
      eventId: event['eventId'] as string,
      attemptId: (event['attemptId'] ?? attemptId) as string,
      slotId: event['slot'] as string,
      sequence: event['sequence'] as number,
      kind: event['kind'] as 'select',
      answer: (event['answer'] ?? null) as string | number | readonly (string | number)[] | null,
      clientMonotonicMs: event['monotonicMs'] as number,
      deviceRef,
    })),
  }));
