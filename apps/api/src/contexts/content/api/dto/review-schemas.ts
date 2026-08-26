import { z } from 'zod';
import {
  ApproveWithEditsRequestSchema,
  ClaimNextForReviewRequestSchema,
  ReassignReviewRequestSchema,
} from '@questionbank/contracts/content-schemas';

/**
 * Boundary validation for the review surface (§8, DEC-M4-12).
 *
 * **Every request/response schema here is generated from `openapi/content.yaml`**
 * and imported, not restated — the same D18 discipline `authoring-schemas.ts`
 * follows. This module adds the same kind of composition: a handler's
 * command is a path parameter plus a body, and the composition is where a
 * controller would otherwise hand-roll an object and get a field name
 * wrong.
 *
 * **This module lives under `api/`, not `application/review/`.** It never
 * imports anything from `application/review/**` or `infrastructure/review/**`
 * — only the generated Zod (a `@questionbank/contracts` package export) and
 * `zod` itself — so it carries no dependency the M4-01 sub-boundary gate
 * would have an opinion about either way.
 */

const uuid = z.string().uuid();

/** Composes a path parameter with a validated body — the same helper `authoring-schemas.ts` declares, kept local rather than shared (a shared helper would be a fifth context-wide contract for one four-line function). */
function withParam<TParam extends string, TBody extends z.ZodTypeAny>(
  param: TParam,
  body: TBody,
): z.ZodType<{ [K in TParam]: string } & z.infer<TBody>> {
  return z
    .object({ [param]: uuid })
    .and(body) as unknown as z.ZodType<{ [K in TParam]: string } & z.infer<TBody>>;
}

export const claimNextForReviewSchema = ClaimNextForReviewRequestSchema;
export const assignmentIdSchema = z.object({ assignmentId: uuid }).strict();
export const reassignReviewSchema = withParam('itemVersionId', ReassignReviewRequestSchema);
export const itemVersionIdSchema = z.object({ itemVersionId: uuid }).strict();
export const approveWithEditsSchema = z
  .object({ itemId: uuid, itemVersionId: uuid })
  .and(ApproveWithEditsRequestSchema);

/**
 * `now` is never sent by a client — the controller supplies the wall-clock
 * read the HTTP boundary is exactly the right place for (DEC-M4-15: no
 * clock inside the domain or application layer, and this query's own
 * interface takes `now` as a caller-supplied fact for that reason). No
 * `content.yaml` schema exists for it because nothing on the wire ever
 * carries it — the same reason `listMediaAssetsSchema` in
 * `authoring-schemas.ts` is hand-written rather than generated.
 */
export const getQueueHealthSchema = z.object({ now: z.string() }).strict();

/**
 * `from`/`to` are query parameters (`ReviewFrom`/`ReviewTo` in
 * `content.yaml`), not a `components.schemas` entry — the generator only
 * processes schemas, never parameters, so this is hand-written the same
 * way `authorIdSchema` is in `authoring-schemas.ts`.
 */
export const getReviewerThroughputSchema = z.object({ from: z.string(), to: z.string() }).strict();
