import type { PrincipalRef } from '@questionbank/domain-types';
import { ok, err, type Result } from './result.js';
import { preconditionFailedError, ruleViolationError, type ContentError } from './content-error.js';
import type { Item } from './item.js';
import type { ItemVersion } from './item-version.js';
import { publicationBlockReason } from './licensing-status.js';
import { isMachineProposed } from './provenance.js';
import { primaryTagOf } from './taxonomy-tag.js';
import { isSelfReview } from './review/self-review.js';

/**
 * The publication preconditions (INV-07, INV-12, INV-01, INV-14, FR-TCH-07).
 *
 * **Every unmet precondition is reported, not the first one.** An author who
 * fixes one thing, resubmits, and is told about the next wastes the session —
 * and the fifth time it happens they stop submitting (UX §10.1). The failure
 * carries the whole list.
 *
 * **Facts the domain cannot know are supplied, not fetched.** Solution
 * availability lives in another aggregate (D5), the render verdict comes from
 * the renderer, and "now" is not something a pure function reads. The handler
 * (M3-28) resolves each and passes it in; the domain refuses without them
 * rather than assuming. That keeps this function total, pure and reproducible,
 * and it keeps the enforcement in the domain where every caller meets it —
 * HTTP, import, script or test.
 *
 * **A supplied fact is not a caller's opinion.** `PublicationFacts` carries
 * evidence — the signature, the solution's identity, the render verdict — not
 * booleans meaning "trust me". A caller that wants to bypass a precondition has
 * to fabricate the evidence, which is a different and much more visible act
 * than passing `true`.
 */

export const PRECONDITION_CODES = [
  'TAGS_MISSING',
  'PRIMARY_TAG_MISSING',
  'PROVENANCE_MISSING',
  'LICENSING_NOT_RESOLVED',
  'ANSWER_SPECIFICATION_INVALID',
  'REVIEWER_SIGNATURE_MISSING',
  'REVIEWER_IS_AUTHOR',
  'AI_CONTENT_NOT_HUMAN_REVIEWED',
  'SOLUTION_MISSING',
  'SOLUTION_DISAGREES_WITH_KEY',
  'RENDER_VERDICT_MISSING',
  'RENDER_FAILED',
] as const;
export type PreconditionCode = (typeof PRECONDITION_CODES)[number];

export interface UnmetPrecondition {
  readonly code: PreconditionCode;
  readonly message: string;
  readonly location: string;
}

/** A reviewer's signature on a specific version (FR-QM-03 rule 1). */
export interface ReviewerSignature {
  readonly reviewer: PrincipalRef;
  readonly itemVersionId: string;
  readonly decision: 'approve' | 'approve_with_edits';
  readonly signedAt: string;
}

/** What a published solution asserts, resolved by the handler (D5). */
export interface SolutionAvailability {
  readonly solutionVersionId: string;
  readonly targetItemVersionId: string;
  readonly agreesWithKey: boolean;
}

/** The renderer's verdict across every supported surface (FR-QM-14 rule 2). */
export interface RenderVerdict {
  readonly itemVersionId: string;
  readonly surfacesChecked: readonly string[];
  readonly failures: readonly string[];
}

export interface PublicationFacts {
  readonly signature?: ReviewerSignature;
  readonly solution?: SolutionAvailability;
  readonly renderVerdict?: RenderVerdict;
  /** Whether the executor accepts the version's key (M3-08). */
  readonly answerSpecificationAccepted: boolean;
  /** The instant publication is evaluated at — supplied, never read here. */
  readonly asOf: string;
}

export type PublicationError = ContentError<'PUBLICATION_PRECONDITIONS_UNMET'> & {
  readonly unmet: readonly UnmetPrecondition[];
};

function unmet(code: PreconditionCode, message: string, location: string): UnmetPrecondition {
  return { code, message, location };
}

/**
 * Checks every precondition and returns all failures at once.
 *
 * The order below is the order the validation panel shows them in: what the
 * author can fix first, first.
 */
