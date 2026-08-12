import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';
import type { ContentBody } from './content-body.js';

/**
 * `LocaleVariant` — a translation of an item version (DOMAIN-MODEL §5,
 * FR-QM-11, EXT-04).
 *
 * **Modeled now, delivered in H1.** The point of modeling it early is that
 * localization must not require re-modeling: the shape below is what the item
 * version, the schema and the review workflow have to accommodate, and finding
 * that out in H1 would mean migrating a corpus.
 *
 * **A variant carries no correctness.** No key, no numeric specification, no
 * correct-option marker — the source version is authoritative (FR-QM-11
 * rule 1), and a translator is not re-adjudicating physics ([DECISIONS](../../../../../docs/DECISIONS.md)
 * D-005). This is enforced structurally: there is nowhere on the type to put a
 * key, and `locale-variant.spec.ts` scans this module for one. A translated
 * key would be a second answer to the same question, diverging silently the
 * first time either side is corrected.
 *
 * **A correctness change to the source invalidates every variant** (FR-QM-11
 * rule 3), computed here as a pure function over what changed. A translation
 * of a stem whose key has moved is a translation of a different question.
 *
 * **Nothing accepts one yet.** No command, handler, route or Studio surface
 * takes a variant this milestone, and the spec asserts it — so "modeled" does
 * not quietly become "half-shipped", which is the failure mode that leaves a
 * half-built feature to be discovered by a user.
 */

/**
 * Review state of a translation. Deliberately *not* the item lifecycle: a
 * translation is attested for fidelity, not adjudicated for correctness
 * (D-005), so it has three states rather than eight.
 */
export const VARIANT_REVIEW_STATES = ['draft', 'attested', 'invalidated'] as const;
export type VariantReviewState = (typeof VARIANT_REVIEW_STATES)[number];

/** An option's text in the target language. Identity comes from the source. */
export interface LocaleVariantOption {
  readonly optionId: string;
  readonly body: ContentBody;
}

export interface LocaleVariant {
  readonly locale: string;
  readonly sourceItemVersionId: string;
  readonly stem: ContentBody;
  readonly options: readonly LocaleVariantOption[];
  readonly translatedBy: PrincipalRef;
  readonly reviewState: VariantReviewState;
  readonly attestedBy?: PrincipalRef;
  readonly createdAt: string;
}

export type LocaleVariantErrorCode =
  | 'LOCALE_REQUIRED'
  | 'LOCALE_MALFORMED'
  | 'SOURCE_ITEM_VERSION_REQUIRED'
  | 'OPTION_ID_REQUIRED'
  | 'OPTION_ID_DUPLICATE'
  | 'OPTION_NOT_IN_SOURCE'
  | 'OPTION_MISSING_FROM_TRANSLATION'
  | 'TRANSLATED_BY_REQUIRED'
  | 'REVIEW_STATE_UNKNOWN'
  | 'ATTESTED_BY_REQUIRED'
  | 'ATTESTER_IS_TRANSLATOR'
  | 'CREATED_AT_NOT_A_TIMESTAMP';

export type LocaleVariantError = ContentError<LocaleVariantErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** BCP 47 language tags, loosely: `hi`, `hi-IN`, `bn-IN`. */
const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/u;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: LocaleVariantErrorCode, message: string, location: string): LocaleVariantError {
  return validationError(code, message, location);
}

export function isVariantReviewState(state: string): state is VariantReviewState {
  return (VARIANT_REVIEW_STATES as readonly string[]).includes(state);
}

export interface CreateLocaleVariantProps {
  readonly locale: string;
  readonly sourceItemVersionId: string;
  readonly stem: ContentBody;
  readonly options: readonly LocaleVariantOption[];
  readonly translatedBy: PrincipalRef;
  readonly reviewState?: VariantReviewState;
  readonly attestedBy?: PrincipalRef;
  readonly createdAt: string;
}

/**
 * @param sourceOptionIds the option identities the source version defines.
 *   A variant translates *those* options; inventing or dropping one changes
 *   what the question asks.
 */
