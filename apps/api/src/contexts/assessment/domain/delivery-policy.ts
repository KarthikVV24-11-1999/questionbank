import { validationError, type AssessmentError } from './assessment-error.js';
import { err, ok, type Result } from './result.js';
import { isNonBlank, isUuid } from './uuid.js';

/**
 * **`PracticePolicy`, and the one derivation of a `DeliveryPolicy`** (DOMAIN-MODEL D2, M7-26).
 *
 * An attempt pins a delivery policy when it is created, and the attempt's `is_timed` and `duration_ms` are read off the same derivation, so the
 * document and the columns that follow it cannot disagree. A mock's policy is derived from its `ExamProfileVersion`; a practice run's from the
 * `PracticePolicy` the learner (or Learning, for a remediation run) asked for. **This module is the only place either input shape is read.** The
 * attempt, the handlers and the database see the derived `DerivedDelivery` and nothing of where it came from.
 *
 * **`adaptive` is not offered.** The domain model marks it H1: it needs item statistics to choose by, and Psychometrics (context 6) does not
 * exist. A selection strategy joins the list the day something can honour it. Asking for it is refused under its own code, so a client built
 * ahead of it learns why rather than meeting "invalid" (DEC-M7-13).
 */
export const SELECTION_STRATEGIES = ['filtered', 'targeted', 'spaced_review'] as const;
export type SelectionStrategy = (typeof SELECTION_STRATEGIES)[number];

/**
 * The authored difficulty bands, as identifiers. Content owns the vocabulary and assessment imports nothing from it, so the four names are
 * repeated here and a spec holds them equal to the ones content publishes.
 */
export const DIFFICULTY_BANDS = ['foundational', 'moderate', 'challenging', 'advanced'] as const;
export type DifficultyBand = (typeof DIFFICULTY_BANDS)[number];

export interface ScopeFilter {
  /** Concepts to draw from, by identity. Identifiers only: assessment does not learn what a concept means. */
  readonly conceptIdentityIds: readonly string[];
  readonly subject: string | null;
  readonly itemTypes: readonly string[];
}

export interface PracticePolicy {
  readonly selectionStrategy: SelectionStrategy;
  readonly scopeFilter: ScopeFilter;
  readonly difficultyBand: DifficultyBand | null;
  readonly excludeRecentlySeen: boolean;
  /** A practice run shows correctness after each response. Fixed, not a choice. */
  readonly feedbackMode: 'immediate';
  /** A practice run can be put down and picked up. Fixed, not a choice. */
  readonly pausable: true;
}

export type PracticePolicyErrorCode =
  | 'PRACTICE_STRATEGY_INVALID'
  | 'PRACTICE_ADAPTIVE_NOT_AVAILABLE'
  | 'PRACTICE_SCOPE_INVALID'
  | 'PRACTICE_FILTER_EMPTY'
  | 'PRACTICE_BAND_INVALID'
  | 'PRACTICE_FLAGS_INVALID';
export type PracticePolicyError = AssessmentError<PracticePolicyErrorCode>;

export interface PracticePolicyProps {
  readonly selectionStrategy: string;
  readonly scopeFilter?: {
    readonly conceptIdentityIds?: readonly string[];
    readonly subject?: string | null;
    readonly itemTypes?: readonly string[];
  };
  readonly difficultyBand?: string | null;
  readonly excludeRecentlySeen?: boolean;
  readonly feedbackMode?: string;
  readonly pausable?: boolean;
}

function invalid(code: PracticePolicyErrorCode, message: string, location: string): PracticePolicyError {
  return validationError(code, message, location);
}

export function createPracticePolicy(props: PracticePolicyProps): Result<PracticePolicy, PracticePolicyError> {
  if (props.selectionStrategy === 'adaptive') {
    return err(invalid('PRACTICE_ADAPTIVE_NOT_AVAILABLE', 'adaptive selection is H1 and needs item statistics; it is not offered yet', 'selectionStrategy'));
  }
  if (!(SELECTION_STRATEGIES as readonly string[]).includes(props.selectionStrategy)) {
    return err(invalid('PRACTICE_STRATEGY_INVALID', `a selection strategy is one of ${SELECTION_STRATEGIES.join(', ')}`, 'selectionStrategy'));
  }
  const concepts = props.scopeFilter?.conceptIdentityIds ?? [];
  const subject = props.scopeFilter?.subject ?? null;
  const itemTypes = props.scopeFilter?.itemTypes ?? [];
  if (
    !concepts.every((concept) => isUuid(concept)) ||
    new Set(concepts).size !== concepts.length ||
    (subject !== null && !isNonBlank(subject)) ||
    !itemTypes.every((type) => isNonBlank(type))
  ) {
    return err(invalid('PRACTICE_SCOPE_INVALID', 'a scope names distinct concept identities, a non-blank subject and non-blank item types', 'scopeFilter'));
  }
  const band = props.difficultyBand ?? null;
  if (band !== null && !(DIFFICULTY_BANDS as readonly string[]).includes(band)) {
    return err(invalid('PRACTICE_BAND_INVALID', `a difficulty band is one of ${DIFFICULTY_BANDS.join(', ')}`, 'difficultyBand'));
  }
  // A filtered run with nothing to filter by is "everything published": the learner must narrow it. A targeted or spaced run is scoped by Learning.
  if (props.selectionStrategy === 'filtered' && concepts.length === 0 && subject === null && itemTypes.length === 0 && band === null) {
    return err(invalid('PRACTICE_FILTER_EMPTY', 'a filtered run names at least one of a concept, a subject, an item type or a difficulty band', 'scopeFilter'));
  }
  if ((props.feedbackMode ?? 'immediate') !== 'immediate' || (props.pausable ?? true) !== true || typeof (props.excludeRecentlySeen ?? true) !== 'boolean') {
    return err(invalid('PRACTICE_FLAGS_INVALID', 'a practice run gives immediate feedback and is pausable; those are not choices', 'feedbackMode'));
  }
  return ok(
    Object.freeze({
      selectionStrategy: props.selectionStrategy as SelectionStrategy,
      scopeFilter: Object.freeze({ conceptIdentityIds: Object.freeze([...concepts]), subject, itemTypes: Object.freeze([...itemTypes]) }),
      difficultyBand: band as DifficultyBand | null,
      excludeRecentlySeen: props.excludeRecentlySeen ?? true,
      feedbackMode: 'immediate' as const,
      pausable: true as const,
    }),
  );
}

