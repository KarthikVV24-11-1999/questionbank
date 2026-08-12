import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import { conflictError, ruleViolationError, validationError, type ContentError } from './content-error.js';
import type { ContentBody } from './content-body.js';
import {
  createLicensingStatus,
  UNRESOLVED_LICENSING,
  type CreateLicensingStatusProps,
  type LicensingStatus,
} from './licensing-status.js';
import { applyTransition, type LifecycleState, type LifecycleTransition } from './item-lifecycle.js';

/**
 * `Stimulus` — shared context referenced by many items (DOMAIN-MODEL §5).
 *
 * The document calls a `passage_text` column on the item *"the category's
 * canonical fatal error"*, and it is: pasting a passage into five items
 * produces five passages that diverge the first time one is corrected. A
 * stimulus is its own aggregate with its own lifecycle for that reason.
 *
 * **Editing a published stimulus creates a new version, and existing item
 * associations keep naming the version they were authored against**
 * (FR-TCH-03 rule 2). This is the whole point of the aggregate. An item sat by
 * a candidate must still ask what it asked; migrating an association to a newer
 * passage is a deliberate act, not a side effect of somebody fixing a typo.
 *
 * **A stimulus may not be retired while published items reference it**
 * (FR-TCH-03 rule 3). The count arrives as a supplied fact — Content cannot
 * count its own references without a repository, and the domain does no I/O.
 *
 * The lifecycle is `Item`'s, unchanged. A second state machine that differed
 * by accident is exactly the kind of divergence a shared table prevents.
 */

export const STIMULUS_TYPES = ['passage', 'diagram', 'dataset', 'reaction_scheme'] as const;
export type StimulusType = (typeof STIMULUS_TYPES)[number];

export interface StimulusVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly body: ContentBody;
  readonly licensing: LicensingStatus;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export interface Stimulus {
  readonly stimulusId: string;
  readonly stimulusType: StimulusType;
  readonly lifecycleState: LifecycleState;
  readonly currentPublishedVersionId?: string;
  readonly versions: readonly StimulusVersion[];
  readonly retirementReason?: string;
  readonly aggregateVersion: number;
}

export type StimulusErrorCode =
  | 'STIMULUS_ID_REQUIRED'
  | 'STIMULUS_TYPE_UNKNOWN'
  | 'VERSION_ID_REQUIRED'
  | 'VERSION_NO_INVALID'
  | 'VERSIONS_REQUIRED'
  | 'VERSION_ID_DUPLICATE'
  | 'VERSION_NUMBERS_NOT_CONTIGUOUS'
  | 'PUBLISHED_VERSION_UNKNOWN'
  | 'PUBLISHED_VERSION_REQUIRED'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_EDITABLE'
  | 'AUTHORED_BY_REQUIRED'
  | 'CREATED_AT_NOT_A_TIMESTAMP'
  | 'RETIREMENT_REASON_REQUIRED'
  | 'STILL_REFERENCED';

export type StimulusError = ContentError<StimulusErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: StimulusErrorCode, message: string, location: string): StimulusError {
  return validationError(code, message, location);
}

