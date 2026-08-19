/**
 * The review sub-boundary (DEC-M4-7, ADR-0019).
 *
 * `contexts/content/*​/review/` holds the review workspace's write path —
 * assignment, decision capture, ageing, duplicate fingerprints. It lives
 * inside `content` rather than a fourth context because its writes must
 * close in the same transaction as content's own state (a claim, a decision
 * and a publication precondition are one atomic fact, not three), and §9
 * rule 4 makes a cross-context write an event, which cannot buy back that
 * atomicity.
 *
 * **The rule this directory exists to prove holds — asserted by
 * `apps/api/src/fitness/content-rules.ts`'s
 * `checkReviewAuthoringSubBoundary`:**
 *   - `review/` may import content's domain aggregates and value objects
 *     (any file directly under `domain/`, not nested under `domain/review/`)
 *     and `application/authorization.ts`, and nothing else content owns
 *     outside `review/`.
 *   - The rest of content — its handlers, queries, commands, repositories,
 *     controllers — may import nothing from `review/`.
 *
 * Both directions are enforced structurally, not by convention: co-location
 * without an enforced seam is the entanglement DEC-M4-7 warns against.
 *
 * **No parallel `Result` or `ContentError`.** A separate context would have
 * forced review to declare its own failure taxonomy the way scoring and
 * curriculum each declare their own `Result` (see `../result.ts`'s header).
 * Co-location removes that forcing function, so review modules import
 * content's own `Result` and `ContentError` directly — re-exported here so
 * every review module has one place to get them from.
 *
 * **The extraction path, so a future reader inherits the reasoning, not just
 * the outcome.** `review/` becomes its own context only when *all* of the
 * following are true at once — any one alone is not enough, because each
 * addresses only part of DEC-M4-7's atomicity argument:
 *
 *   1. A second consumer, outside content, needs to read or drive the review
 *      workspace directly — today nothing does; M4 mounts its routes under
 *      `/v1/authoring/review/**` precisely because reviewing is content's own
 *      authoring surface (DEC-M4-12).
 *   2. The decision handler no longer needs to commit in the same
 *      transaction as the publication precondition it feeds — i.e. the
 *      refusal case DEC-M4-7 walks through (a reviewer forty items
 *      downstream of a precondition failure) has an answer that does not
 *      require atomicity, which no relay or outbox pattern supplies today
 *      (D35).
 *   3. INV-12's self-review check has a way to hold across an event boundary
 *      without replicating `authoredBy`/`editedBy` — replication is what
 *      turns "every published item carries a reviewer signature" from a
 *      guarantee into an eventual one.
 *   4. A concrete second workstream — M5's generation intake is the named
 *      candidate — needs the seam enough to pay for a facade and an event
 *      contract, the way DEC-M4-7's rejected first pass would have.
 *
 * Until then, the boundary below is the one that has to hold.
 */

export { err, ok, type Result } from '../result.js';
export {
  conflictError,
  isContentErrorKind,
  notFoundError,
  preconditionFailedError,
  ruleViolationError,
  validationError,
  type ContentError,
  type ContentErrorKind,
} from '../content-error.js';
