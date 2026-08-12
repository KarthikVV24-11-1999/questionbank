import type { ItemVersion } from './item-version.js';
import { isPublishable } from './licensing-status.js';
import { primaryTagOf } from './taxonomy-tag.js';
import { incorrectOptionIdsOf } from './response-specification.js';

/**
 * Pre-submission validation (FR-TCH-07).
 *
 * **Continuous and inline; blocking only at submit** (UX §10.1). Late-surfaced
 * errors waste the whole authoring session, so this runs on every keystroke's
 * worth of draft — which is why it is pure, cheap and returns everything at
 * once rather than stopping at the first problem.
 *
 * **Every finding carries a location.** "Invalid item" is a message an author
 * cannot act on; an author who cannot find the problem submits nothing. A
 * finding names the block index, the option id, the tag — whatever the editor
 * needs to scroll to and highlight.
 *
 * **Blocking and warning are disjoint and exhaustive** over the finding codes,
 * asserted. A code that is neither is a code the submit gate does not know how
 * to treat, and the safe reading of "unknown" would have to be blocking, which
 * would surprise an author with a refusal nobody can explain.
 *
 * **Duplicate detection is M4's.** It is reported as `not_evaluated`, never as
 * "none found": a report claiming no duplicates when the check never ran is a
 * lie a reviewer will act on.
 */

export const BLOCKING_CODES = [
  'ANSWER_KEY_MISSING',
  'NUMERIC_TOLERANCE_MISSING',
  'CONCEPT_TAG_MISSING',
  'LICENSING_UNRESOLVED',
  'NOTATION_UNRENDERABLE',
  'SOLUTION_MISSING',
] as const;
export type BlockingCode = (typeof BLOCKING_CODES)[number];

