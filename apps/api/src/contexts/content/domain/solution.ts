import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import { conflictError, ruleViolationError, validationError, type ContentError } from './content-error.js';
import type { ContentBody } from './content-body.js';
import { applyTransition, type LifecycleState, type LifecycleTransition } from './item-lifecycle.js';

/**
 * `Solution` — the explanatory content, versioned independently of the item
 * (DOMAIN-MODEL §5, D5). **The product's actual value.**
 *
 * D5 accepts one cross-aggregate invariant — "no publication without a
 * solution", enforced as a precondition at the item's publication transition
 * (M3-11) — in exchange for being able to correct an explanation without
 * touching the item or invalidating a single historical attempt. That trade is
 * the whole reason this is not a field on `ItemVersion`.
 *
 * **A solution targets an item *version*, not an item** (FR-TCH-04 rule 3).
 * The correctness it explains belongs to a specific key; a solution written
 * for version 1 says nothing about version 2, whose key may differ. Making the
 * target a version is what lets an explanation be rewritten a year later
 * without any attempt's meaning changing.
 *
 * **`finalAnswerAssertion` is checked against the item's key at M3-14**, not
 * here — the key lives on the item, and a solution that reached across to read
 * it would be the coupling D5 exists to avoid.
 */

/** What the solution claims the answer is, in the shape the item type implies. */
export type FinalAnswerAssertion =
  | { readonly kind: 'OPTION'; readonly optionId: string }
  | { readonly kind: 'OPTION_SET'; readonly optionIds: readonly string[] }
  | { readonly kind: 'PAIRS'; readonly pairs: readonly { readonly left: string; readonly right: string }[] }
  | { readonly kind: 'NUMERIC'; readonly value: string; readonly unit?: string };

export interface SolutionStep {
  readonly ordinal: number;
  readonly body: ContentBody;
  readonly conceptRefs: readonly string[];
}

export interface DistractorAnalysis {
  readonly optionId: string;
  readonly misconception: ContentBody;
}

export interface AlternateApproach {
  readonly label: string;
  readonly steps: readonly SolutionStep[];
  readonly applicabilityNote?: string;
}

export interface SolutionVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly finalAnswerAssertion: FinalAnswerAssertion;
  readonly steps: readonly SolutionStep[];
  readonly distractorAnalyses: readonly DistractorAnalysis[];
  readonly alternateApproaches: readonly AlternateApproach[];
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export interface Solution {
  readonly solutionId: string;
  readonly itemId: string;
  readonly targetItemVersionId: string;
  readonly lifecycleState: LifecycleState;
  readonly currentPublishedVersionId?: string;
  readonly versions: readonly SolutionVersion[];
  readonly aggregateVersion: number;
}

export type SolutionErrorCode =
  | 'SOLUTION_ID_REQUIRED'
  | 'ITEM_ID_REQUIRED'
  | 'TARGET_ITEM_VERSION_REQUIRED'
  | 'VERSION_ID_REQUIRED'
  | 'VERSION_NO_INVALID'
  | 'VERSIONS_REQUIRED'
  | 'VERSION_ID_DUPLICATE'
  | 'VERSION_NUMBERS_NOT_CONTIGUOUS'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_EDITABLE'
  | 'PUBLISHED_VERSION_UNKNOWN'
  | 'PUBLISHED_VERSION_REQUIRED'
  | 'STEPS_REQUIRED'
  | 'STEP_ORDINALS_NOT_CONTIGUOUS'
  | 'FINAL_ANSWER_REQUIRED'
  | 'FINAL_ANSWER_KIND_UNKNOWN'
  | 'DISTRACTOR_OPTION_DUPLICATE'
  | 'ALTERNATE_APPROACH_LABEL_REQUIRED'
  | 'AUTHORED_BY_REQUIRED'
  | 'CREATED_AT_NOT_A_TIMESTAMP';

export type SolutionError = ContentError<SolutionErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const FINAL_ANSWER_KINDS = ['OPTION', 'OPTION_SET', 'PAIRS', 'NUMERIC'] as const;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: SolutionErrorCode, message: string, location: string): SolutionError {
  return validationError(code, message, location);
}

