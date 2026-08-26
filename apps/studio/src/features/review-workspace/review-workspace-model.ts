import {
  ReviewerEditsSchema,
  type AuthoringResponseSpec,
  type ContentBody as WireContentBody,
  type DifficultyBand,
  type Provenance,
  type ReviewOutcome,
  type TaxonomyTag,
} from '@questionbank/contracts/content-schemas';
import type { ContentBody as RendererContentBody } from '@questionbank/content-renderer';
import type { RejectionReasonCode } from '@questionbank/contracts/review-taxonomy';

/**
 * **Two `ContentBody` types, deliberately.** `WireContentBody` (from
 * `@questionbank/contracts/content-schemas`, generated) is what the server
 * actually sends — the Zod generator has no discriminated-union support, so
 * a block's shape there is a loose record, not `@questionbank/content-renderer`'s
 * real, strict `Block` union. `RendererContentBody` is what
 * `ContentRenderer` and `body-draft.ts#toContentBody` both actually need.
 * Server-fetched content is `WireContentBody`; a reviewer's own in-progress
 * edit, built through `BodyEditor`, is `RendererContentBody`. Bridging the
 * two at a render call site is a narrow, named cast
 * (`ReviewWorkspace.tsx`/`InlineEditor.tsx`), never a type this model
 * pretends is one thing when it is two.
 */
export type { WireContentBody, RendererContentBody };

/**
 * The review workspace's model (M4-38 through M4-40).
 *
 * **One item, everything about it, in one bundle** — the seven regions UX
 * §10.2 requires none-behind-a-disclosure come from one fetch a reviewer
 * never re-triggers by clicking. `ReviewWorkspaceApi.claimNext` returns the
 * whole bundle or `null` (nothing left to claim), never a partial one a
 * component has to poll for.
 *
 * **The editable-fields enumeration (M4-08, M4-40) is read from the
 * generated contract, not restated.** `ReviewerEditsSchema` (from
 * `@questionbank/contracts/content-schemas`, generated from
 * `openapi/content.yaml`) is the wire shape `ApproveWithEdits` actually
 * accepts; `EDITABLE_FIELDS` below is the subset the UI may ever render a
 * control for. `responseSpec` is deliberately excluded — the domain accepts
 * it on the wire only so a reviewer who supplies one is refused **by name**
 * (`ReviewerEdits`'s own doc comment: "never actually applied"), not because
 * the workspace should ever offer it.
 */

export const EDITABLE_FIELDS = ['stem', 'taxonomyTags', 'difficultyEstimate'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Every key the wire schema accepts — `EDITABLE_FIELDS` must be a subset, and `InlineEditor` must render nothing for the rest. */
export function reviewerEditsWireFields(): readonly string[] {
  return Object.keys(ReviewerEditsSchema.shape);
}

export interface ClaimedAssignment {
  readonly assignmentId: string;
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimedItemVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly itemType: string;
  readonly stem: WireContentBody;
  readonly responseSpec: AuthoringResponseSpec;
  readonly taxonomyTags: readonly TaxonomyTag[];
  readonly difficultyEstimate: DifficultyBand;
  readonly provenance: Provenance;
}

export interface ReviewFinding {
  readonly code: string;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly location: string;
}

export interface ReviewValidation {
  readonly blocking: readonly ReviewFinding[];
  readonly warnings: readonly ReviewFinding[];
}

export interface DuplicateCandidate {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  /** Present only in the trigram group — exact/skeleton membership is binary, not ranked. */
  readonly similarity?: number;
}

export interface DuplicateGroups {
  readonly state: 'evaluated' | 'not_evaluated';
  readonly exact: readonly DuplicateCandidate[];
  readonly skeleton: readonly DuplicateCandidate[];
  readonly trigram: readonly DuplicateCandidate[];
  readonly computedAt?: string;
  readonly asOf: string;
}

/**
 * **D37, named rather than faked.** No authoring-side query returns a
 * draft/in-review solution's content by item version id — only
 * `/v1/authoring/solutions/{solutionId}` (needs a `solutionId` already in
 * hand) and the delivery-only `/v1/solutions/{itemVersionId}` (excludes
 * `finalAnswerAssertion`, and 404s before publication regardless). Trigger:
 * an authoring-side "get the solution for this item version" query lands.
 * Until then this region renders honestly rather than silently, the same
 * choice `duplicateCheckState: 'not_evaluated'` already makes for the panel
 * next to it.
 */
export type SolutionView =
  | { readonly state: 'available'; readonly steps: readonly { readonly ordinal: number; readonly body: WireContentBody }[] }
  | { readonly state: 'not_available' };

export interface ClaimedItemBundle {
  readonly assignment: ClaimedAssignment;
  readonly version: ClaimedItemVersion;
  readonly validation: ReviewValidation;
  readonly duplicates: DuplicateGroups;
  readonly solution: SolutionView;
  /** Depth for this bundle's own subject (DEC-M4-13: capacity planning, never a per-reviewer figure). */
  readonly queueDepth: number;
}

export interface ReviewerEdits {
  readonly stem?: RendererContentBody;
  readonly taxonomyTags?: readonly TaxonomyTag[];
  readonly difficultyEstimate?: DifficultyBand;
}

export interface DecisionSubmission {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly assignmentId: string;
  readonly outcome: ReviewOutcome;
  readonly justification?: string;
  readonly reasonCode?: RejectionReasonCode;
  readonly duplicateOfItemId?: string;
  readonly candidatesShownIds: readonly string[];
  /** Present only for `approve_with_edits`. */
  readonly edits?: ReviewerEdits;
}

export interface ReviewWorkspaceApi {
  /** The claimed bundle, or `null` when nothing is eligible right now — a cold or exhausted queue, rendered, not polled for. */
  claimNext(subject: string): Promise<ClaimedItemBundle | null>;
  recordDecision(input: DecisionSubmission): Promise<void>;
}

export type { ReviewOutcome };