export function checkPublishable(
  item: Item,
  version: ItemVersion,
  facts: PublicationFacts,
): Result<true, PublicationError> {
  const failures: UnmetPrecondition[] = [];

  // ── INV-07: tags ──────────────────────────────────────────────────────────
  if (version.taxonomyTags.length === 0) {
    failures.push(
      unmet('TAGS_MISSING', 'a published item carries at least one concept tag', 'version.taxonomyTags'),
    );
  } else if (primaryTagOf(version.taxonomyTags) === undefined) {
    failures.push(
      unmet(
        'PRIMARY_TAG_MISSING',
        'one tag must be primary — coverage reporting and search ranking key on it',
        'version.taxonomyTags',
      ),
    );
  }

  // ── INV-07: provenance ────────────────────────────────────────────────────
  // `createProvenance` already refuses an incomplete record, so reaching here
  // with none means the version was assembled around the constructor.
  if (version.provenance === undefined) {
    failures.push(
      unmet('PROVENANCE_MISSING', 'a published item records where it came from', 'version.provenance'),
    );
  }

  // ── INV-07: licensing ─────────────────────────────────────────────────────
  // Branching on the reason rather than asking `isPublishable` and then asking
  // again for the message: the two agree on every case by construction, and
  // `licensing-status.spec.ts` asserts it, so a `??` fallback here would be a
  // branch nothing can reach.
  const licensingBlock = publicationBlockReason(version.licensing, { asOf: facts.asOf });
  if (licensingBlock !== undefined) {
    failures.push(unmet('LICENSING_NOT_RESOLVED', licensingBlock, 'version.licensing'));
  }

  // ── INV-07: a valid answer specification ──────────────────────────────────
  if (!facts.answerSpecificationAccepted) {
    failures.push(
      unmet(
        'ANSWER_SPECIFICATION_INVALID',
        'the scoring executor does not accept this item’s answer key',
        'version.responseSpec',
      ),
    );
  }

  // ── INV-07 and INV-12: the reviewer signature ─────────────────────────────
  const signature = facts.signature;
  if (signature === undefined || signature.itemVersionId !== version.versionId) {
    failures.push(
      unmet(
        'REVIEWER_SIGNATURE_MISSING',
        'every published version carries a reviewer signature for that version (INV-07)',
        'version.reviewDecision',
      ),
    );
  } else {
    // INV-12, via the one shared function (M4-04) — checked here as well as
    // at assignment, because assignment is M4's and a precondition that
    // depends on another milestone's diligence is not a precondition.
    if (isSelfReview(version, signature.reviewer)) {
      failures.push(
        unmet(
          'REVIEWER_IS_AUTHOR',
          'the reviewer is the author of this version; self-review is prohibited (INV-12)',
          'version.reviewDecision',
        ),
      );
    }

    // INV-01. AI proposes, a human disposes — a machine signature on machine
    // content is a code path from a model to a published item, which is the
    // one thing D8 says must not exist.
    //
    // Guarded on provenance being present. A version assembled around the
    // provenance constructor already failed above, and reading `sourceType`
    // off it here would throw — which the domain may never do (§8), least of
    // all on the path that decides whether something reaches a student.
    if (version.provenance !== undefined && isMachineProposed(version.provenance) && signature.reviewer.kind !== 'human') {
      failures.push(
        unmet(
          'AI_CONTENT_NOT_HUMAN_REVIEWED',
          `this version is ${version.provenance.sourceType} and was signed by a ${signature.reviewer.kind}; AI-sourced content requires a human reviewer (INV-01)`,
          'version.reviewDecision',
        ),
      );
    }
  }

  // ── INV-08 / D5: a solution ───────────────────────────────────────────────
  const solution = facts.solution;
  if (solution === undefined || solution.targetItemVersionId !== version.versionId) {
    failures.push(
      unmet(
        'SOLUTION_MISSING',
        'no item is published without a solution targeting this version (D5, INV-08)',
        'solution',
      ),
    );
  } else if (!solution.agreesWithKey) {
    failures.push(
      unmet(
        'SOLUTION_DISAGREES_WITH_KEY',
        'the solution’s stated final answer does not match the item’s key',
        'solution',
      ),
    );
  }

  // ── INV-14 / FR-QM-14 rule 2: renders on every surface ────────────────────
  const verdict = facts.renderVerdict;
  if (verdict === undefined || verdict.itemVersionId !== version.versionId) {
    failures.push(
      unmet(
        'RENDER_VERDICT_MISSING',
        'publication requires a render check for this version across every supported surface',
        'version.stem',
      ),
    );
  } else if (verdict.failures.length > 0) {
    failures.push(
      unmet(
        'RENDER_FAILED',
        `this version does not render on every supported surface: ${verdict.failures.join('; ')}`,
        'version.stem',
      ),
    );
  }

  if (failures.length > 0) {
    return err(buildError(item, failures));
  }

  return ok(true);
}

function buildError(item: Item, failures: readonly UnmetPrecondition[]): PublicationError {
  const base = preconditionFailedError(
    'PUBLICATION_PRECONDITIONS_UNMET',
    `item ${item.itemId} cannot be published: ${failures.map((failure) => failure.code).join(', ')}`,
    'lifecycleState',
  );
  return Object.freeze({ ...base, unmet: Object.freeze([...failures]) });
}

/**
 * The boolean `publishVersion` takes. Kept separate so the aggregate cannot
 * accidentally be handed a verdict computed some other way.
 */
export function arePublicationPreconditionsSatisfied(
  item: Item,
  version: ItemVersion,
  facts: PublicationFacts,
): boolean {
  return checkPublishable(item, version, facts).ok;
}

/**
 * INV-01 on its own, so the boundary can be asserted directly rather than
 * inferred from a list of failures.
 *
 * There is no code path from a model to a published item: AI-sourced
 * provenance requires a human signature, and a machine signature is refused
 * whatever else is true.
 */
export function checkNoMachinePublishesItsOwnContent(
  version: ItemVersion,
  signature: ReviewerSignature | undefined,
): Result<true, ContentError> {
  if (version.provenance === undefined || !isMachineProposed(version.provenance)) return ok(true);
  if (signature !== undefined && signature.reviewer.kind === 'human') return ok(true);

  return err(
    ruleViolationError(
      'AI_CONTENT_NOT_HUMAN_REVIEWED',
      'AI-sourced content reaches publication only through a human reviewer (INV-01, D8)',
      'version.reviewDecision',
    ),
  );
}