export interface CreateStimulusVersionProps {
  readonly versionId: string;
  readonly versionNo: number;
  readonly body: ContentBody;
  readonly licensing?: CreateLicensingStatusProps;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export function createStimulusVersion(
  props: CreateStimulusVersionProps,
  location = 'stimulusVersion',
): Result<StimulusVersion, StimulusError | ContentError> {
  if (isBlank(props.versionId)) {
    return err(invalid('VERSION_ID_REQUIRED', 'a stimulus version requires a versionId', location));
  }
  if (!Number.isInteger(props.versionNo) || props.versionNo < 1) {
    return err(
      invalid('VERSION_NO_INVALID', `versionNo must be an integer >= 1, got ${props.versionNo}`, location),
    );
  }
  if (isBlank(props.authoredBy.id)) {
    return err(
      invalid('AUTHORED_BY_REQUIRED', 'every version records who authored it (INV-02)', `${location}.authoredBy`),
    );
  }
  if (!ISO_INSTANT.test(props.createdAt)) {
    return err(
      invalid(
        'CREATED_AT_NOT_A_TIMESTAMP',
        `createdAt "${props.createdAt}" is not an ISO-8601 instant`,
        `${location}.createdAt`,
      ),
    );
  }

  const licensing =
    props.licensing === undefined
      ? ok(UNRESOLVED_LICENSING)
      : createLicensingStatus(props.licensing, `${location}.licensing`);
  if (!licensing.ok) return err(licensing.error);

  return ok(
    Object.freeze({
      versionId: props.versionId,
      versionNo: props.versionNo,
      body: props.body,
      licensing: licensing.value,
      authoredBy: Object.freeze({
        ...props.authoredBy,
        roleContext: Object.freeze([...props.authoredBy.roleContext]),
      }),
      createdAt: props.createdAt,
    }),
  );
}

export interface CreateStimulusProps {
  readonly stimulusId: string;
  readonly stimulusType: StimulusType;
  readonly initialVersion: StimulusVersion;
}

export function createStimulus(
  props: CreateStimulusProps,
  location = 'stimulus',
): Result<Stimulus, StimulusError> {
  if (isBlank(props.stimulusId)) {
    return err(invalid('STIMULUS_ID_REQUIRED', 'a stimulus requires a stimulusId', location));
  }
  if (!(STIMULUS_TYPES as readonly string[]).includes(props.stimulusType)) {
    return err(
      invalid('STIMULUS_TYPE_UNKNOWN', `unknown stimulus type "${props.stimulusType}"`, location),
    );
  }
  if (props.initialVersion.versionNo !== 1) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `a new stimulus starts at version 1, got ${props.initialVersion.versionNo}`,
        location,
      ),
    );
  }

  return ok(
    Object.freeze({
      stimulusId: props.stimulusId,
      stimulusType: props.stimulusType,
      lifecycleState: 'draft' as LifecycleState,
      versions: Object.freeze([props.initialVersion]),
      aggregateVersion: 1,
    }),
  );
}

export interface ReconstituteStimulusProps {
  readonly stimulusId: string;
  readonly stimulusType: StimulusType;
  readonly lifecycleState: LifecycleState;
  readonly versions: readonly StimulusVersion[];
  readonly currentPublishedVersionId?: string;
  readonly retirementReason?: string;
  readonly aggregateVersion: number;
}

export function reconstituteStimulus(
  props: ReconstituteStimulusProps,
  location = 'stimulus',
): Result<Stimulus, StimulusError> {
  if (isBlank(props.stimulusId)) {
    return err(invalid('STIMULUS_ID_REQUIRED', 'a stimulus requires a stimulusId', location));
  }
  if (props.versions.length === 0) {
    return err(invalid('VERSIONS_REQUIRED', 'a stimulus holds at least one version', location));
  }

  const seen = new Set<string>();
  for (const version of props.versions) {
    if (seen.has(version.versionId)) {
      return err(invalid('VERSION_ID_DUPLICATE', `version ${version.versionId} appears twice`, location));
    }
    seen.add(version.versionId);
  }

  const numbers = props.versions.map((version) => version.versionNo).sort((a, b) => a - b);
  for (const [index, number] of numbers.entries()) {
    if (number !== index + 1) {
      return err(
        invalid(
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
      invalid(
        'PUBLISHED_VERSION_UNKNOWN',
        `the published version ${props.currentPublishedVersionId} is not among this stimulus's versions`,
        location,
      ),
    );
  }

  if (
    (props.lifecycleState === 'published' || props.lifecycleState === 'suspended') &&
    props.currentPublishedVersionId === undefined
  ) {
    return err(
      invalid(
        'PUBLISHED_VERSION_REQUIRED',
        `a ${props.lifecycleState} stimulus names the version that was published`,
        location,
      ),
    );
  }

  return ok(
    Object.freeze({
      stimulusId: props.stimulusId,
      stimulusType: props.stimulusType,
      lifecycleState: props.lifecycleState,
      versions: Object.freeze([...props.versions]),
      aggregateVersion: props.aggregateVersion,
      ...(props.currentPublishedVersionId === undefined
        ? {}
        : { currentPublishedVersionId: props.currentPublishedVersionId }),
      ...(props.retirementReason === undefined ? {} : { retirementReason: props.retirementReason }),
    }),
  );
}

/**
 * Adds a version. **Permitted while published**, unlike an item: editing a
 * published passage is the ordinary case (a typo, a clarification), and
 * FR-TCH-03 rule 2 says the correct response is a new version that existing
 * associations do not follow. Refusing the edit would push authors back to
 * pasting the passage per item, which is the error the aggregate exists to
 * prevent.
 */
export function addStimulusVersion(
  stimulus: Stimulus,
  version: StimulusVersion,
): Result<Stimulus, StimulusError> {
  if (stimulus.lifecycleState === 'retired') {
    return err(
      ruleViolationError(
        'VERSION_NOT_EDITABLE',
        'a retired stimulus does not accept a new version',
        'versions',
      ),
    );
  }
  if (stimulus.versions.some((existing) => existing.versionId === version.versionId)) {
    return err(conflictError('VERSION_ID_DUPLICATE', `version ${version.versionId} already exists`, 'versions'));
  }
  if (version.versionNo !== stimulus.versions.length + 1) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `the next version is ${stimulus.versions.length + 1}, got ${version.versionNo}`,
        'versions',
      ),
    );
  }

  return ok(
    Object.freeze({
      ...stimulus,
      versions: Object.freeze([...stimulus.versions, version]),
      aggregateVersion: stimulus.aggregateVersion + 1,
    }),
  );
}

