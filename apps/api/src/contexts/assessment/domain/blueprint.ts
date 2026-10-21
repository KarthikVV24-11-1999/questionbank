import { validationError, type AssessmentError } from './assessment-error.js';
import { err, ok, type Result } from './result.js';
import { isNonBlank, isPositiveInteger, isNonNegativeInteger, isUuid } from './uuid.js';

/**
 * What a form must satisfy, as assembly sees it (ASSESSMENT-ENGINE §6).
 *
 * **This is assessment's own type, and content has never heard of it.** The
 * published catalogue answers "what exists"; a blueprint answers "which of it
 * makes a form", and every number below — how many items a section wants,
 * what they are worth, how the difficulty should be spread — belongs to this
 * side of that line. The mapping from an exam profile version's section specs
 * to these is the application layer's, when it exists.
 *
 * The vocabularies below are **copies of content's**, because the domain
 * imports nothing. A spec outside this context holds them to the same lists,
 * so a type content adds cannot quietly be one a blueprint cannot name.
 */
export const BLUEPRINT_ITEM_TYPES = ['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC'] as const;
export type BlueprintItemType = (typeof BLUEPRINT_ITEM_TYPES)[number];

export const BLUEPRINT_DIFFICULTY_BANDS = ['foundational', 'moderate', 'challenging', 'advanced'] as const;
export type BlueprintDifficultyBand = (typeof BLUEPRINT_DIFFICULTY_BANDS)[number];

export interface SectionBlueprint {
  readonly ordinal: number;
  /** The profile section this satisfies; carried to the form's section. */
  readonly sectionSpecRef: string;
  /** **Hard**: exactly this many items. */
  readonly itemCount: number;
  /** **Hard**: exactly this many of each type. Counts sum to `itemCount`. */
  readonly typeMix: Readonly<Partial<Record<BlueprintItemType, number>>>;
  /** What each item in the section is worth. */
  readonly marksPerItem: number;
  /** **Soft**: how many of each band the section would like. Counts sum to `itemCount`. */
  readonly difficultyTarget: Readonly<Partial<Record<BlueprintDifficultyBand, number>>>;
}

export interface Blueprint {
  readonly examProfileVersionId: string;
  readonly formType: 'mock' | 'diagnostic';
  /** **Hard**: the form's marks sum to exactly this. */
  readonly totalMarks: number;
  /** **Soft**: how far the form's difficulty may fall short of the targets, in items, and still count as on target. */
  readonly difficultyTolerance: number;
  readonly sections: readonly SectionBlueprint[];
}

export type BlueprintErrorCode =
  | 'BLUEPRINT_PROFILE_INVALID'
  | 'BLUEPRINT_FORM_TYPE_INVALID'
  | 'BLUEPRINT_TOTAL_MARKS_INVALID'
  | 'BLUEPRINT_TOLERANCE_INVALID'
  | 'BLUEPRINT_SECTIONS_INVALID'
  | 'BLUEPRINT_SECTION_INVALID';

export type BlueprintError = AssessmentError<BlueprintErrorCode>;

function sumOf(counts: Readonly<Partial<Record<string, number>>>, vocabulary: readonly string[]): number | null {
  let total = 0;
  for (const [key, value] of Object.entries(counts)) {
    if (!vocabulary.includes(key) || !isNonNegativeInteger(value)) return null;
    total += value;
  }
  return total;
}

function sectionFault(section: SectionBlueprint): string | null {
  if (!isNonNegativeInteger(section.ordinal) || !isNonBlank(section.sectionSpecRef)) {
    return 'a section needs an ordinal and the profile section it satisfies';
  }
  if (!isPositiveInteger(section.itemCount)) return 'itemCount is a positive whole number';
  if (!isPositiveInteger(section.marksPerItem)) return 'marksPerItem is a positive whole number';
  if (sumOf(section.typeMix, BLUEPRINT_ITEM_TYPES) !== section.itemCount) {
    return 'typeMix names only known item types and sums to itemCount';
  }
  if (sumOf(section.difficultyTarget, BLUEPRINT_DIFFICULTY_BANDS) !== section.itemCount) {
    return 'difficultyTarget names only known bands and sums to itemCount';
  }
  return null;
}

/**
 * Validates the *shape* of a blueprint. Whether its `totalMarks` agrees with
 * its sections is deliberately **not** checked here: total marks is a hard
 * constraint, and a blueprint that contradicts itself is one assembly must
 * refuse by naming it, rather than one that never reaches assembly at all.
 */
export function createBlueprint(props: Blueprint): Result<Blueprint, BlueprintError> {
  if (!isUuid(props.examProfileVersionId)) {
    return err(validationError('BLUEPRINT_PROFILE_INVALID', 'examProfileVersionId must be a uuid', 'examProfileVersionId'));
  }
  if (props.formType !== 'mock' && props.formType !== 'diagnostic') {
    return err(validationError('BLUEPRINT_FORM_TYPE_INVALID', 'formType is mock or diagnostic', 'formType'));
  }
  if (!isPositiveInteger(props.totalMarks)) {
    return err(validationError('BLUEPRINT_TOTAL_MARKS_INVALID', 'totalMarks is a positive whole number', 'totalMarks'));
  }
  if (!isNonNegativeInteger(props.difficultyTolerance)) {
    return err(validationError('BLUEPRINT_TOLERANCE_INVALID', 'difficultyTolerance is a non-negative whole number', 'difficultyTolerance'));
  }
  if (!Array.isArray(props.sections) || props.sections.length === 0 || new Set(props.sections.map((s) => s.ordinal)).size !== props.sections.length) {
    return err(validationError('BLUEPRINT_SECTIONS_INVALID', 'a blueprint has at least one section, with distinct ordinals', 'sections'));
  }
  for (const section of props.sections) {
    const fault = sectionFault(section);
    if (fault !== null) return err(validationError('BLUEPRINT_SECTION_INVALID', fault, 'sections'));
  }
  return ok(
    Object.freeze({
      examProfileVersionId: props.examProfileVersionId,
      formType: props.formType,
      totalMarks: props.totalMarks,
      difficultyTolerance: props.difficultyTolerance,
      sections: Object.freeze(
        [...props.sections]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((section) =>
            Object.freeze({
              ordinal: section.ordinal,
              sectionSpecRef: section.sectionSpecRef,
              itemCount: section.itemCount,
              typeMix: Object.freeze({ ...section.typeMix }),
              marksPerItem: section.marksPerItem,
              difficultyTarget: Object.freeze({ ...section.difficultyTarget }),
            }),
          ),
      ),
    }),
  );
}
