import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';
import type { ContentBody } from './content-body.js';
import { createTaxonomyTagSet, type CreateTaxonomyTagProps, type TaxonomyTag } from './taxonomy-tag.js';
import { createProvenance, type CreateProvenanceProps, type Provenance, type ProvenanceContext } from './provenance.js';
import {
  createLicensingStatus,
  UNRESOLVED_LICENSING,
  type CreateLicensingStatusProps,
  type LicensingStatus,
} from './licensing-status.js';
import {
  createResponseSpecification,
  type CreateResponseSpecificationProps,
  type ItemType,
  type ResponseSpecification,
} from './response-specification.js';
import { diffWithinScope, type EditScopeError } from './review/edit-scope.js';

/**
 * `ItemVersion` — the immutable snapshot of a question (DOMAIN-MODEL §5, D1).
 *
 * **Immutable, with no mutator to remove later.** INV-03 says published
 * versions never change; the version having no setter at all is what makes
 * that structural rather than a rule someone enforces. Editing produces a new
 * version through `deriveDraft`, which is also how INV-04 stays true — an
 * attempt pinned to version 3 can still be reproduced after version 4 exists.
 *
 * **`stimulusVersionRef` pins a stimulus *version*, not a stimulus**
 * (FR-TCH-03 rule 2). A shared passage edited under an item would silently
 * change what that item asked, including for attempts already sat against it.
 * Existing associations keep naming the version they were authored against
 * until somebody migrates them deliberately.
 *
 * **`createdAt` is supplied, never read from a clock here.** Same discipline as
 * scoring's (F45): a version whose identity depends on when the process
 * happened to run is not reproducible, and the repository round-trip test
 * would be asserting against a moving target.
 *
 * `localeVariants` is modeled at M3-16 and deliberately absent until then —
 * a field nothing populates is a field that acquires a wrong default.
 */

export interface ItemVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly itemType: ItemType;
  readonly stem: ContentBody;
  readonly responseSpec: ResponseSpecification;
  readonly taxonomyTags: readonly TaxonomyTag[];
  readonly difficultyEstimate: DifficultyBand;
  readonly provenance: Provenance;
  readonly licensing: LicensingStatus;
  readonly stimulusVersionRef?: string;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
  /**
   * Set only by `deriveReviewerEditedVersion` (M4-15, ADR-0018,
   * DEC-M4-3) — a reviewer's bounded edit under `approve_with_edits`.
   * `authoredBy` is never rewritten by an edit; this is the second,
   * distinct fact `isSelfReview` checks (`domain/review/self-review.ts`),
   * so a reviewer who edited a version cannot also be the one who signs it.
   */
  readonly editedBy?: PrincipalRef;
}

/**
 * The authored estimate.
 *
 * Bands rather than a number, because an author cannot honestly distinguish
 * 0.61 from 0.64 and a false precision here invites treating it as data. It is
 * **superseded by empirical difficulty** once exposure passes threshold
 * (FR-QM-09 rule 2), so it is a starting point for form assembly, not a claim.
 */
export const DIFFICULTY_BANDS = ['foundational', 'moderate', 'challenging', 'advanced'] as const;
export type DifficultyBand = (typeof DIFFICULTY_BANDS)[number];

export type ItemVersionErrorCode =
  | 'VERSION_ID_REQUIRED'
  | 'VERSION_NO_INVALID'
  | 'ITEM_TYPE_MISMATCH'
  | 'DIFFICULTY_BAND_UNKNOWN'
  | 'AUTHORED_BY_REQUIRED'
  | 'AUTHORED_BY_KIND_UNKNOWN'
  | 'CREATED_AT_NOT_A_TIMESTAMP'
  | 'STIMULUS_VERSION_REF_BLANK'
  | 'EDITED_BY_REQUIRED'
  | 'EDITED_BY_KIND_UNKNOWN';

export type ItemVersionError = ContentError<ItemVersionErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const PRINCIPAL_KINDS = ['human', 'ai_agent', 'system'] as const;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: ItemVersionErrorCode, message: string, location: string): ItemVersionError {
  return validationError(code, message, location);
}