function checkSteps(steps: readonly SolutionStep[], location: string): SolutionError | undefined {
  if (steps.length === 0) {
    return invalid('STEPS_REQUIRED', 'a solution requires at least one step', location);
  }
  const ordinals = steps.map((step) => step.ordinal).sort((a, b) => a - b);
  for (const [index, ordinal] of ordinals.entries()) {
    if (ordinal !== index + 1) {
      return invalid(
        'STEP_ORDINALS_NOT_CONTIGUOUS',
        `step ordinals must run contiguously from 1, got ${ordinals.join(', ')}`,
        location,
      );
    }
  }
  return undefined;
}

function checkFinalAnswer(
  assertion: FinalAnswerAssertion,
  location: string,
): SolutionError | undefined {
  if (!(FINAL_ANSWER_KINDS as readonly string[]).includes(assertion.kind)) {
    return invalid(
      'FINAL_ANSWER_KIND_UNKNOWN',
      `unknown final-answer kind "${String((assertion as { kind: string }).kind)}"`,
      location,
    );
  }

  switch (assertion.kind) {
    case 'OPTION':
      return isBlank(assertion.optionId)
        ? invalid('FINAL_ANSWER_REQUIRED', 'the solution must state which option is correct', location)
        : undefined;
    case 'OPTION_SET':
      return assertion.optionIds.length === 0
        ? invalid('FINAL_ANSWER_REQUIRED', 'the solution must state which options are correct', location)
        : undefined;
    case 'PAIRS':
      return assertion.pairs.length === 0
        ? invalid('FINAL_ANSWER_REQUIRED', 'the solution must state the correct pairing', location)
        : undefined;
    case 'NUMERIC':
      // The authored literal, as everywhere else on this path — M3-14 compares
      // it through the item's own NumericAnswerSpec, so reading it as a double
      // here would decide agreement on a value nobody wrote.
      return isBlank(assertion.value)
        ? invalid('FINAL_ANSWER_REQUIRED', 'the solution must state the final value', location)
        : undefined;
  }
}

function freezeSteps(steps: readonly SolutionStep[]): readonly SolutionStep[] {
  return Object.freeze(
    steps.map((step) => Object.freeze({ ...step, conceptRefs: Object.freeze([...step.conceptRefs]) })),
  );
}

export interface CreateSolutionVersionProps {
  readonly versionId: string;
  readonly versionNo: number;
  readonly finalAnswerAssertion: FinalAnswerAssertion;
  readonly steps: readonly SolutionStep[];
  readonly distractorAnalyses?: readonly DistractorAnalysis[];
  readonly alternateApproaches?: readonly AlternateApproach[];
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export function createSolutionVersion(
  props: CreateSolutionVersionProps,
  location = 'solutionVersion',
): Result<SolutionVersion, SolutionError> {
  if (isBlank(props.versionId)) {
    return err(invalid('VERSION_ID_REQUIRED', 'a solution version requires a versionId', location));
  }
  if (!Number.isInteger(props.versionNo) || props.versionNo < 1) {
    return err(
      invalid('VERSION_NO_INVALID', `versionNo must be an integer >= 1, got ${props.versionNo}`, location),
    );
  }

  const answerFailure = checkFinalAnswer(props.finalAnswerAssertion, `${location}.finalAnswerAssertion`);
  if (answerFailure !== undefined) return err(answerFailure);

  const stepFailure = checkSteps(props.steps, `${location}.steps`);
  if (stepFailure !== undefined) return err(stepFailure);

  const analyses = props.distractorAnalyses ?? [];
  const seen = new Set<string>();
  for (const [index, analysis] of analyses.entries()) {
    if (seen.has(analysis.optionId)) {
      return err(
        invalid(
          'DISTRACTOR_OPTION_DUPLICATE',
          `option ${analysis.optionId} is analysed more than once`,
          `${location}.distractorAnalyses[${index}]`,
        ),
      );
    }
    seen.add(analysis.optionId);
  }

  const approaches = props.alternateApproaches ?? [];
  for (const [index, approach] of approaches.entries()) {
    const approachLocation = `${location}.alternateApproaches[${index}]`;
    if (isBlank(approach.label)) {
      return err(
        invalid('ALTERNATE_APPROACH_LABEL_REQUIRED', 'an alternate approach requires a label', approachLocation),
      );
    }
    const failure = checkSteps(approach.steps, `${approachLocation}.steps`);
    if (failure !== undefined) return err(failure);
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

  return ok(
    Object.freeze({
      versionId: props.versionId,
      versionNo: props.versionNo,
      finalAnswerAssertion: Object.freeze({ ...props.finalAnswerAssertion }),
      steps: freezeSteps(props.steps),
      distractorAnalyses: Object.freeze(analyses.map((analysis) => Object.freeze({ ...analysis }))),
      alternateApproaches: Object.freeze(
        approaches.map((approach) => Object.freeze({ ...approach, steps: freezeSteps(approach.steps) })),
      ),
      authoredBy: Object.freeze({
        ...props.authoredBy,
        roleContext: Object.freeze([...props.authoredBy.roleContext]),
      }),
      createdAt: props.createdAt,
    }),
  );
}

export interface CreateSolutionProps {
  readonly solutionId: string;
  readonly itemId: string;
  readonly targetItemVersionId: string;
  readonly initialVersion: SolutionVersion;
}

export function createSolution(
  props: CreateSolutionProps,
  location = 'solution',
): Result<Solution, SolutionError> {
  if (isBlank(props.solutionId)) {
    return err(invalid('SOLUTION_ID_REQUIRED', 'a solution requires a solutionId', location));
  }
  if (isBlank(props.itemId)) {
    return err(invalid('ITEM_ID_REQUIRED', 'a solution names the item it explains', location));
  }
  // FR-TCH-04 rule 3. The correctness a solution explains belongs to a
  // specific key, and a key belongs to a version.
  if (isBlank(props.targetItemVersionId)) {
    return err(
      invalid(
        'TARGET_ITEM_VERSION_REQUIRED',
        'a solution targets an item version, not an item — a solution for version 1 says nothing about version 2',
        location,
      ),
    );
  }
  if (props.initialVersion.versionNo !== 1) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `a new solution starts at version 1, got ${props.initialVersion.versionNo}`,
        location,
      ),
    );
  }

  return ok(
    Object.freeze({
      solutionId: props.solutionId,
      itemId: props.itemId,
      targetItemVersionId: props.targetItemVersionId,
      lifecycleState: 'draft' as LifecycleState,
      versions: Object.freeze([props.initialVersion]),
      aggregateVersion: 1,
    }),
  );
}

