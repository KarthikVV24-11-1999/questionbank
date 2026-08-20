import { err, ok, type Result } from './result.js';
import { conflictError, ruleViolationError, validationError, type ContentError } from './content-error.js';
import {
  applyTransition,
  isDeletable,
  type LifecycleState,
  type LifecycleTransition,
} from './item-lifecycle.js';
import type { ItemVersion } from './item-version.js';
import type { ItemType } from './response-specification.js';

/**
 * `Item` — a question's permanent identity and its governed history
 * (DOMAIN-MODEL §5, D1). **The most consequential aggregate in the system.**
 *
 * The identity is tiny and permanent; versions are immutable snapshots hanging
 * off it. That single split is what makes INV-03, INV-04 and score
 * reproducibility fall out rather than needing enforcement.
 *
 * **At most one published version at a time.** Publishing a second supersedes
 * the first, in one operation — there is no window in which two versions are
 * both current and no way to end up with none while intending to swap.
 *
 * **`itemType` is fixed at creation.** Changing it would invalidate the
 * response specification and every key derived from it, and would silently
 * re-interpret the attempts already scored under it.
 *
 * Transitions are the only way the state moves, and every transition the
 * machine does not name is refused. Publication additionally has preconditions,
 * which live in M3-11 and are supplied here as a checked fact — the aggregate
 * refuses to publish without them rather than trusting a caller who says it is
 * fine.
 */

export interface Item {
  readonly itemId: string;
  readonly itemType: ItemType;
  readonly lifecycleState: LifecycleState;
  readonly currentPublishedVersionId?: string;
  readonly versions: readonly ItemVersion[];
  readonly retirementReason?: string;
  readonly replacedByItemId?: string;
  readonly aggregateVersion: number;
  /**
   * When the item entered `lifecycleState` (M4-13) — the review queue's
   * ageing clock (DEC-M4-1). **Optional here, never optional in storage**:
   * `content.item.state_entered_at` is `NOT NULL`, but every constructor
   * below accepts it as an optional, supplied fact rather than a required
   * one, so M3's own call sites — which never pass it — construct exactly
   * the `Item` they always did. The repository is what always supplies it
   * for a real row (M4-13's own infrastructure change); a domain-only test
   * that never mentions review timing does not have to start mentioning it.
   */
  readonly stateEnteredAt?: string;
  /**
   * The routing key a subject-scoped queue needs (M4-14, DEC-M4-8). **Optional
   * here for the same reason `stateEnteredAt` is**: `content.item.authoring_subject`
   * is `NOT NULL` in storage, but every M3 call site that never mentions a
   * subject constructs exactly the `Item` it always did.
   *
   * **D23, restated.** This is *resolved* at creation from the principal's
   * subject scope where that is unambiguous (`resolveAuthoringSubject`,
   * `application/authorization.ts`) — an in-scope author cannot mistype their
   * own subject the way a purely declared value could be. It is not
   * cross-checked against the content itself: nothing in this model records
   * the subject of a passage or a stem, and `curriculum/public/` exposes no
   * concept → subject-domain lookup. An author scoped to more than one
   * subject, or unscoped (Content Ops), still declares it and nothing here
   * catches a mistagging of *their own* in-scope work. D23 stays open for
   * that half, with its trigger unchanged: Curriculum exposing a concept →
   * subject lookup.
   */
  readonly authoringSubject?: string;
}

export type ItemErrorCode =
  | 'ITEM_ID_REQUIRED'
  | 'ITEM_TYPE_REQUIRED'
  | 'VERSIONS_REQUIRED'
  | 'VERSION_TYPE_MISMATCH'
  | 'VERSION_NUMBERS_NOT_CONTIGUOUS'
  | 'VERSION_ID_DUPLICATE'
  | 'PUBLISHED_VERSION_UNKNOWN'
  | 'PUBLISHED_VERSION_REQUIRED'
  | 'VERSION_NOT_FOUND'
  | 'PUBLICATION_NOT_PERMITTED'
  | 'RETIREMENT_REASON_REQUIRED'
  | 'REPLACEMENT_IS_SELF'
  | 'ITEM_NOT_DELETABLE'
  | 'VERSION_NOT_EDITABLE'
  | 'STATE_ENTERED_AT_NOT_A_TIMESTAMP'
  | 'AUTHORING_SUBJECT_BLANK';