export interface StimulusTransitionProps {
  readonly transition: LifecycleTransition;
  readonly versionId?: string;
  readonly retirementReason?: string;
  /**
   * How many **published** items reference this stimulus, resolved by the
   * handler (M3-26). The domain does no I/O and cannot count for itself.
   */
  readonly referencingPublishedItemCount?: number;
}

export function transitionStimulus(
  stimulus: Stimulus,
  props: StimulusTransitionProps,
): Result<Stimulus, StimulusError | ContentError> {
  const next = applyTransition(stimulus.lifecycleState, props.transition);
  if (!next.ok) return err(next.error);

  if (props.transition === 'publish') {
    if (props.versionId === undefined || !stimulus.versions.some((v) => v.versionId === props.versionId)) {
      return err(
        invalid(
          'VERSION_NOT_FOUND',
          `publication names a version this stimulus holds; got "${props.versionId ?? 'none'}"`,
          'versions',
        ),
      );
    }
  }

  if (props.transition === 'retire') {
    if (props.retirementReason === undefined || isBlank(props.retirementReason)) {
      return err(
        invalid('RETIREMENT_REASON_REQUIRED', 'retirement requires a reason', 'retirementReason'),
      );
    }
    // FR-TCH-03 rule 3. Retiring a referenced stimulus would leave published
    // items pointing at content that is no longer supposed to circulate — and
    // the items would still render it, because they pin a version.
    const referencing = props.referencingPublishedItemCount;
    if (referencing === undefined) {
      return err(
        invalid(
          'STILL_REFERENCED',
          'retirement requires knowing how many published items reference this stimulus',
          'referencingPublishedItemCount',
        ),
      );
    }
    if (referencing > 0) {
      return err(
        ruleViolationError(
          'STILL_REFERENCED',
          `${referencing} published item(s) reference this stimulus; retire or re-point them first (FR-TCH-03 rule 3)`,
          'referencingPublishedItemCount',
        ),
      );
    }
  }

  return ok(
    Object.freeze({
      ...stimulus,
      lifecycleState: next.value,
      aggregateVersion: stimulus.aggregateVersion + 1,
      ...(props.transition === 'publish' && props.versionId !== undefined
        ? { currentPublishedVersionId: props.versionId }
        : {}),
      ...(props.transition === 'retire' && props.retirementReason !== undefined
        ? { retirementReason: props.retirementReason }
        : {}),
    }),
  );
}

export function publishedStimulusVersionOf(stimulus: Stimulus): StimulusVersion | undefined {
  return stimulus.currentPublishedVersionId === undefined
    ? undefined
    : stimulus.versions.find((version) => version.versionId === stimulus.currentPublishedVersionId);
}

export function latestStimulusVersionOf(stimulus: Stimulus): StimulusVersion {
  return stimulus.versions.reduce((latest, version) =>
    version.versionNo > latest.versionNo ? version : latest,
  );
}
