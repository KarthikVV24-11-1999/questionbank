import type { PrincipalRef } from '@questionbank/domain-types';
import type { ContentForLearning } from '../../contexts/content/public/composition.js';
import type { ScoringForLearning } from '../../contexts/scoring/public/composition.js';
import {
  EVIDENCE_OUTCOMES,
  createMasteryEvidence,
  type EvidenceSourceResult,
  type MasteryEvidence,
  type MasteryEvidenceSource,
  type ScoredAttemptRef,
} from '../../contexts/learning/public/composition.js';
import { ROLES } from '../auth/roles.js';

/**
 * Learning's evidence, assembled from the two seams (M7-05, DEC-M7-1) — the only place scoring's answer to *what happened to
 * each slot* and content's answer to *what each item version is about* are joined, on item version.
 *
 * It lives in the composition root because it is the one place that may name scoring, content and learning together; Learning
 * defines the port (`MasteryEvidenceSource`) and has no production import of either context, and neither of them imports it.
 *
 * **One response is one piece of evidence for the item's primary concept, and nothing for its secondary tags** (DEC-M7-5):
 * content's answer holds one concept per version, and the weights in `item_taxonomy_tag` are not read anywhere on this path.
 * A calibrated multi-concept rule needs item statistics that do not exist yet, and the evidence rows keep the item version so
 * it can recompute from history rather than re-collect.
 *
 * **All or nothing.** An attempt with one slot whose item version content cannot resolve produces a failure naming the
 * version and no evidence for the other slots: a mastery update from part of an attempt is a wrong update that nothing would
 * flag, and the caller can retry the whole attempt.
 *
 * Which generation of the score is read is the current one: a re-score that corrected an outcome corrects the evidence.
 */

const SYSTEM: PrincipalRef = { kind: 'system', id: '00000000-0000-4000-8000-0000000000f7', roleContext: [ROLES.system] };

/** Content's own cap on one call; an attempt is seventy-five slots, so this is a bound and not a cost. */
const TAXONOMY_BATCH = 500;

export interface LearningEvidenceDeps {
  readonly scoring: ScoringForLearning;
  readonly content: ContentForLearning;
}

/**
 * What an `AttemptScored` event names of the attempt, and the instant the evidence is attributed to. Structural, so the root
 * takes the event as scoring's relay hands it on and names nothing of scoring but its seam.
 */
export interface ScoredAttemptEvent {
  readonly occurredAt: Date;
  readonly payload: { readonly attemptId: string; readonly scoreRecordId: string };
}

export function scoredAttemptOf(event: ScoredAttemptEvent): ScoredAttemptRef {
  return {
    attemptId: event.payload.attemptId,
    scoreRecordId: event.payload.scoreRecordId,
    occurredAt: event.occurredAt.toISOString(),
  };
}

export class ScoredAttemptEvidenceSource implements MasteryEvidenceSource {
  constructor(private readonly deps: LearningEvidenceDeps) {}

  async evidenceForScoredAttempt(attempt: ScoredAttemptRef): Promise<EvidenceSourceResult> {
    const context = { principal: SYSTEM, correlationId: `learning-evidence:${attempt.scoreRecordId}` };

    const outcomes = await this.deps.scoring.outcomesForAttempt.handle({ attemptId: attempt.attemptId }, context);
    if (!outcomes.ok) {
      return outcomes.error.kind === 'NotFound'
        ? fail('ATTEMPT_NOT_SCORED', `attempt ${attempt.attemptId} has no score record`)
        : fail('SOURCE_UNAVAILABLE', `scoring could not be read: ${outcomes.error.code}`);
    }

    const given = outcomes.value.filter((slot) => (EVIDENCE_OUTCOMES as readonly string[]).includes(slot.outcome));
    const notEvidence = outcomes.value.length - given.length;

    const wanted = [...new Set(given.map((slot) => slot.itemVersionId))];
    const byVersion = new Map<string, { conceptIdentityId: string; taxonomyVersionId: string; difficultyEstimate: string }>();
    for (let at = 0; at < wanted.length; at += TAXONOMY_BATCH) {
      const taxonomy = await this.deps.content.taxonomyForItemVersions.handle(
        { itemVersionIds: wanted.slice(at, at + TAXONOMY_BATCH) },
        context,
      );
      if (!taxonomy.ok) return fail('SOURCE_UNAVAILABLE', `content could not be read: ${taxonomy.error.code}`);
      for (const entry of taxonomy.value) byVersion.set(entry.itemVersionId, entry);
    }

    const unresolved = wanted.filter((id) => !byVersion.has(id));
    if (unresolved.length > 0) {
      return {
        ok: false,
        error: {
          code: 'ITEM_VERSION_UNRESOLVED',
          message: `content has no published, tagged version for ${unresolved.length} of the attempt's item versions`,
          itemVersionIds: unresolved,
        },
      };
    }

    const evidence: MasteryEvidence[] = [];
    for (const slot of given) {
      const tag = byVersion.get(slot.itemVersionId)!;
      const made = createMasteryEvidence({
        attemptRef: attempt.attemptId,
        slotRef: slot.slotRef,
        itemVersionRef: slot.itemVersionId,
        conceptIdentityId: tag.conceptIdentityId,
        taxonomyVersionId: tag.taxonomyVersionId,
        outcome: slot.outcome,
        difficultyEstimate: tag.difficultyEstimate,
        occurredAt: attempt.occurredAt,
      });
      if (!made.ok) return fail('SOURCE_UNAVAILABLE', `slot ${slot.slotRef} produced invalid evidence: ${made.error.code}`);
      evidence.push(made.value);
    }

    return { ok: true, value: Object.freeze({ evidence: Object.freeze(evidence), notEvidence }) };
  }
}

function fail(code: 'ATTEMPT_NOT_SCORED' | 'SOURCE_UNAVAILABLE', message: string): EvidenceSourceResult {
  return { ok: false, error: { code, message } };
}
