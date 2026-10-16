import { validateRender } from '@questionbank/content-renderer/render-validation';
import { buildProposedItem } from '../domain/proposed-item.js';
import { validateDraft, type Finding, type ValidationReport } from '../domain/pre-submission-validation.js';
import { isKeyAcceptedByExecutor } from './answer-key-projection.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';

/**
 * Validates proposed content — the same `AuthoredItemContent` a `CreateItemDraft`
 * takes — without storing it, and returns the same `ValidationReport` the stored
 * draft's `GetValidationFindings` returns.
 *
 * **It reaches the same `validateDraft`.** Nothing here re-derives a finding or
 * copies a rule: the proposal is built into the `ItemVersion` that `validateDraft`
 * takes, the facts `validateDraft` needs are worked out from it, and
 * `validateDraft` is called. A rule added to `validateDraft` is therefore a rule
 * the proposal path has, and the spec holds the two paths to the same findings,
 * code for code, over one set of fixtures.
 *
 * **Pure.** It takes no repository and reads no clock: the instant licensing is
 * judged at is supplied, and nothing is saved. A validator that wrote would be
 * the thing this exists to avoid — creating a draft for every proposal to learn
 * whether it is a good one would write into content for things content never
 * wanted.
 *
 * **Total (D41).** Its input is a model's proposal: JSON, and not necessarily the
 * shape the type says. Content's constructors return a value for input of the
 * wrong shape, and anything they refuse comes back as a `STRUCTURE_INVALID`
 * finding naming where and why, never as a raised error. A report is returned
 * for any input whatever.
 *
 * The structural half lives in `domain/proposed-item.ts`, which the duplicate check
 * shares from the other side of the review/authoring sub-boundary. Structure is
 * settled first, in full: every problem found is reported at once,
 * because a proposer told one problem at a time makes as many round trips as
 * there are problems. Only a proposal with no structural problem is run through
 * `validateDraft`, since that needs a version to look at.
 */

export interface ProposalFacts {
  /** The instant licensing is evaluated at — supplied, never read. */
  readonly asOf: string;
  /**
   * Whether the proposal brings a solution. A stored draft's solution is its own
   * aggregate, so this is what the proposal says about itself; absent means no,
   * which is what a stored draft with no solution yet reports.
   */
  readonly solutionProvided?: boolean;
  /** Options a solution already analyses as distractors. Absent means none. */
  readonly analysedDistractorOptionIds?: readonly string[];
}

function structuralReport(findings: readonly Finding[]): ValidationReport {
  return Object.freeze({
    findings: Object.freeze([...findings]),
    blocking: Object.freeze([...findings]),
    warnings: Object.freeze([]),
    maySubmit: false,
    duplicateCheckState: 'not_evaluated',
  });
}

export function validateProposedContent(content: AuthoredItemContent, facts: ProposalFacts): ValidationReport {
  const proposed = buildProposedItem(content, facts.asOf);
  if (!proposed.ok) return structuralReport(proposed.findings);

  const { version } = proposed;
  return validateDraft(version, {
    answerSpecificationAccepted: isKeyAcceptedByExecutor(version.responseSpec),
    solutionExists: facts.solutionProvided ?? false,
    analysedDistractorOptionIds: facts.analysedDistractorOptionIds ?? [],
    renderFailures: validateRender(version.stem).flatMap((verdict) => verdict.failures),
    outOfScopeConceptIds: [],
    duplicateCheckState: 'not_evaluated',
    asOf: facts.asOf,
  });
}