export type ItemError = ContentError<ItemErrorCode>;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function checkStateEnteredAt(stateEnteredAt: string | undefined, location: string): ItemError | undefined {
  if (stateEnteredAt === undefined) return undefined;
  if (!ISO_INSTANT.test(stateEnteredAt)) {
    return validationError(
      'STATE_ENTERED_AT_NOT_A_TIMESTAMP',
      `stateEnteredAt "${stateEnteredAt}" is not an ISO-8601 instant`,
      location,
    );
  }
  return undefined;
}

function checkAuthoringSubject(authoringSubject: string | undefined, location: string): ItemError | undefined {
  if (authoringSubject === undefined) return undefined;
  if (isBlank(authoringSubject)) {
    return validationError('AUTHORING_SUBJECT_BLANK', 'authoringSubject, if supplied, is not blank', location);
  }
  return undefined;
}

export interface CreateItemProps {
  readonly itemId: string;
  readonly itemType: ItemType;
  readonly initialVersion: ItemVersion;
  /** Supplied by the handler from the clock port (M4-13) — the domain stays clock-free. */
  readonly stateEnteredAt?: string;
  /** Resolved by the handler (M4-14) — the domain does not know a principal's scope. */
  readonly authoringSubject?: string;
}

/** A new item is always a draft holding exactly one version. */
export function createItem(
  props: CreateItemProps,
  location = 'item',
): Result<Item, ItemError> {
  if (isBlank(props.itemId)) {
    return err(validationError('ITEM_ID_REQUIRED', 'an item requires an itemId', location));
  }
  if (isBlank(props.itemType)) {
    return err(validationError('ITEM_TYPE_REQUIRED', 'an item requires an itemType', location));
  }
  if (props.initialVersion.itemType !== props.itemType) {
    return err(
      validationError(
        'VERSION_TYPE_MISMATCH',
        `the item is typed ${props.itemType} but its first version is ${props.initialVersion.itemType}`,
        location,
      ),
    );
  }
  if (props.initialVersion.versionNo !== 1) {
    return err(
      validationError(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `a new item starts at version 1, got ${props.initialVersion.versionNo}`,
        location,
      ),
    );
  }
  const stateEnteredAtError = checkStateEnteredAt(props.stateEnteredAt, `${location}.stateEnteredAt`);
  if (stateEnteredAtError !== undefined) return err(stateEnteredAtError);
  const authoringSubjectError = checkAuthoringSubject(props.authoringSubject, `${location}.authoringSubject`);
  if (authoringSubjectError !== undefined) return err(authoringSubjectError);

  return ok(
    Object.freeze({
      itemId: props.itemId,
      itemType: props.itemType,
      lifecycleState: 'draft' as LifecycleState,
      versions: Object.freeze([props.initialVersion]),
      aggregateVersion: 1,
      ...(props.stateEnteredAt === undefined ? {} : { stateEnteredAt: props.stateEnteredAt }),
      ...(props.authoringSubject === undefined ? {} : { authoringSubject: props.authoringSubject }),
    }),
  );
}

/**
 * Reconstitution from storage. Separate from `createItem` because a stored
 * item may legitimately be in any state, and the invariants that must still
 * hold are the structural ones rather than "this is new".
 */
export interface ReconstituteItemProps {
  readonly itemId: string;
  readonly itemType: ItemType;
  readonly lifecycleState: LifecycleState;
  readonly versions: readonly ItemVersion[];
  readonly currentPublishedVersionId?: string;
  readonly retirementReason?: string;
  readonly replacedByItemId?: string;
  readonly aggregateVersion: number;
  readonly stateEnteredAt?: string;
  readonly authoringSubject?: string;
}