export interface CreateItemVersionProps {
  readonly versionId: string;
  readonly versionNo: number;
  readonly itemType: ItemType;
  readonly stem: ContentBody;
  readonly responseSpec: CreateResponseSpecificationProps;
  readonly taxonomyTags: readonly CreateTaxonomyTagProps[];
  readonly difficultyEstimate: DifficultyBand;
  readonly provenance: CreateProvenanceProps;
  readonly licensing?: CreateLicensingStatusProps;
  readonly stimulusVersionRef?: string;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export function createItemVersion(
  props: CreateItemVersionProps,
  context: ProvenanceContext,
  location = 'version',
): Result<ItemVersion, ItemVersionError | ContentError> {
  if (isBlank(props.versionId)) {
    return err(invalid('VERSION_ID_REQUIRED', 'a version requires a versionId', location));
  }
  if (!Number.isInteger(props.versionNo) || props.versionNo < 1) {
    return err(
      invalid('VERSION_NO_INVALID', `versionNo must be an integer >= 1, got ${props.versionNo}`, location),
    );
  }

  // The item's type and its specification's type are the same fact recorded
  // twice; letting them differ would mean the key is scored under one type and
  // presented under another.
  if (props.responseSpec.itemType !== props.itemType) {
    return err(
      invalid(
        'ITEM_TYPE_MISMATCH',
        `the version is typed ${props.itemType} but its response specification is ${props.responseSpec.itemType}`,
        location,
      ),
    );
  }

  if (!(DIFFICULTY_BANDS as readonly string[]).includes(props.difficultyEstimate)) {
    return err(
      invalid(
        'DIFFICULTY_BAND_UNKNOWN',
        `unknown difficulty band "${props.difficultyEstimate}"`,
        `${location}.difficultyEstimate`,
      ),
    );
  }

  if (isBlank(props.authoredBy.id)) {
    return err(
      invalid('AUTHORED_BY_REQUIRED', 'every version records who authored it (INV-02)', `${location}.authoredBy`),
    );
  }
  if (!(PRINCIPAL_KINDS as readonly string[]).includes(props.authoredBy.kind)) {
    return err(
      invalid(
        'AUTHORED_BY_KIND_UNKNOWN',
        `unknown principal kind "${props.authoredBy.kind}"`,
        `${location}.authoredBy`,
      ),
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

  if (props.stimulusVersionRef !== undefined && isBlank(props.stimulusVersionRef)) {
    return err(
      invalid(
        'STIMULUS_VERSION_REF_BLANK',
        'a stimulus association names a stimulus version, or is absent',
        `${location}.stimulusVersionRef`,
      ),
    );
  }

  const responseSpec = createResponseSpecification(props.responseSpec, `${location}.responseSpec`);
  if (!responseSpec.ok) return err(responseSpec.error);

  const taxonomyTags = createTaxonomyTagSet(props.taxonomyTags, `${location}.taxonomyTags`);
  if (!taxonomyTags.ok) return err(taxonomyTags.error);

  const provenance = createProvenance(props.provenance, context, `${location}.provenance`);
  if (!provenance.ok) return err(provenance.error);

  // A draft that states nothing about rights states `unresolved`, which blocks
  // publication (FR-QM-05 rule 4). The permissive statement has to be made.
  const licensing =
    props.licensing === undefined
      ? ok(UNRESOLVED_LICENSING)
      : createLicensingStatus(props.licensing, `${location}.licensing`);
  if (!licensing.ok) return err(licensing.error);

  return ok(
    Object.freeze({
      versionId: props.versionId,
      versionNo: props.versionNo,
      itemType: props.itemType,
      stem: props.stem,
      responseSpec: responseSpec.value,
      taxonomyTags: taxonomyTags.value,
      difficultyEstimate: props.difficultyEstimate,
      provenance: provenance.value,
      licensing: licensing.value,
      ...(props.stimulusVersionRef === undefined ? {} : { stimulusVersionRef: props.stimulusVersionRef }),
      authoredBy: Object.freeze({
        ...props.authoredBy,
        roleContext: Object.freeze([...props.authoredBy.roleContext]),
      }),
      createdAt: props.createdAt,
    }),
  );
}

export interface DeriveDraftProps {
  readonly versionId: string;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

/**
 * The successor of an existing version — how an edit happens, since there is no
 * setter.
 *
 * Everything is carried forward: an edit that silently dropped tags, licensing
 * or provenance would produce a version that fails publication for reasons the
 * author never touched. The new version is a **new object**; the original is
 * returned unchanged, which is what INV-03 and INV-04 both rest on.
 *
 * `authoredBy` is the principal making *this* edit, not the original author —
 * the audit trail follows the change, not the lineage.
 */
export function deriveDraft(
  from: ItemVersion,
  props: DeriveDraftProps,
  location = 'version',
): Result<ItemVersion, ItemVersionError> {
  if (isBlank(props.versionId)) {
    return err(invalid('VERSION_ID_REQUIRED', 'a derived version requires its own versionId', location));
  }
  if (isBlank(props.authoredBy.id)) {
    return err(
      invalid('AUTHORED_BY_REQUIRED', 'every version records who authored it (INV-02)', `${location}.authoredBy`),
    );
  }
  if (!(PRINCIPAL_KINDS as readonly string[]).includes(props.authoredBy.kind)) {
    return err(
      invalid(
        'AUTHORED_BY_KIND_UNKNOWN',
        `unknown principal kind "${props.authoredBy.kind}"`,
        `${location}.authoredBy`,
      ),
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

  return ok(
    Object.freeze({
      ...from,
      versionId: props.versionId,
      versionNo: from.versionNo + 1,
      authoredBy: Object.freeze({
        ...props.authoredBy,
        roleContext: Object.freeze([...props.authoredBy.roleContext]),
      }),
      createdAt: props.createdAt,
    }),
  );
}

/**
 * Pins a stimulus **version** onto a draft version (FR-TCH-03 rule 2).
 *
 * The version being pinned is resolved by the handler at attachment time and
 * never re-resolved: an item that asked about a passage keeps asking about the
 * passage as it read then, whatever the author of that passage does afterwards.
 * Re-pointing is a deliberate act, which is why this takes an identifier rather
 * than a stimulus.
 */
export function pinStimulusVersion(
  version: ItemVersion,
  stimulusVersionId: string,
  location = 'version',
): Result<ItemVersion, ItemVersionError> {
  if (isBlank(stimulusVersionId)) {
    return err(
      invalid(
        'STIMULUS_VERSION_REF_BLANK',
        'an attachment names a stimulus version',
        `${location}.stimulusVersionRef`,
      ),
    );
  }
  return ok(Object.freeze({ ...version, stimulusVersionRef: stimulusVersionId }));
}

/** Whether this version pins a stimulus, and which version of it. */
export function stimulusVersionOf(version: ItemVersion): string | undefined {
  return version.stimulusVersionRef;
}

/**
 * The bounded reviewer edit under `approve_with_edits` (M4-15, ADR-0018,
 * DEC-M4-3). What separates this from `deriveDraft`: `authoredBy` is carried
 * over from `from`, **never** rewritten — the reviewer's contribution is
 * recorded as `editedBy`, a second, distinct fact. `authoredBy` answers
 * *whose subject-matter work is this*, and a reviewer fixing a typo does not
 * become the author.
 *
 * `edits` names only the fields DEC-M4-3 opens for this outcome; whichever of
 * them are actually supplied is checked against `edit-scope.ts`'s
 * `diffWithinScope` — the **same function** M4-08 built for exactly this, not
 * a second implementation of the bound. `responseSpec` is accepted here only
 * so a caller who supplies one is refused by name (`KEY_EDIT_REQUIRES_CHANGES_REQUESTED`);
 * `itemType` and `provenance` cannot be supplied at all — there is no
 * parameter for either, which is the closed part of the bound no runtime
 * check could add anything to.
 */
export interface ReviewerEdits {
  readonly stem?: ContentBody;
  readonly taxonomyTags?: readonly CreateTaxonomyTagProps[];
  readonly difficultyEstimate?: DifficultyBand;
  /** Never actually applied — present only so supplying one is refused by name, not silently ignored. */
  readonly responseSpec?: CreateResponseSpecificationProps;
}

export interface DeriveReviewerEditedVersionProps {
  readonly versionId: string;
  readonly editedBy: PrincipalRef;
  readonly createdAt: string;
  readonly edits: ReviewerEdits;
}

export function deriveReviewerEditedVersion(
  from: ItemVersion,
  props: DeriveReviewerEditedVersionProps,
  location = 'version',
): Result<ItemVersion, ItemVersionError | EditScopeError | ContentError> {
  if (isBlank(props.versionId)) {
    return err(invalid('VERSION_ID_REQUIRED', 'a derived version requires its own versionId', location));
  }
  if (isBlank(props.editedBy.id)) {
    return err(
      invalid('EDITED_BY_REQUIRED', 'a reviewer edit records who made it (INV-12)', `${location}.editedBy`),
    );
  }
  if (!(PRINCIPAL_KINDS as readonly string[]).includes(props.editedBy.kind)) {
    return err(
      invalid(
        'EDITED_BY_KIND_UNKNOWN',
        `unknown principal kind "${props.editedBy.kind}"`,
        `${location}.editedBy`,
      ),
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

  const changedFields = [
    ...(props.edits.stem !== undefined ? ['stem'] : []),
    ...(props.edits.taxonomyTags !== undefined ? ['taxonomyTags'] : []),
    ...(props.edits.difficultyEstimate !== undefined ? ['difficultyEstimate'] : []),
    ...(props.edits.responseSpec !== undefined ? ['responseSpec'] : []),
  ];
  const scoped = diffWithinScope(changedFields, `${location}.edits`);
  if (!scoped.ok) return err(scoped.error);

  let taxonomyTags = from.taxonomyTags;
  if (props.edits.taxonomyTags !== undefined) {
    const built = createTaxonomyTagSet(props.edits.taxonomyTags, `${location}.taxonomyTags`);
    if (!built.ok) return err(built.error);
    taxonomyTags = built.value;
  }

  return ok(
    Object.freeze({
      ...from,
      versionId: props.versionId,
      versionNo: from.versionNo + 1,
      taxonomyTags,
      ...(props.edits.stem === undefined ? {} : { stem: props.edits.stem }),
      ...(props.edits.difficultyEstimate === undefined ? {} : { difficultyEstimate: props.edits.difficultyEstimate }),
      editedBy: Object.freeze({
        ...props.editedBy,
        roleContext: Object.freeze([...props.editedBy.roleContext]),
      }),
      createdAt: props.createdAt,
    }),
  );
}