export interface ReconstituteSolutionProps {
  readonly solutionId: string;
  readonly itemId: string;
  readonly targetItemVersionId: string;
  readonly lifecycleState: LifecycleState;
  readonly versions: readonly SolutionVersion[];
  readonly currentPublishedVersionId?: string;
  readonly aggregateVersion: number;
}

export function reconstituteSolution(
  props: ReconstituteSolutionProps,
  location = 'solution',
): Result<Solution, SolutionError> {
  if (isBlank(props.solutionId)) {
    return err(invalid('SOLUTION_ID_REQUIRED', 'a solution requires a solutionId', location));
  }
  if (props.versions.length === 0) {
    return err(invalid('VERSIONS_REQUIRED', 'a solution holds at least one version', location));
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
        `the published version ${props.currentPublishedVersionId} is not among this solution's versions`,
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
        `a ${props.lifecycleState} solution names the version that was published`,
        location,
      ),
    );
  }

  return ok(
    Object.freeze({
      solutionId: props.solutionId,
      itemId: props.itemId,
      targetItemVersionId: props.targetItemVersionId,
      lifecycleState: props.lifecycleState,
      versions: Object.freeze([...props.versions]),
      aggregateVersion: props.aggregateVersion,
      ...(props.currentPublishedVersionId === undefined
        ? {}
        : { currentPublishedVersionId: props.currentPublishedVersionId }),
    }),
  );
}

/**
 * Adds a version. Permitted whenever the solution is not retired — correcting
 * an explanation is the case D5 exists to make cheap, and a published solution
 * with a confusing step is precisely the one worth fixing.
 */
export function addSolutionVersion(
  solution: Solution,
  version: SolutionVersion,
): Result<Solution, SolutionError> {
  if (solution.lifecycleState === 'retired') {
    return err(
      ruleViolationError('VERSION_NOT_EDITABLE', 'a retired solution does not accept a new version', 'versions'),
    );
  }
  if (solution.versions.some((existing) => existing.versionId === version.versionId)) {
    return err(conflictError('VERSION_ID_DUPLICATE', `version ${version.versionId} already exists`, 'versions'));
  }
  if (version.versionNo !== solution.versions.length + 1) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `the next version is ${solution.versions.length + 1}, got ${version.versionNo}`,
        'versions',
      ),
    );
  }

  return ok(
    Object.freeze({
      ...solution,
      versions: Object.freeze([...solution.versions, version]),
      aggregateVersion: solution.aggregateVersion + 1,
    }),
  );
}

