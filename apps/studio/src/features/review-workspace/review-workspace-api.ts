import { ApiProblemError, createClient, type ApiClient } from '@questionbank/contracts/client';
import {
  AuthoringItemVersionSchema,
  AuthoringItemSchema,
  AuthoringValidationReportSchema,
  DuplicateCandidatesResultSchema,
  QueueHealthResultSchema,
  ReviewAssignmentSchema,
} from '@questionbank/contracts/content-schemas';
import type {
  ClaimedItemBundle,
  DecisionSubmission,
  DuplicateCandidate,
  ReviewWorkspaceApi,
} from './review-workspace-model.js';

/** Strips an explicit `similarity: undefined` down to genuinely absent — `exactOptionalPropertyTypes` treats the two differently. */
function toDuplicateCandidate(candidate: {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly similarity?: number | undefined;
}): DuplicateCandidate {
  return {
    itemId: candidate.itemId,
    itemVersionId: candidate.itemVersionId,
    subject: candidate.subject,
    ...(candidate.similarity === undefined ? {} : { similarity: candidate.similarity }),
  };
}

/**
 * The live `ReviewWorkspaceApi` (M4-38). Wires the workspace's one-bundle
 * read through five requests — claim, the version, its validation findings,
 * its duplicate candidates, and the subject's queue depth — because that is
 * what the shipped surface actually is: `ClaimNextForReview` (M4-27) returns
 * the assignment alone, not the item's content, and nothing added a
 * combined read since. Composed here rather than asked of the server as one
 * call, so the port stays honest about what the wire actually offers.
 *
 * **The solution region is `not_available` on every claim, named as D37 in
 * `review-workspace-model.ts`** — no authoring-side query returns a
 * draft/in-review solution's content by item version id today.
 *
 * **`recordDecision` routes by outcome, not by a caller-supplied path.**
 * `approve_with_edits` always reaches `ApproveWithEdits` (M4-29,
 * ADR-0018) — the endpoint that actually derives the edited version; the
 * other three outcomes reach the ordinary `RecordItemReviewDecision` M3
 * already ships. Routing on `submission.outcome` rather than trusting a
 * caller to pick correctly is what keeps an approval with edits from ever
 * landing as a plain decision that silently drops the edit.
 */

export interface LiveReviewWorkspaceApiConfig {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly client?: ApiClient;
}

export function createLiveReviewWorkspaceApi(config: LiveReviewWorkspaceApiConfig): ReviewWorkspaceApi {
  const client = config.client ?? createClient({ baseUrl: config.baseUrl, getToken: config.getToken });

  return {
    async claimNext(subject) {
      let claimed;
      try {
        claimed = await client.request({
          path: '/v1/authoring/review/assignments',
          method: 'POST',
          body: { subject },
          responseSchema: ReviewAssignmentSchema,
        });
      } catch (error) {
        // NOT_FOUND is the shape "nothing is eligible right now" takes — an
        // empty queue, not a failure (ClaimNextForReviewHandler, M4-18/M4-27).
        if (error instanceof ApiProblemError && error.problem.code === 'NotFound') return null;
        throw error;
      }

      const [version, validationReport, duplicateResult, queueHealth] = await Promise.all([
        client.request({
          path: `/v1/authoring/items/${claimed.itemId}/versions/${claimed.itemVersionId}`,
          responseSchema: AuthoringItemVersionSchema,
        }),
        client.request({
          path: `/v1/authoring/items/${claimed.itemId}/validation-findings`,
          responseSchema: AuthoringValidationReportSchema,
        }),
        client.request({
          path: `/v1/authoring/review/item-versions/${claimed.itemVersionId}/duplicate-candidates`,
          responseSchema: DuplicateCandidatesResultSchema,
        }),
        client.request({
          path: '/v1/authoring/review/queue-health',
          responseSchema: QueueHealthResultSchema,
        }),
      ]);

      const depthForSubject = queueHealth.depthBySubject.find((row) => row.subject === subject)?.depth ?? 0;

      const bundle: ClaimedItemBundle = {
        assignment: {
          assignmentId: claimed.assignmentId,
          itemId: claimed.itemId,
          itemVersionId: claimed.itemVersionId,
          subject: claimed.subject,
          leaseExpiresAt: claimed.leaseExpiresAt,
        },
        version: {
          versionId: version.versionId,
          versionNo: version.versionNo,
          itemType: version.itemType,
          stem: version.stem,
          responseSpec: version.responseSpec,
          taxonomyTags: version.taxonomyTags,
          difficultyEstimate: version.difficultyEstimate,
          provenance: version.provenance,
        },
        validation: { blocking: validationReport.blocking, warnings: validationReport.warnings },
        duplicates: {
          state: duplicateResult.state,
          exact: duplicateResult.exactMatches.map(toDuplicateCandidate),
          skeleton: duplicateResult.skeletonMatches.map(toDuplicateCandidate),
          trigram: duplicateResult.trigramMatches.map(toDuplicateCandidate),
          ...(duplicateResult.computedAt === undefined ? {} : { computedAt: duplicateResult.computedAt }),
          asOf: duplicateResult.asOf,
        },
        // D37 — see the file header.
        solution: { state: 'not_available' },
        queueDepth: depthForSubject,
      };
      return bundle;
    },

    async recordDecision(submission: DecisionSubmission): Promise<void> {
      if (submission.outcome === 'approve_with_edits') {
        await client.request({
          path: `/v1/authoring/review/items/${submission.itemId}/versions/${submission.itemVersionId}/approval-with-edits`,
          method: 'POST',
          body: {
            edits: submission.edits ?? {},
            candidatesShownIds: submission.candidatesShownIds,
            assignmentId: submission.assignmentId,
          },
          responseSchema: AuthoringItemSchema,
        });
        return;
      }

      await client.request({
        path: `/v1/authoring/items/${submission.itemId}/review-decisions`,
        method: 'POST',
        body: {
          itemVersionId: submission.itemVersionId,
          outcome: submission.outcome,
          candidatesShownIds: submission.candidatesShownIds,
          ...(submission.justification === undefined ? {} : { justification: submission.justification }),
          ...(submission.reasonCode === undefined ? {} : { reasonCode: submission.reasonCode }),
          ...(submission.duplicateOfItemId === undefined ? {} : { duplicateOfItemId: submission.duplicateOfItemId }),
          assignmentId: submission.assignmentId,
        },
        responseSchema: AuthoringItemSchema,
      });
    },
  };
}