export function reconstituteItem(
  props: ReconstituteItemProps,
  location = 'item',
): Result<Item, ItemError> {
  if (isBlank(props.itemId)) {
    return err(validationError('ITEM_ID_REQUIRED', 'an item requires an itemId', location));
  }
  if (props.versions.length === 0) {
    return err(validationError('VERSIONS_REQUIRED', 'an item holds at least one version', location));
  }

  const seen = new Set<string>();
  for (const version of props.versions) {
    if (seen.has(version.versionId)) {
      return err(
        validationError('VERSION_ID_DUPLICATE', `version ${version.versionId} appears twice`, location),
      );
    }
    seen.add(version.versionId);
    if (version.itemType !== props.itemType) {
      return err(
        validationError(
          'VERSION_TYPE_MISMATCH',
          `version ${version.versionId} is typed ${version.itemType}, the item is ${props.itemType}`,
          location,
        ),
      );
    }
  }

  const numbers = props.versions.map((version) => version.versionNo).sort((a, b) => a - b);
  for (const [index, number] of numbers.entries()) {
    if (number !== index + 1) {
      return err(
        validationError(
          'VERSION_NUMBERS_NOT_CONTIGUOUS',
          `version numbers must run contiguously from 1, got ${numbers.join(', ')}`,
          location,
        ),
      );
    }
  }

  if (
    props.currentPublishedVersionId !== undefined &&
    !props.versions.some((version) => version.versionId === props.currentPublishedVersionId)
  ) {
    return err(
      validationError(
        'PUBLISHED_VERSION_UNKNOWN',
        `the published version ${props.currentPublishedVersionId} is not among this item's versions`,
        location,
      ),
    );
  }

  // A published or suspended item names the version students see (or saw). An
  // item claiming either state with nothing published is a record no query can
  // answer correctly.
  if (
    (props.lifecycleState === 'published' || props.lifecycleState === 'suspended') &&
    props.currentPublishedVersionId === undefined
  ) {
    return err(
      validationError(
        'PUBLISHED_VERSION_REQUIRED',
        `a ${props.lifecycleState} item names the version that was published`,
        location,
      ),
    );
  }

  const stateEnteredAtError = checkStateEnteredAt(props.stateEnteredAt, `${location}.stateEnteredAt`);
  if (stateEnteredAtError !== undefined) return err(stateEnteredAtError);
  const authoringSubjectError = checkAuthoringSubject(props.authoringSubject, `${location}.authoringSubject`);
  if (authoringSubjectError !== undefined) return err(authoringSubjectError);

  return ok(
    Object.freeze({
      itemId: props.itemId,
      itemType: props.itemType,
      lifecycleState: props.lifecycleState,
      versions: Object.freeze([...props.versions]),
      aggregateVersion: props.aggregateVersion,
      ...(props.currentPublishedVersionId === undefined
        ? {}
        : { currentPublishedVersionId: props.currentPublishedVersionId }),
      ...(props.retirementReason === undefined ? {} : { retirementReason: props.retirementReason }),
      ...(props.replacedByItemId === undefined ? {} : { replacedByItemId: props.replacedByItemId }),
      ...(props.stateEnteredAt === undefined ? {} : { stateEnteredAt: props.stateEnteredAt }),
      ...(props.authoringSubject === undefined ? {} : { authoringSubject: props.authoringSubject }),
    }),
  );
}

/**
 * Adds a derived version. Only while the item is editable — a version added to
 * an item under review would change what the reviewer is looking at
 * (FR-TCH-08 rule 1).
 */
export function addVersion(item: Item, version: ItemVersion): Result<Item, ItemError> {
  if (!isEditable(item.lifecycleState)) {
    return err(
      ruleViolationError(
        'VERSION_NOT_EDITABLE',
        `an item that is ${item.lifecycleState} does not accept a new version`,
        'versions',
      ),
    );
  }
  if (version.itemType !== item.itemType) {
    return err(
      validationError(
        'VERSION_TYPE_MISMATCH',
        `the item is typed ${item.itemType} but the new version is ${version.itemType}`,
        'versions',
      ),
    );
  }
  if (item.versions.some((existing) => existing.versionId === version.versionId)) {
    return err(conflictError('VERSION_ID_DUPLICATE', `version ${version.versionId} already exists`, 'versions'));
  }
  if (version.versionNo !== item.versions.length + 1) {
    return err(
      validationError(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `the next version is ${item.versions.length + 1}, got ${version.versionNo}`,
        'versions',
      ),
    );
  }

  return ok(
    Object.freeze({
      ...item,
      versions: Object.freeze([...item.versions, version]),
      aggregateVersion: item.aggregateVersion + 1,
    }),
  );
}

