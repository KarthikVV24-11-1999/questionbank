import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type {
  ItemRepository,
  MediaAssetRepository,
  SolutionRepository,
} from '../../domain/repository-ports.js';
import { latestVersionOf, type Item } from '../../domain/item.js';
import type { DifficultyBand, ItemVersion } from '../../domain/item-version.js';
import type { LifecycleState } from '../../domain/item-lifecycle.js';
import type { LicensingStatus } from '../../domain/licensing-status.js';
import type { Provenance } from '../../domain/provenance.js';
import type { ResponseSpecification } from '../../domain/response-specification.js';
import type { TaxonomyTag } from '../../domain/taxonomy-tag.js';
import { accessibleDescriptionOf, latestMediaVersionOf } from '../../domain/media-asset.js';
import { unanalysedDistractors } from '../../domain/solution.js';
import { validateDraft, type ValidationReport } from '../../domain/pre-submission-validation.js';
import { isKeyAcceptedByExecutor } from '../answer-key-projection.js';
import {
  applicationError,
  authorize,
  authorizeDraftAccess,
  policy,
  type ApplicationError,
} from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext, Clock, RenderValidator } from '../ports.js';

/**
 * The authoring read models — **the only views in this context that carry the
 * answer key** (DEC-4, ADR-0009).
 *
 * Every type here is named `Authoring*`. That is a convention, and a rename
 * defeats a convention, so the enforcement is not the naming: M3-44 asserts by
 * import graph that no delivery controller can reach this module at all. What
 * the naming buys is that a reviewer reading a diff can see which family a new
 * view joined.
 *
 * A principal without an authoring role is refused with `Authorization`, never
 * an empty result — an empty result reads as "no such item" and teaches an
 * author that their colleague's work does not exist rather than that it is not
 * theirs to see (FR-TCH-06 rule 1).
 */

export const AUTHORING_ROLES = Object.freeze(['author', 'reviewer', 'content_ops']);

export const GET_ITEM_DRAFT_POLICY = policy('GetItemDraft', AUTHORING_ROLES);
export const LIST_MY_DRAFTS_POLICY = policy('ListMyDrafts', AUTHORING_ROLES);
export const GET_ITEM_VERSION_FOR_AUTHORING_POLICY = policy('GetItemVersionForAuthoring', AUTHORING_ROLES);
export const GET_VALIDATION_FINDINGS_POLICY = policy('GetValidationFindings', AUTHORING_ROLES);
export const LIST_MEDIA_ASSETS_POLICY = policy('ListMediaAssets', AUTHORING_ROLES);

export interface GetItemDraft {
  readonly itemId: string;
}

export interface ListMyDrafts {
  readonly authorId: string;
}

export interface GetItemVersionForAuthoring {
  readonly itemId: string;
  readonly itemVersionId: string;
}

export interface GetValidationFindings {
  readonly itemId: string;
}

export interface ListMediaAssets {
  readonly _tag?: never;
}

/** The whole authored version, key included — this is the editing surface. */
export interface AuthoringItemVersionView {
  readonly versionId: string;
  readonly versionNo: number;
  readonly itemType: ItemVersion['itemType'];
  readonly stem: ItemVersion['stem'];
  /** Carries `correctOptionId`, `correctOptionIds`, the pairing, the expected value. */
  readonly responseSpec: ResponseSpecification;
  readonly taxonomyTags: readonly TaxonomyTag[];
  readonly difficultyEstimate: DifficultyBand;
  readonly provenance: Provenance;
  readonly licensing: LicensingStatus;
  readonly stimulusVersionRef?: string;
  readonly authoredById: string;
  readonly createdAt: string;
}

export interface AuthoringItemView {
  readonly itemId: string;
  readonly itemType: Item['itemType'];
  readonly lifecycleState: LifecycleState;
  readonly currentPublishedVersionId?: string;
  readonly versions: readonly AuthoringItemVersionView[];
  /** The review queue's ageing clock (M4-13). Never on a delivery view — a student has no interest in review latency. */
  readonly stateEnteredAt?: string;
  /** The routing key (M4-14). Never on a delivery view. */
  readonly authoringSubject?: string;
}

