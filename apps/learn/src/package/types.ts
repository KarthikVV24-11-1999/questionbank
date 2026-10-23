import { z } from 'zod';

/**
 * The package as the client reads it, after it has been verified. Parsed with a schema at the boundary, like every other response: a
 * package that verifies but does not have this shape is a package this build does not understand, and is refused, not guessed at.
 *
 * Items and stimuli are kept as the delivery views they are. The renderer reads their bodies; the shell reads the option ids,
 * the item type and the numeric input. **None of it holds a key** — that is proven by scan on the server, and by the boundary
 * test here, which feeds a package carrying one and expects the shell never to show it.
 */
const body = z.object({ schemaVersion: z.number(), blocks: z.array(z.unknown()) }).passthrough();

const option = z.object({ optionId: z.string(), ordinal: z.number(), body }).passthrough();
const member = z.object({ memberId: z.string(), ordinal: z.number(), body }).passthrough();

export const itemViewSchema = z
  .object({
    itemVersionId: z.string(),
    itemType: z.enum(['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC']),
    stem: body,
    options: z.array(option).optional(),
    matchingLeft: z.array(member).optional(),
    matchingRight: z.array(member).optional(),
    numericInput: z.object({ unitCanonical: z.string().optional(), unitRequired: z.boolean(), acceptedForms: z.array(z.string()) }).passthrough().optional(),
    stimulusVersionId: z.string().optional(),
  })
  .passthrough();

export const formPackageSchema = z.object({
  format: z.literal('questionbank.form-package'),
  formatVersion: z.literal(1),
  form: z.object({
    formId: z.string(),
    examProfileVersionId: z.string(),
    formType: z.string(),
    sessionRefs: z.array(z.string()),
    publishedAt: z.string(),
    window: z.object({ opensAt: z.string(), closesAt: z.string() }),
  }),
  sections: z.array(
    z.object({
      ordinal: z.number(),
      sectionSpecRef: z.string(),
      slots: z.array(
        z.object({
          slotId: z.string(),
          ordinal: z.number(),
          marksAvailable: z.number(),
          itemVersionId: z.string(),
          stimulusVersionId: z.string().optional(),
          item: itemViewSchema,
        }),
      ),
    }),
  ),
  stimuli: z.array(z.object({ stimulusVersionId: z.string(), view: z.object({ body }).passthrough() })),
});

export type FormPackage = z.infer<typeof formPackageSchema>;
export type ItemView = z.infer<typeof itemViewSchema>;
export type PackageSlot = FormPackage['sections'][number]['slots'][number];