/**
 * Replaces a draft version's content in place — what autosave does
 * (FR-TCH-02 rule 6).
 *
 * **This is not `addVersion`.** An autosave every few seconds that appended a
 * version would make the history unreadable and leave a reviewer nothing to
 * diff against; a *revision* after review returns the item is the case that
 * earns a new version (FR-TCH-09 rule 1), and that is `deriveDraft` plus
 * `addVersion`.
 *
 * The published version is excluded explicitly rather than relying on the
 * state check: an item can be `published` and hold a later draft, and INV-03
 * says the published snapshot never changes whatever else is true of the item.
 */
export function replaceDraftVersion(item: Item, version: ItemVersion): Result<Item, ItemError> {
  if (!isEditable(item.lifecycleState)) {
    return err(
      ruleViolationError(
        'VERSION_NOT_EDITABLE',
        `an item that is ${item.lifecycleState} is locked against author edits (FR-TCH-08 rule 1)`,
        'lifecycleState',
      ),
    );
  }
  if (version.versionId === item.currentPublishedVersionId) {
    return err(
      ruleViolationError(
        'VERSION_NOT_EDITABLE',
        `version ${version.versionId} is published and never changes (INV-03)`,
        'versions',
      ),
    );
  }

  const existing = item.versions.find((candidate) => candidate.versionId === version.versionId);
  if (existing === undefined) {
    return err(
      validationError(
        'VERSION_NOT_FOUND',
        `version ${version.versionId} is not among this item's versions`,
        'versions',
      ),
    );
  }
  if (version.itemType !== item.itemType) {
    return err(
      validationError(
        'VERSION_TYPE_MISMATCH',
        `the item is typed ${item.itemType} but the replacement is ${version.itemType}`,
        'versions',
      ),
    );
  }
  if (version.versionNo !== existing.versionNo) {
    return err(
      validationError(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `version ${version.versionId} is number ${existing.versionNo}, the replacement claims ${version.versionNo}`,
        'versions',
      ),
    );
  }

  return ok(
    Object.freeze({
      ...item,
      versions: Object.freeze(
        item.versions.map((candidate) => (candidate.versionId === version.versionId ? version : candidate)),
      ),
      aggregateVersion: item.aggregateVersion + 1,
    }),
  );
}

/** States in which an author may still change the content. */
export function isEditable(state: LifecycleState): boolean {
  return state === 'draft' || state === 'changes_requested' || state === 'rejected';
}

export interface TransitionProps {
  readonly transition: LifecycleTransition;
  /** Required by `retire` (FR-QM-07 rule 3). */
  readonly retirementReason?: string;
  readonly replacedByItemId?: string;
  /** Supplied by the handler from the clock port (M4-13) — set on every transition, when supplied. */
  readonly stateEnteredAt?: string;
}

/**
 * Every state change except publication, which needs preconditions and
 * therefore has its own entry point.
 */