export interface AuthoringMediaAssetView {
  readonly assetId: string;
  readonly assetType: string;
  readonly lifecycleState: LifecycleState;
  readonly latestVersionId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly altText: string;
  readonly longDescription?: string;
}

export function toAuthoringVersionView(version: ItemVersion): AuthoringItemVersionView {
  return Object.freeze({
    versionId: version.versionId,
    versionNo: version.versionNo,
    itemType: version.itemType,
    stem: version.stem,
    responseSpec: version.responseSpec,
    taxonomyTags: version.taxonomyTags,
    difficultyEstimate: version.difficultyEstimate,
    provenance: version.provenance,
    licensing: version.licensing,
    ...(version.stimulusVersionRef === undefined
      ? {}
      : { stimulusVersionRef: version.stimulusVersionRef }),
    // The identifier, not the principal: a view carries no role set, because
    // role sets are how a client starts making its own authorization decisions.
    authoredById: version.authoredBy.id,
    createdAt: version.createdAt,
  });
}

export function toAuthoringItemView(item: Item): AuthoringItemView {
  return Object.freeze({
    itemId: item.itemId,
    itemType: item.itemType,
    lifecycleState: item.lifecycleState,
    ...(item.currentPublishedVersionId === undefined
      ? {}
      : { currentPublishedVersionId: item.currentPublishedVersionId }),
    versions: Object.freeze(item.versions.map(toAuthoringVersionView)),
    ...(item.stateEnteredAt === undefined ? {} : { stateEnteredAt: item.stateEnteredAt }),
    ...(item.authoringSubject === undefined ? {} : { authoringSubject: item.authoringSubject }),
  });
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export interface AuthoringQueryDependencies {
  readonly items: ItemRepository;
  readonly solutions: SolutionRepository;
  readonly assets: MediaAssetRepository;
  readonly renderer: RenderValidator;
  readonly clock: Clock;
}

export class GetItemDraftHandler implements Handler<GetItemDraft, AuthoringItemView> {
  readonly name = 'GetItemDraft';
  readonly policy = GET_ITEM_DRAFT_POLICY;

  constructor(private readonly deps: AuthoringQueryDependencies) {}

  async handle(
    query: GetItemDraft,
    context: ApplicationContext,
  ): Promise<Result<AuthoringItemView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(query.itemId);
    if (!found.ok) return err(fromContent(found.error));

    const owns = authorizeDraftAccess(latestVersionOf(found.value).authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    return ok(toAuthoringItemView(found.value));
  }
}

export interface AuthoringItemPage {
  readonly items: readonly AuthoringItemView[];
}

/**
 * Wraps its result in `{ items }` — matching `AuthoringItemPage` in
 * `content.yaml` exactly — rather than returning a bare array. Found as a
 * real divergence while wiring M0-19 (Studio's Item Browser): the wire
 * response was a raw array, undetected because no client had ever validated
 * it against the generated schema until now. Fixed here rather than in the
 * document, per D18 — the document is the artifact Zod is generated from and
 * compared byte for byte against.
 */
export class ListMyDraftsHandler implements Handler<ListMyDrafts, AuthoringItemPage> {
  readonly name = 'ListMyDrafts';
  readonly policy = LIST_MY_DRAFTS_POLICY;

  constructor(private readonly deps: AuthoringQueryDependencies) {}

  async handle(
    query: ListMyDrafts,
    context: ApplicationContext,
  ): Promise<Result<AuthoringItemPage, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    // Asking for somebody else's drafts is refused rather than silently
    // narrowed to your own: a list that quietly answers a different question
    // is how an author concludes a colleague has written nothing.
    const owns = authorizeDraftAccess(query.authorId, context);
    if (!owns.ok) return err(owns.error);

    const found = await this.deps.items.findDraftsByAuthor(query.authorId);
    if (!found.ok) return err(fromContent(found.error));

    return ok({ items: Object.freeze(found.value.map(toAuthoringItemView)) });
  }
}

