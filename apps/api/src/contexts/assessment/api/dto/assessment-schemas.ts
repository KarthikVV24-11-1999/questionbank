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