export function transitionItem(item: Item, props: TransitionProps): Result<Item, ItemError | ContentError> {
  if (props.transition === 'publish') {
    return err(
      ruleViolationError(
        'PUBLICATION_NOT_PERMITTED',
        'publication goes through publishVersion, which checks its preconditions',
        'lifecycleState',
      ),
    );
  }

  const next = applyTransition(item.lifecycleState, props.transition);
  if (!next.ok) return err(next.error);

  const stateEnteredAtError = checkStateEnteredAt(props.stateEnteredAt, 'stateEnteredAt');
  if (stateEnteredAtError !== undefined) return err(stateEnteredAtError);

  if (props.transition === 'retire') {
    if (props.retirementReason === undefined || isBlank(props.retirementReason)) {
      return err(
        validationError(
          'RETIREMENT_REASON_REQUIRED',
          'retirement requires a categorized reason (FR-QM-07 rule 3)',
          'retirementReason',
        ),
      );
    }
    if (props.replacedByItemId !== undefined && props.replacedByItemId === item.itemId) {
      return err(
        validationError('REPLACEMENT_IS_SELF', 'an item cannot replace itself', 'replacedByItemId'),
      );
    }
  }

  return ok(
    Object.freeze({
      ...item,
      lifecycleState: next.value,
      aggregateVersion: item.aggregateVersion + 1,
      ...(props.transition === 'retire' && props.retirementReason !== undefined
        ? { retirementReason: props.retirementReason }
        : {}),
      ...(props.transition === 'retire' && props.replacedByItemId !== undefined
        ? { replacedByItemId: props.replacedByItemId }
        : {}),
      ...(props.stateEnteredAt === undefined ? {} : { stateEnteredAt: props.stateEnteredAt }),
    }),
  );
}

export interface PublishVersionProps {
  readonly versionId: string;
  /**
   * The verdict from M3-11. The aggregate does not evaluate preconditions
   * itself — it refuses to publish without a satisfied one, which is a
   * different and much harder thing to bypass.
   */
  readonly preconditionsSatisfied: boolean;
  /** Supplied by the handler from the clock port (M4-13) — publication is a transition too. */
  readonly stateEnteredAt?: string;
}

/**
 * Publishes a version, superseding whatever was published before.
 *
 * One operation, so there is never a window with two current versions and no
 * way to end up with none while intending to swap.
 */
export function publishVersion(item: Item, props: PublishVersionProps): Result<Item, ItemError | ContentError> {
  const next = applyTransition(item.lifecycleState, 'publish');
  if (!next.ok) return err(next.error);

  if (!item.versions.some((version) => version.versionId === props.versionId)) {
    return err(
      validationError(
        'VERSION_NOT_FOUND',
        `version ${props.versionId} is not among this item's versions`,
        'versions',
      ),
    );
  }

  if (!props.preconditionsSatisfied) {
    return err(
      ruleViolationError(
        'PUBLICATION_NOT_PERMITTED',
        'the publication preconditions are not satisfied (INV-07)',
        'lifecycleState',
      ),
    );
  }

  const stateEnteredAtError = checkStateEnteredAt(props.stateEnteredAt, 'stateEnteredAt');
  if (stateEnteredAtError !== undefined) return err(stateEnteredAtError);

  return ok(
    Object.freeze({
      ...item,
      lifecycleState: next.value,
      currentPublishedVersionId: props.versionId,
      aggregateVersion: item.aggregateVersion + 1,
      ...(props.stateEnteredAt === undefined ? {} : { stateEnteredAt: props.stateEnteredAt }),
    }),
  );
}

/** The version students see, if any. */
export function publishedVersionOf(item: Item): ItemVersion | undefined {
  return item.currentPublishedVersionId === undefined
    ? undefined
    : item.versions.find((version) => version.versionId === item.currentPublishedVersionId);
}

/** The most recent version, published or not — what the editor opens. */
export function latestVersionOf(item: Item): ItemVersion {
  return item.versions.reduce((latest, version) =>
    version.versionNo > latest.versionNo ? version : latest,
  );
}

/**
 * Whether this item may be discarded outright. Only a draft, and only one that
 * has never been published — the state machine already guarantees the second,
 * but a caller reading this function should not have to know that.
 */
export function checkDeletable(item: Item): Result<true, ItemError> {
  return isDeletable(item.lifecycleState) && item.currentPublishedVersionId === undefined
    ? ok(true)
    : err(
        ruleViolationError(
          'ITEM_NOT_DELETABLE',
          `an item that is ${item.lifecycleState} is withdrawn or retired, never deleted (FR-QM-01 rule 5)`,
          'lifecycleState',
        ),
      );
}
