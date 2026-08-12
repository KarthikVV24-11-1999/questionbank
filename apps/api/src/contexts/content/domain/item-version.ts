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
  | 'STIMULUS_VERSION_REF_BLANK';

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

/** Whether this version pins a stimulus, and which version of it. */
export function stimulusVersionOf(version: ItemVersion): string | undefined {
  return version.stimulusVersionRef;
}
