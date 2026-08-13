import { z } from 'zod';

/**
 * Boundary validation for the delivery surface.
 *
 * **This module imports nothing from `authoring-schemas.ts`, and it never
 * will** (ADR-0009 condition 3). The condition is asserted by import graph at
 * M3-44 rather than by the file names — a rename defeats a naming convention
 * and does not defeat an import.
 *
 * There are no request bodies here. Delivery reads; it does not accept
 * authored content, which is why the only shapes are path and query
 * parameters.
 */

const uuid = z.string().uuid();

export const publishedItemSchema = z.object({ itemId: uuid }).strict();
export const publishedStimulusSchema = z.object({ stimulusId: uuid }).strict();

/**
 * `depth` is validated here rather than defaulted. `basic` is an unconditional
 * grant (INV-08) and `full` is entitlement-gated, so a request that means
 * neither must be refused rather than quietly served the cheaper one.
 */
export const publishedSolutionSchema = z
  .object({ itemVersionId: uuid, depth: z.enum(['basic', 'full']) })
  .strict();