export class GetItemVersionForAuthoringHandler
  implements Handler<GetItemVersionForAuthoring, AuthoringItemVersionView>
{
  readonly name = 'GetItemVersionForAuthoring';
  readonly policy = GET_ITEM_VERSION_FOR_AUTHORING_POLICY;

  constructor(private readonly deps: AuthoringQueryDependencies) {}

  async handle(
    query: GetItemVersionForAuthoring,
    context: ApplicationContext,
  ): Promise<Result<AuthoringItemVersionView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(query.itemId);
    if (!found.ok) return err(fromContent(found.error));

    const version = found.value.versions.find(
      (candidate) => candidate.versionId === query.itemVersionId,
    );
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `item ${query.itemId} holds no version ${query.itemVersionId}`,
          'itemVersionId',
        ),
      );
    }

    const owns = authorizeDraftAccess(version.authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    return ok(toAuthoringVersionView(version));
  }
}

export class GetValidationFindingsHandler implements Handler<GetValidationFindings, ValidationReport> {
  readonly name = 'GetValidationFindings';
  readonly policy = GET_VALIDATION_FINDINGS_POLICY;

  constructor(private readonly deps: AuthoringQueryDependencies) {}

  async handle(
    query: GetValidationFindings,
    context: ApplicationContext,
  ): Promise<Result<ValidationReport, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(query.itemId);
    if (!found.ok) return err(fromContent(found.error));

    const version = latestVersionOf(found.value);
    const owns = authorizeDraftAccess(version.authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    const solution = await this.deps.solutions.findPublishedForItemVersion(version.versionId);
    const verdict = await this.deps.renderer.validate(version);

    return ok(
      validateDraft(version, {
        answerSpecificationAccepted: isKeyAcceptedByExecutor(version.responseSpec),
        // "Exists" reads as *published*, because that is the solution the item
        // can actually be published against. A draft explanation nobody has
        // approved would report the gap as closed while INV-08 still blocks.
        solutionExists: solution.ok,
        analysedDistractorOptionIds: solution.ok
          ? solution.value.distractorAnalyses.map((analysis) => analysis.optionId)
          : [],
        renderFailures: verdict.failures,
        // Curriculum exposes no concept→subject-domain lookup through its
        // barrel, so scope drift cannot be detected here yet (debt D23). An
        // empty list is honest: nothing was found because nothing was checked.
        outOfScopeConceptIds: [],
        duplicateCheckState: 'not_evaluated',
        asOf: this.deps.clock.now().toISOString(),
      }),
    );
  }
}

export class ListMediaAssetsHandler implements Handler<ListMediaAssets, readonly AuthoringMediaAssetView[]> {
  readonly name = 'ListMediaAssets';
  readonly policy = LIST_MEDIA_ASSETS_POLICY;

  constructor(private readonly deps: AuthoringQueryDependencies) {}

  async handle(
    _query: ListMediaAssets,
    context: ApplicationContext,
  ): Promise<Result<readonly AuthoringMediaAssetView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assets.list();
    if (!found.ok) return err(fromContent(found.error));

    return ok(
      Object.freeze(
        found.value.map((asset) => {
          const version = latestMediaVersionOf(asset);
          const described = accessibleDescriptionOf(version);
          return Object.freeze({
            assetId: asset.assetId,
            assetType: asset.assetType,
            lifecycleState: asset.lifecycleState,
            latestVersionId: version.versionId,
            storageKey: version.storageKey,
            mimeType: version.mimeType,
            width: version.width,
            height: version.height,
            altText: described.altText,
            ...(described.longDescription === undefined
              ? {}
              : { longDescription: described.longDescription }),
          });
        }),
      ),
    );
  }
}

/** Re-exported so the Studio's distractor prompt reads the same gap list. */
export { unanalysedDistractors };