export const WARNING_CODES = [
  'PROBABLE_DUPLICATE',
  'CONCEPT_OUT_OF_DECLARED_SCOPE',
  'DIFFICULTY_UNUSUAL',
  'DISTRACTOR_ANALYSIS_MISSING',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export type FindingCode = BlockingCode | WarningCode;

export type FindingSeverity = 'blocking' | 'warning';

export interface Finding {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly location: string;
}

/** Whether the duplicate check ran at all — M4 owns it (FR-QM-04). */
export const DUPLICATE_CHECK_STATES = ['not_evaluated', 'none_found', 'candidates_found'] as const;
export type DuplicateCheckState = (typeof DUPLICATE_CHECK_STATES)[number];

/**
 * Facts the draft cannot know about itself, resolved by the handler (M3-25):
 * whether a solution exists, whether the notation renders, whether the concepts
 * are in the author's declared scope.
 */
export interface ValidationFacts {
  /** Whether the executor accepts the version's key (M3-08). */
  readonly answerSpecificationAccepted: boolean;
  /** Whether a solution targeting this version exists at all. */
  readonly solutionExists: boolean;
  /** Whether the solution analyses every incorrect option (M3-13). */
  readonly analysedDistractorOptionIds: readonly string[];
  /** Render failures across the supported surfaces, empty when it renders. */
  readonly renderFailures: readonly string[];
  /** Concepts outside the author's declared scope, from Curriculum. */
  readonly outOfScopeConceptIds: readonly string[];
  /** Duplicate detection is M4's; until then this is `not_evaluated`. */
  readonly duplicateCheckState: DuplicateCheckState;
  /** The instant licensing is evaluated at — supplied, never read here. */
  readonly asOf: string;
}

export interface ValidationReport {
  readonly findings: readonly Finding[];
  readonly blocking: readonly Finding[];
  readonly warnings: readonly Finding[];
  readonly maySubmit: boolean;
  readonly duplicateCheckState: DuplicateCheckState;
}

export function isBlockingCode(code: string): code is BlockingCode {
  return (BLOCKING_CODES as readonly string[]).includes(code);
}

export function isWarningCode(code: string): code is WarningCode {
  return (WARNING_CODES as readonly string[]).includes(code);
}

function blocking(code: BlockingCode, message: string, location: string): Finding {
  return { code, severity: 'blocking', message, location };
}

function warning(code: WarningCode, message: string, location: string): Finding {
  return { code, severity: 'warning', message, location };
}

/** The difficulty bands that read as unusual enough to be worth a second look. */
const UNUSUAL_DIFFICULTY: readonly string[] = ['advanced'];

/** Whether a numeric item omits the parameter its comparison mode needs (FR-TCH-02 rule 3). */
function hasNumericSpecWithoutTolerance(version: ItemVersion): boolean {
  if (version.responseSpec.itemType !== 'NUMERIC') return false;
  const spec = version.responseSpec.spec;
  switch (spec.comparisonMode) {
    case 'ABSOLUTE_TOLERANCE':
    case 'RELATIVE_TOLERANCE':
      return spec.toleranceValue === undefined || spec.toleranceValue.trim().length === 0;
    case 'SIGNIFICANT_FIGURES':
      return spec.significantFigures === undefined;
    case 'RANGE':
      return spec.rangeMin === undefined || spec.rangeMax === undefined;
    case 'EXACT':
      return false;
  }
}

/**
 * Validates a draft. Pure: the same draft and facts yield the same findings,
 * and running it mutates nothing.
 */
export function validateDraft(version: ItemVersion, facts: ValidationFacts): ValidationReport {
  const findings: Finding[] = [];

  // ── Blocking (FR-TCH-07 rule 1) ───────────────────────────────────────────

  if (!facts.answerSpecificationAccepted) {
    findings.push(
      blocking(
        'ANSWER_KEY_MISSING',
        'the scoring executor does not accept this item’s answer key',
        'version.responseSpec',
      ),
    );
  }

  // Called out separately from the key check because it is the mistake
  // FR-TCH-02 rule 3 names, and an author needs to be told which field to fill
  // rather than that the key is bad.
  if (hasNumericSpecWithoutTolerance(version)) {
    findings.push(
      blocking(
        'NUMERIC_TOLERANCE_MISSING',
        'a numerical item states the parameter its comparison mode needs — tolerance, significant figures, or both range bounds',
        'version.responseSpec.spec',
      ),
    );
  }

  if (version.taxonomyTags.length === 0 || primaryTagOf(version.taxonomyTags) === undefined) {
    findings.push(
      blocking(
        'CONCEPT_TAG_MISSING',
        'an item carries at least one concept tag, one of them primary',
        'version.taxonomyTags',
      ),
    );
  }

  if (!isPublishable(version.licensing, { asOf: facts.asOf })) {
    findings.push(
      blocking(
        'LICENSING_UNRESOLVED',
        'licensing is unresolved or expired, which blocks publication unconditionally',
        'version.licensing',
      ),
    );
  }

  for (const failure of facts.renderFailures) {
    findings.push(blocking('NOTATION_UNRENDERABLE', failure, 'version.stem'));
  }

  if (!facts.solutionExists) {
    findings.push(
      blocking('SOLUTION_MISSING', 'no item is submitted without a solution', 'solution'),
    );
  }

  // ── Warning (FR-TCH-07 rule 2) ────────────────────────────────────────────

  // Advisory, never blocking: genuine variants are legitimate and valuable
  // (FR-QM-04 rule 2). And until M4 wires the check, the report says so.
  if (facts.duplicateCheckState === 'candidates_found') {
    findings.push(
      warning('PROBABLE_DUPLICATE', 'this item resembles existing content; review before submitting', 'version.stem'),
    );
  }

  for (const conceptId of facts.outOfScopeConceptIds) {
    findings.push(
      warning(
        'CONCEPT_OUT_OF_DECLARED_SCOPE',
        `concept ${conceptId} lies outside the declared syllabus scope`,
        'version.taxonomyTags',
      ),
    );
  }

  if (UNUSUAL_DIFFICULTY.includes(version.difficultyEstimate)) {
    findings.push(
      warning(
        'DIFFICULTY_UNUSUAL',
        `an ${version.difficultyEstimate} estimate is unusual; empirical statistics will supersede it (FR-QM-09)`,
        'version.difficultyEstimate',
      ),
    );
  }

  const unanalysed = incorrectOptionIdsOf(version.responseSpec).filter(
    (optionId) => !facts.analysedDistractorOptionIds.includes(optionId),
  );
  for (const optionId of unanalysed) {
    findings.push(
      warning(
        'DISTRACTOR_ANALYSIS_MISSING',
        `option ${optionId} has no distractor analysis; the misconception is easiest to write now, while the item is fresh`,
        `version.responseSpec.options[${optionId}]`,
      ),
    );
  }

  const blockingFindings = findings.filter((finding) => finding.severity === 'blocking');
  const warningFindings = findings.filter((finding) => finding.severity === 'warning');

  return Object.freeze({
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
    blocking: Object.freeze(blockingFindings),
    warnings: Object.freeze(warningFindings),
    // FR-TCH-07 rule 3. Warnings never stop a submission.
    maySubmit: blockingFindings.length === 0,
    duplicateCheckState: facts.duplicateCheckState,
  });
}

/**
 * How the validation panel should describe the duplicate check.
 *
 * A report that says "no duplicates found" when the check never ran is a lie
 * a reviewer will act on, so `not_evaluated` says exactly that.
 */
export function describeDuplicateCheck(state: DuplicateCheckState): string {
  switch (state) {
    case 'not_evaluated':
      return 'duplicate detection has not run (arrives with the review workspace)';
    case 'none_found':
      return 'no probable duplicates found';
    case 'candidates_found':
      return 'probable duplicates found — review before submitting';
  }
}
