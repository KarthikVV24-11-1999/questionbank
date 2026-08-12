import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';

/**
 * `TaxonomyTag` — what an item is about (DOMAIN-MODEL §5).
 *
 * **Every tag names a `taxonomyVersionId`.** FR-TCH-05 rule 1 says tags bind to
 * a specific taxonomy version, and that is not bookkeeping: a tag naming only a
 * concept is uninterpretable the moment the syllabus is revised, and FR-QM-13's
 * migration has nothing to map *from*. A tag without a version cannot be
 * constructed here, so the migration path stays possible by construction rather
 * than by everyone remembering.
 *
 * **A tag set spans exactly one taxonomy version.** Two versions in one set
 * means half the item migrates and half does not, and nothing downstream can
 * say which taxonomy the item is tagged under. That is a `Validation` failure,
 * not a merge.
 *
 * Concept identities are carried as **values** (§9 rule 3, and the same choice
 * scoring made for the profile version). Content never joins to Curriculum's
 * tables; it holds the identifiers Curriculum issued.
 */

export interface TaxonomyTag {
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly weight: number;
  readonly isPrimary: boolean;
}

export type TaxonomyTagErrorCode =
  | 'CONCEPT_IDENTITY_REQUIRED'
  | 'TAXONOMY_VERSION_REQUIRED'
  | 'WEIGHT_OUT_OF_RANGE'
  | 'TAGS_REQUIRED'
  | 'PRIMARY_TAG_REQUIRED'
  | 'PRIMARY_TAG_AMBIGUOUS'
  | 'CONCEPT_DUPLICATED'
  | 'TAXONOMY_VERSION_MIXED';

export type TaxonomyTagError = ContentError<TaxonomyTagErrorCode>;

export interface CreateTaxonomyTagProps {
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly weight: number;
  readonly isPrimary: boolean;
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: TaxonomyTagErrorCode, message: string, location: string): TaxonomyTagError {
  return validationError(code, message, location);
}

export function createTaxonomyTag(
  props: CreateTaxonomyTagProps,
  location = 'taxonomyTags',
): Result<TaxonomyTag, TaxonomyTagError> {
  if (isBlank(props.conceptIdentityId)) {
    return err(invalid('CONCEPT_IDENTITY_REQUIRED', 'a tag requires a conceptIdentityId', location));
  }
  if (isBlank(props.taxonomyVersionId)) {
    return err(
      invalid(
        'TAXONOMY_VERSION_REQUIRED',
        'a tag requires the taxonomyVersionId it was authored against — without one it cannot be migrated (FR-QM-13)',
        location,
      ),
    );
  }
  if (!Number.isFinite(props.weight) || props.weight < 0 || props.weight > 1) {
    return err(
      invalid('WEIGHT_OUT_OF_RANGE', `a tag weight must lie in [0, 1], got ${props.weight}`, location),
    );
  }

  return ok(Object.freeze({ ...props }));
}

/**
 * The tag set as it hangs off an `ItemVersion`. Validated as a whole because
 * every rule here is about the set, not about a member: one primary, no
 * repeats, one taxonomy version.
 */
export function createTaxonomyTagSet(
  props: readonly CreateTaxonomyTagProps[],
  location = 'taxonomyTags',
): Result<readonly TaxonomyTag[], TaxonomyTagError> {
  if (props.length === 0) {
    return err(
      invalid('TAGS_REQUIRED', 'an item requires at least one concept tag (FR-TCH-02 rule 4)', location),
    );
  }

  const tags: TaxonomyTag[] = [];
  for (const [index, candidate] of props.entries()) {
    const built = createTaxonomyTag(candidate, `${location}[${index}]`);
    if (!built.ok) return err(built.error);
    tags.push(built.value);
  }

  const seen = new Set<string>();
  for (const [index, tag] of tags.entries()) {
    if (seen.has(tag.conceptIdentityId)) {
      return err(
        invalid(
          'CONCEPT_DUPLICATED',
          `concept ${tag.conceptIdentityId} is tagged more than once`,
          `${location}[${index}]`,
        ),
      );
    }
    seen.add(tag.conceptIdentityId);
  }

  const versions = new Set(tags.map((tag) => tag.taxonomyVersionId));
  if (versions.size > 1) {
    return err(
      invalid(
        'TAXONOMY_VERSION_MIXED',
        `a tag set binds to one taxonomy version; found ${[...versions].sort().join(', ')}`,
        location,
      ),
    );
  }

  const primaries = tags.filter((tag) => tag.isPrimary);
  if (primaries.length === 0) {
    return err(
      invalid(
        'PRIMARY_TAG_REQUIRED',
        'exactly one tag must be primary — it is what coverage reporting and search ranking key on',
        location,
      ),
    );
  }
  if (primaries.length > 1) {
    return err(
      invalid('PRIMARY_TAG_AMBIGUOUS', `${primaries.length} tags claim to be primary; exactly one may`, location),
    );
  }

  return ok(Object.freeze(tags));
}

/** The single taxonomy version a validated set binds to. */
export function taxonomyVersionOf(tags: readonly TaxonomyTag[]): string | undefined {
  return tags[0]?.taxonomyVersionId;
}

export function primaryTagOf(tags: readonly TaxonomyTag[]): TaxonomyTag | undefined {
  return tags.find((tag) => tag.isPrimary);
}