export function createLocaleVariant(
  props: CreateLocaleVariantProps,
  sourceOptionIds: readonly string[],
  location = 'localeVariant',
): Result<LocaleVariant, LocaleVariantError> {
  if (isBlank(props.locale)) {
    return err(invalid('LOCALE_REQUIRED', 'a variant names the locale it translates into', location));
  }
  if (!LOCALE_TAG.test(props.locale)) {
    return err(
      invalid('LOCALE_MALFORMED', `"${props.locale}" is not a BCP 47 language tag`, `${location}.locale`),
    );
  }
  // FR-QM-11 rule 1: the variant attaches to a specific version, because the
  // source version is authoritative for correctness and a different version
  // may say something different.
  if (isBlank(props.sourceItemVersionId)) {
    return err(
      invalid(
        'SOURCE_ITEM_VERSION_REQUIRED',
        'a variant attaches to the item version it translates, which is authoritative for correctness',
        location,
      ),
    );
  }

  const seen = new Set<string>();
  for (const [index, option] of props.options.entries()) {
    const optionLocation = `${location}.options[${index}]`;
    if (isBlank(option.optionId)) {
      return err(invalid('OPTION_ID_REQUIRED', 'a translated option names the option it translates', optionLocation));
    }
    if (seen.has(option.optionId)) {
      return err(
        invalid('OPTION_ID_DUPLICATE', `option ${option.optionId} is translated twice`, optionLocation),
      );
    }
    seen.add(option.optionId);
    if (!sourceOptionIds.includes(option.optionId)) {
      return err(
        invalid(
          'OPTION_NOT_IN_SOURCE',
          `option ${option.optionId} does not exist on the source version; a variant translates options, it does not add them`,
          optionLocation,
        ),
      );
    }
  }

  // A partly translated item shows a learner some options in one language and
  // some in another, which is worse than showing none of it translated.
  const missing = sourceOptionIds.filter((optionId) => !seen.has(optionId));
  if (missing.length > 0) {
    return err(
      invalid(
        'OPTION_MISSING_FROM_TRANSLATION',
        `option(s) ${missing.join(', ')} are untranslated; a partial translation mixes languages within one question`,
        `${location}.options`,
      ),
    );
  }

  if (isBlank(props.translatedBy.id)) {
    return err(
      invalid('TRANSLATED_BY_REQUIRED', 'a variant records who translated it (INV-02)', `${location}.translatedBy`),
    );
  }

  const reviewState = props.reviewState ?? 'draft';
  if (!isVariantReviewState(reviewState)) {
    return err(
      invalid('REVIEW_STATE_UNKNOWN', `unknown review state "${reviewState}"`, `${location}.reviewState`),
    );
  }

  if (reviewState === 'attested') {
    if (props.attestedBy === undefined || isBlank(props.attestedBy.id)) {
      return err(
        invalid(
          'ATTESTED_BY_REQUIRED',
          'an attested variant records who attested to its fidelity (FR-QM-11 rule 2)',
          `${location}.attestedBy`,
        ),
      );
    }
    // The same prohibition as INV-12, for the same reason: an attestation the
    // translator gave themselves attests to nothing.
    if (props.attestedBy.id === props.translatedBy.id) {
      return err(
        invalid(
          'ATTESTER_IS_TRANSLATOR',
          'the translator cannot attest to their own translation',
          `${location}.attestedBy`,
        ),
      );
    }
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
      locale: props.locale,
      sourceItemVersionId: props.sourceItemVersionId,
      stem: props.stem,
      options: Object.freeze(props.options.map((option) => Object.freeze({ ...option }))),
      translatedBy: Object.freeze({
        ...props.translatedBy,
        roleContext: Object.freeze([...props.translatedBy.roleContext]),
      }),
      reviewState,
      ...(props.attestedBy === undefined
        ? {}
        : {
            attestedBy: Object.freeze({
              ...props.attestedBy,
              roleContext: Object.freeze([...props.attestedBy.roleContext]),
            }),
          }),
      createdAt: props.createdAt,
    }),
  );
}

/** What changed on the source version, as far as a translation is concerned. */
export interface SourceVersionChange {
  readonly newItemVersionId: string;
  /** The key, the numeric specification, or which option is correct moved. */
  readonly correctnessChanged: boolean;
}

/**
 * FR-QM-11 rule 3 — a correctness change to the source invalidates every
 * variant until re-reviewed.
 *
 * A translation of a stem whose key has moved is a translation of a different
 * question, and serving it would show a learner a question whose answer the
 * platform no longer agrees with. Pure: it returns new variants and leaves the
 * originals alone.
 */
export function applySourceVersionChange(
  variants: readonly LocaleVariant[],
  change: SourceVersionChange,
): readonly LocaleVariant[] {
  if (!change.correctnessChanged) return variants;

  return Object.freeze(
    variants.map((variant) => {
      const invalidated: LocaleVariant = {
        ...variant,
        reviewState: 'invalidated',
      };
      // An invalidated variant keeps who translated it and loses the
      // attestation, because the attestation was to a fidelity that no longer
      // means what it meant.
      delete (invalidated as { attestedBy?: PrincipalRef }).attestedBy;
      return Object.freeze(invalidated);
    }),
  );
}

/** Whether this variant may be served to a learner. */
export function isServable(variant: LocaleVariant): boolean {
  return variant.reviewState === 'attested';
}