/**
 * States in which a version's content may still be edited in place. A
 * published solution is not locked as an aggregate — correcting an explanation
 * is the case D5 exists to make cheap — but the published *version* is, below.
 */
export function isSolutionVersionEditable(state: LifecycleState): boolean {
  return state !== 'in_review' && state !== 'approved' && state !== 'retired';
}

/** Replaces a draft version's content in place — autosave, not a new version. */
export function replaceDraftSolutionVersion(
  solution: Solution,
  version: SolutionVersion,
): Result<Solution, SolutionError> {
  if (!isSolutionVersionEditable(solution.lifecycleState)) {
    return err(
      ruleViolationError(
        'VERSION_NOT_EDITABLE',
        `a solution that is ${solution.lifecycleState} is locked against author edits`,
        'lifecycleState',
      ),
    );
  }
  if (version.versionId === solution.currentPublishedVersionId) {
    return err(
      ruleViolationError(
        'VERSION_NOT_EDITABLE',
        `version ${version.versionId} is published and never changes (INV-03)`,
        'versions',
      ),
    );
  }

  const existing = solution.versions.find((candidate) => candidate.versionId === version.versionId);
  if (existing === undefined) {
    return err(
      invalid('VERSION_NOT_FOUND', `version ${version.versionId} is not among this solution's versions`, 'versions'),
    );
  }
  if (version.versionNo !== existing.versionNo) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `version ${version.versionId} is number ${existing.versionNo}, the replacement claims ${version.versionNo}`,
        'versions',
      ),
    );
  }

  return ok(
    Object.freeze({
      ...solution,
      versions: Object.freeze(
        solution.versions.map((candidate) =>
          candidate.versionId === version.versionId ? version : candidate,
        ),
      ),
      aggregateVersion: solution.aggregateVersion + 1,
    }),
  );
}

export interface SolutionTransitionProps {
  readonly transition: LifecycleTransition;
  readonly versionId?: string;
}

export function transitionSolution(
  solution: Solution,
  props: SolutionTransitionProps,
): Result<Solution, SolutionError | ContentError> {
  const next = applyTransition(solution.lifecycleState, props.transition);
  if (!next.ok) return err(next.error);

  if (props.transition === 'publish') {
    if (props.versionId === undefined || !solution.versions.some((v) => v.versionId === props.versionId)) {
      return err(
        invalid(
          'VERSION_NOT_FOUND',
          `publication names a version this solution holds; got "${props.versionId ?? 'none'}"`,
          'versions',
        ),
      );
    }
  }

  return ok(
    Object.freeze({
      ...solution,
      lifecycleState: next.value,
      aggregateVersion: solution.aggregateVersion + 1,
      ...(props.transition === 'publish' && props.versionId !== undefined
        ? { currentPublishedVersionId: props.versionId }
        : {}),
    }),
  );
}

export function publishedSolutionVersionOf(solution: Solution): SolutionVersion | undefined {
  return solution.currentPublishedVersionId === undefined
    ? undefined
    : solution.versions.find((version) => version.versionId === solution.currentPublishedVersionId);
}

export function latestSolutionVersionOf(solution: Solution): SolutionVersion {
  return solution.versions.reduce((latest, version) =>
    version.versionNo > latest.versionNo ? version : latest,
  );
}

/**
 * FR-TCH-04 rule 2 — a "complete" grade requires a distractor analysis for
 * **every** incorrect option.
 *
 * Computed, never asserted. A grade an author can claim is a grade an author
 * will claim; this one is derived from what is actually there, and a solution
 * without the analyses is publishable but not complete.
 */
export function isComplete(
  version: SolutionVersion,
  incorrectOptionIds: readonly string[],
): boolean {
  const analysed = new Set(version.distractorAnalyses.map((analysis) => analysis.optionId));
  return incorrectOptionIds.every((optionId) => analysed.has(optionId));
}

/** The incorrect options this solution has not yet explained. */
export function unanalysedDistractors(
  version: SolutionVersion,
  incorrectOptionIds: readonly string[],
): readonly string[] {
  const analysed = new Set(version.distractorAnalyses.map((analysis) => analysis.optionId));
  return Object.freeze(incorrectOptionIds.filter((optionId) => !analysed.has(optionId)));
}
