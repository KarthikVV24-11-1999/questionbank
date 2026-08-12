import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';

/**
 * `Provenance` — where an item came from (DOMAIN-MODEL §5, FR-QM-05).
 *
 * Two things depend on this being complete rather than approximately complete.
 *
 * **INV-01.** AI proposes; it never publishes. Half of making that structural
 * is refusing to record `ai_generated` without the model version, prompt
 * version, generation run and confidence that identify *which* model proposed
 * it — an AI item whose provenance says only "ai_generated" is one nobody can
 * audit, recall, or re-evaluate when a model turns out to be wrong. The other
 * half is M3-11, which requires a human reviewer signature on exactly these
 * source types.
 *
 * **B1 and DECISIONS §D item 2.** `previous_year` and `licensed` are the source
 * types that carry third-party rights, and the licensing question is open. This
 * module records what was claimed and by whom; `LicensingStatus` (M3-06)
 * decides whether that claim permits publication. Keeping the two apart means
 * a licensing policy change is a policy change, not a re-authoring exercise.
 *
 * Immutable once published (FR-QM-05 rule 5) — corrections create a new
 * version, which falls out of `ItemVersion` being immutable rather than needing
 * its own rule here.
 */

export const SOURCE_TYPES = [
  'original',
  'previous_year',
  'licensed',
  'ai_generated',
  'ai_assisted',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The source types for which a machine proposed the content (D8, INV-01). */
export const AI_SOURCE_TYPES = ['ai_generated', 'ai_assisted'] as const satisfies readonly SourceType[];
export type AiSourceType = (typeof AI_SOURCE_TYPES)[number];

export interface Provenance {
  readonly sourceType: SourceType;
  readonly sourceExam?: string;
  readonly sourceYear?: number;
  readonly sourceSession?: string;
  readonly authorRef?: string;
  readonly modelVersionId?: string;
  readonly promptVersionId?: string;
  readonly generationRunId?: string;
  readonly confidence?: number;
  readonly importBatchId?: string;
}

export type ProvenanceErrorCode =
  | 'SOURCE_TYPE_UNKNOWN'
  | 'SOURCE_EXAM_REQUIRED'
  | 'SOURCE_YEAR_REQUIRED'
  | 'SOURCE_YEAR_IMPLAUSIBLE'
  | 'ATTRIBUTION_AUTHOR_REQUIRED'
  | 'MODEL_VERSION_REQUIRED'
  | 'PROMPT_VERSION_REQUIRED'
  | 'GENERATION_RUN_REQUIRED'
  | 'CONFIDENCE_REQUIRED'
  | 'CONFIDENCE_OUT_OF_RANGE'
  | 'AI_FIELDS_ON_HUMAN_SOURCE';

export type ProvenanceError = ContentError<ProvenanceErrorCode>;

export type CreateProvenanceProps = Provenance;

/**
 * A year outside this band is a typo, not a paper. The lower bound is earlier
 * than any exam this platform models; the upper bound is supplied so the
 * domain reads no clock (F45's discipline, applied here for the same reason).
 */
export const EARLIEST_SOURCE_YEAR = 1950;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function invalid(code: ProvenanceErrorCode, message: string, location: string): ProvenanceError {
  return validationError(code, message, location);
}

export function isAiSourceType(sourceType: string): sourceType is AiSourceType {
  return (AI_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

export interface ProvenanceContext {
  /** The current academic year, supplied — the domain reads no clock. */
  readonly latestPlausibleYear: number;
}

export function createProvenance(
  props: CreateProvenanceProps,
  context: ProvenanceContext,
  location = 'provenance',
): Result<Provenance, ProvenanceError> {
  if (!(SOURCE_TYPES as readonly string[]).includes(props.sourceType)) {
    return err(
      invalid(
        'SOURCE_TYPE_UNKNOWN',
        `unknown source type "${props.sourceType}" — the set is closed, and guessing "original" would launder a third party's paper`,
        location,
      ),
    );
  }

  if (props.sourceType === 'previous_year') {
    if (isBlank(props.sourceExam)) {
      return err(invalid('SOURCE_EXAM_REQUIRED', 'a previous-year item requires its sourceExam', location));
    }
    if (props.sourceYear === undefined) {
      return err(invalid('SOURCE_YEAR_REQUIRED', 'a previous-year item requires its sourceYear', location));
    }
    if (
      !Number.isInteger(props.sourceYear) ||
      props.sourceYear < EARLIEST_SOURCE_YEAR ||
      props.sourceYear > context.latestPlausibleYear
    ) {
      return err(
        invalid(
          'SOURCE_YEAR_IMPLAUSIBLE',
          `sourceYear ${props.sourceYear} lies outside [${EARLIEST_SOURCE_YEAR}, ${context.latestPlausibleYear}]`,
          location,
        ),
      );
    }
  }

  // A licensed item nobody can attribute is a licensed item nobody can prove a
  // licence for. `LicensingStatus` carries the licence; this carries who to
  // credit.
  if (props.sourceType === 'licensed' && isBlank(props.authorRef)) {
    return err(
      invalid(
        'ATTRIBUTION_AUTHOR_REQUIRED',
        'a licensed item requires an authorRef to attribute (FR-QM-05)',
        location,
      ),
    );
  }

  if (isAiSourceType(props.sourceType)) {
    if (isBlank(props.modelVersionId)) {
      return err(invalid('MODEL_VERSION_REQUIRED', 'AI provenance requires a modelVersionId', location));
    }
    if (isBlank(props.promptVersionId)) {
      return err(invalid('PROMPT_VERSION_REQUIRED', 'AI provenance requires a promptVersionId', location));
    }
    if (isBlank(props.generationRunId)) {
      return err(invalid('GENERATION_RUN_REQUIRED', 'AI provenance requires a generationRunId', location));
    }
    if (props.confidence === undefined) {
      return err(invalid('CONFIDENCE_REQUIRED', 'AI provenance requires a confidence', location));
    }
    if (!Number.isFinite(props.confidence) || props.confidence < 0 || props.confidence > 1) {
      return err(
        invalid(
          'CONFIDENCE_OUT_OF_RANGE',
          `confidence must lie in [0, 1], got ${props.confidence}`,
          location,
        ),
      );
    }
  } else if (
    !isBlank(props.modelVersionId) ||
    !isBlank(props.promptVersionId) ||
    !isBlank(props.generationRunId) ||
    props.confidence !== undefined
  ) {
    // A human-sourced item carrying model fields is either mislabelled AI
    // content or a copy-paste. Either way it defeats the audit that INV-01
    // rests on, so it is refused rather than tidied away.
    return err(
      invalid(
        'AI_FIELDS_ON_HUMAN_SOURCE',
        `source type ${props.sourceType} carries AI generation fields; label it ai_generated or ai_assisted, or remove them`,
        location,
      ),
    );
  }

  return ok(Object.freeze({ ...props }));
}

/** Whether a machine proposed this content, and a human must therefore sign it. */
export function isMachineProposed(provenance: Provenance): boolean {
  return isAiSourceType(provenance.sourceType);
}
