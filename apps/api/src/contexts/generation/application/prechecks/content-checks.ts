import type { FindingCode } from '../../../content/public/index.js';
import type { GenerationError } from '../../domain/generation-error.js';
import { err, ok } from '../../domain/result.js';
import { applicationError, type ApplicationError } from '../authorization.js';
import type { PrecheckId } from '../../domain/precheck-vocabulary.js';
import type { Clock, ContentProposalChecks } from '../ports.js';
import { toContentDraft } from '../content-draft-acl.js';
import type { CheckOutcome, PrecheckRunner } from './battery.js';

/**
 * Checks 1, 2, 4 and 8 (AI-ARCHITECTURE §11): structural validity,
 * renderability, numeric specification completeness, duplicate detection.
 *
 * They are **content's logic, asked of content**. Generation owns none of it:
 * the proposal is assembled into the `AuthoredItemContent` a draft is created
 * from, handed to content's validator and content's duplicate query, and what
 * comes back is read. No rule is restated here, which is the point — the
 * alternatives were a second renderability check (drift) or a content draft per
 * candidate (writes into content for things content never wanted).
 *
 * One validator report answers three checks, so each check reads its own share of
 * it. Which finding belongs to which check is the table below, and it is typed
 * against content's finding vocabulary: a finding code content adds that is not
 * placed here is a compile error, and not a finding nobody reads.
 */

type Placed = PrecheckId | 'elsewhere';

/**
 * Who answers for each finding. `elsewhere` is a finding another check owns, or
 * one that is advice and no part of structure, rendering or numeric completeness:
 * licensing is check 12's, a missing solution is check 6's, the rest are
 * warnings the battery has no check for. Naming them keeps "ignored" a decision.
 */
const OWNER: Readonly<Record<FindingCode, Placed | 'by item type'>> = {
  STRUCTURE_INVALID: 'schema_validity',
  CONCEPT_TAG_MISSING: 'schema_validity',
  NOTATION_UNRENDERABLE: 'renderability',
  NUMERIC_TOLERANCE_MISSING: 'numeric_spec_completeness',
  // The executor not accepting a key is a numeric specification problem when the
  // item is numeric (unit, forms, mode), and a structural one when it is not.
  ANSWER_KEY_MISSING: 'by item type',
  LICENSING_UNRESOLVED: 'elsewhere',
  SOLUTION_MISSING: 'elsewhere',
  PROBABLE_DUPLICATE: 'elsewhere',
  CONCEPT_OUT_OF_DECLARED_SCOPE: 'elsewhere',
  DIFFICULTY_UNUSUAL: 'elsewhere',
  DISTRACTOR_ANALYSIS_MISSING: 'elsewhere',
};

function ownerOf(code: FindingCode, itemType: string): Placed {
  const owner = OWNER[code];
  if (owner !== 'by item type') return owner;
  return itemType === 'NUMERIC' ? 'numeric_spec_completeness' : 'schema_validity';
}

export type ContentValidationCheckId = 'schema_validity' | 'renderability' | 'numeric_spec_completeness';

const PASS_DETAIL: Readonly<Record<ContentValidationCheckId, string>> = {
  schema_validity: "content's validation found nothing structurally wrong with the proposal",
  renderability: "the proposal's stem renders on every surface content supports",
  numeric_spec_completeness: "content's validation found no numeric specification missing what its comparison mode needs",
};

export function contentValidationCheck(
  check: ContentValidationCheckId,
  deps: { readonly content: ContentProposalChecks; readonly clock: Clock },
): PrecheckRunner {
  return {
    check,
    async run(candidate) {
      const draft = toContentDraft(candidate);
      if (!draft.ok) {
        // A proposal missing what a draft is made of fails the structural check and
        // leaves the others nothing to look at. A candidate content's *provenance*
        // would refuse is check 12's subject, not structure: it could not be
        // assembled to check, so no structural verdict is given for it.
        if (draft.error.kind === 'Validation') {
          return check === 'schema_validity' ? ok<CheckOutcome>({ outcome: 'fail', detail: draft.error.message }) : err(applicationErrorOf(draft.error));
        }
        return err(applicationErrorOf(draft.error));
      }

      const { content } = draft.value;
      const solution = candidate.content.body['solution'];
      const report = deps.content.validate(content, {
        asOf: deps.clock.now().toISOString(),
        solutionProvided: typeof solution === 'object' && solution !== null && !Array.isArray(solution),
      });

      const mine = report.blocking.filter((finding) => ownerOf(finding.code, candidate.content.itemType) === check);
      if (mine.length === 0) return ok<CheckOutcome>({ outcome: 'pass', detail: PASS_DETAIL[check] });
      return ok<CheckOutcome>({
        outcome: 'fail',
        detail: mine.map((finding) => `${finding.code} at ${finding.location}: ${finding.message}`).join('; '),
      });
    },
  };
}

function applicationErrorOf(error: GenerationError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

/**
 * Check 8 — duplicate detection (advisory). Content's three groups, for a
 * proposal, scoped to its subject. A retype or a constants-swap of something
 * already in content fails; a merely similar neighbour does not, since the
 * ranked neighbourhood is retrieval and never a verdict (DEC-M4-2) and a
 * pedagogically valuable variant is welcome (ADR-0021). Either way the verdict
 * names what was found, so the reviewer sees it.
 */
export function duplicateDetectionCheck(deps: { readonly content: ContentProposalChecks }): PrecheckRunner {
  return {
    check: 'duplicate_detection',
    async run(candidate, context) {
      const draft = toContentDraft(candidate);
      if (!draft.ok) return err(applicationErrorOf(draft.error));

      const subject = candidate.content.body['subject'] as string;
      const found = await deps.content.duplicates({ subject, content: draft.value.content }, context);
      if (!found.ok) return found;

      const { exactMatches, skeletonMatches, trigramMatches } = found.value;
      const ids = (group: readonly { itemVersionId: string }[]) => group.map((entry) => entry.itemVersionId).join(', ');
      const close = [
        ...(exactMatches.length === 0 ? [] : [`exact retype of ${ids(exactMatches)}`]),
        ...(skeletonMatches.length === 0 ? [] : [`same question with different constants as ${ids(skeletonMatches)}`]),
      ];
      const similar = trigramMatches.length === 0 ? '' : `; ${trigramMatches.length} merely similar, nearest at ${Math.max(...trigramMatches.map((entry) => entry.similarity ?? 0)).toFixed(2)}`;

      if (close.length > 0) return ok<CheckOutcome>({ outcome: 'fail', detail: `${close.join('; ')}${similar}` });
      return ok<CheckOutcome>({
        outcome: 'pass',
        detail: `no retype and no constants-swap of anything in ${subject}${similar}`,
      });
    },
  };
}