/** What a mock's delivery is derived from: the timing and navigation of its `ExamProfileVersion`. */
export interface ProfileDeliveryInput {
  readonly totalDurationMinutes: number;
  readonly sectionLocking: boolean;
  readonly autoSubmitOnExpiry: boolean;
  readonly crossSectionNavigation: boolean;
  readonly allowMarkForReview: boolean;
  readonly allowAnswerChange: boolean;
  readonly allowClearResponse: boolean;
}

export type DeliverySource =
  | { readonly kind: 'profile'; readonly profile: ProfileDeliveryInput }
  | { readonly kind: 'practice'; readonly policy: PracticePolicy };

/**
 * What an attempt takes from the derivation: the pinned document, and the two columns that follow it. `isTimed` and `durationMs` are one fact
 * said twice — `attempt_duration_follows_timing` holds them together in the database.
 */
export interface DerivedDelivery {
  readonly isTimed: boolean;
  readonly durationMs: number | null;
  readonly document: Readonly<Record<string, unknown>>;
}

const MS_PER_MINUTE = 60_000;

export function deriveDeliveryPolicy(source: DeliverySource): DerivedDelivery {
  if (source.kind === 'profile') {
    const profile = source.profile;
    return Object.freeze({
      isTimed: true,
      durationMs: profile.totalDurationMinutes * MS_PER_MINUTE,
      document: Object.freeze({
        timing: Object.freeze({
          totalDurationMinutes: profile.totalDurationMinutes,
          sectionLocking: profile.sectionLocking,
          autoSubmitOnExpiry: profile.autoSubmitOnExpiry,
        }),
        navigation: Object.freeze({
          crossSectionNavigation: profile.crossSectionNavigation,
          allowMarkForReview: profile.allowMarkForReview,
          allowAnswerChange: profile.allowAnswerChange,
          allowClearResponse: profile.allowClearResponse,
        }),
        feedbackMode: 'deferred',
        pausable: false,
      }),
    });
  }
  const policy = source.policy;
  return Object.freeze({
    isTimed: false,
    durationMs: null,
    document: Object.freeze({
      timing: Object.freeze({ untimed: true }),
      navigation: Object.freeze({ crossSectionNavigation: true, allowMarkForReview: true, allowAnswerChange: true, allowClearResponse: true }),
      feedbackMode: policy.feedbackMode,
      pausable: policy.pausable,
      practice: Object.freeze({
        selectionStrategy: policy.selectionStrategy,
        scopeFilter: policy.scopeFilter,
        difficultyBand: policy.difficultyBand,
        excludeRecentlySeen: policy.excludeRecentlySeen,
      }),
    }),
  });
}

/**
 * The practice policy an attempt pinned, read back from its delivery document (M7-27: a run that grows is grown under the policy it was created
 * under, never a fresh one). `null` for a document that is not a practice run's. This is the other half of `deriveDeliveryPolicy`, and a spec holds the
 * two to a round trip so the shape cannot drift between writing and reading.
 */
export function practicePolicyOf(document: Readonly<Record<string, unknown>>): Result<PracticePolicy, PracticePolicyError> | null {
  const practice = document['practice'];
  if (typeof practice !== 'object' || practice === null) return null;
  const held = practice as Record<string, unknown>;
  const scope = (held['scopeFilter'] ?? {}) as Record<string, unknown>;
  return createPracticePolicy({
    selectionStrategy: String(held['selectionStrategy']),
    scopeFilter: {
      conceptIdentityIds: (scope['conceptIdentityIds'] ?? []) as readonly string[],
      subject: (scope['subject'] ?? null) as string | null,
      itemTypes: (scope['itemTypes'] ?? []) as readonly string[],
    },
    difficultyBand: (held['difficultyBand'] ?? null) as string | null,
    excludeRecentlySeen: held['excludeRecentlySeen'] as boolean,
    feedbackMode: String(document['feedbackMode']),
    pausable: document['pausable'] as boolean,
  });
}
