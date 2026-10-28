import type { PrincipalRef } from '@questionbank/domain-types';
import type { AssessmentForLearning } from '../../contexts/assessment/public/composition.js';
import type { ContentForLearning } from '../../contexts/content/public/composition.js';
import type { ScoringForLearning } from '../../contexts/scoring/public/composition.js';
import {
  EVIDENCE_OUTCOMES,
  createMasteryEvidence,
  type EvidenceSourceResult,
  type MasteryEvidence,
  type GaveUpSlot,
  type MasteryEvidenceSource,
  type PaceSlot,
  type PaceSlotSource,
  type ReportSlot,
  type ReportSlotSource,
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
 * **The evidence is dated by the response, not by the score** (M7-11). Scoring writes every slot of an attempt at once, so its instant is one value per
 * attempt, and a study sitting or a forty-eight-hour gap measured on it would compute from data in which only one value is possible. Assessment's
 * response log holds the instant of the answer that stood at submission, per slot; that is `occurredAt`, and the scoring instant is kept as `scoredAt`.
 * A slot scoring counted as a response that the log has no response standing for is a disagreement between two contexts, and fails the attempt whole.
 *
 * **A question the learner gave up on is not evidence and is an entry in the error notebook (M7-38, DEC-M7-16).** Scoring says such a slot is unattempted, as it says of
 * one never touched; assessment's response timings say which of the unattempted were given up on, and when. Those are resolved to a concept the way evidence is and
 * handed on as `gaveUp`, to make an entry and to move no mastery state.
 *
 * Which generation of the score is read is the current one: a re-score that corrected an outcome corrects the evidence.
 */

/** Learning's error shape, built structurally: the root names nothing of the context but its public composition. */
const applicationError = <K extends 'NotFound' | 'Unavailable'>(kind: K, code: string, message: string) => Object.freeze({ kind, code, message });

const SYSTEM: PrincipalRef = { kind: 'system', id: '00000000-0000-4000-8000-0000000000f7', roleContext: [ROLES.system] };

/** Content's own cap on one call; an attempt is seventy-five slots, so this is a bound and not a cost. */
const TAXONOMY_BATCH = 500;

export interface LearningEvidenceDeps {
  readonly scoring: ScoringForLearning;
  readonly content: ContentForLearning;
  /** Per-response instants (M7-11): the instant mastery is measured on, which scoring does not have. */
  readonly assessment: AssessmentForLearning;
}

/**
 * What an `AttemptScored` event names of the attempt, and the instant it was scored. Structural, so the root
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
    scoredAt: event.occurredAt.toISOString(),
  };
}

export class ScoredAttemptEvidenceSource implements MasteryEvidenceSource, ReportSlotSource, PaceSlotSource {
  constructor(private readonly deps: LearningEvidenceDeps) {}

  /**
   * Every slot of the scored attempt, for the diagnostic report (M7-41): its concept, what it was worth and what it earned, as scoring says and as decimal text.
   * Unlike evidence this includes the slots that were not responses — the report attributes the marks a skipped question cost to its concept (DEC-M7-21). All or
   * nothing, as evidence is: a slot whose item version content cannot resolve fails the attempt, so a report never ranks from part of an exam.
   */
  async slotsForScoredAttempt(attempt: ScoredAttemptRef): Promise<{ ok: true; value: { learnerRef: string; slots: readonly ReportSlot[] } } | { ok: false; error: import('../../contexts/learning/public/composition.js').EvidenceSourceFailure }> {
    const context = { principal: SYSTEM, correlationId: `learning-report:${attempt.scoreRecordId}` };
    const outcomes = await this.deps.scoring.outcomesForAttempt.handle({ attemptId: attempt.attemptId }, context);
    if (!outcomes.ok) {
      return outcomes.error.kind === 'NotFound'
        ? { ok: false, error: { code: 'ATTEMPT_NOT_SCORED', message: `attempt ${attempt.attemptId} has no score record` } }
        : { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: `scoring could not be read: ${outcomes.error.code}` } };
    }
    const timings = await this.deps.assessment.responseTimings.handle({ attemptId: attempt.attemptId }, context);
    if (!timings.ok) return { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: `assessment could not be read: ${timings.error.code}` } };

    const wanted = [...new Set(outcomes.value.map((slot) => slot.itemVersionId))];
    const byVersion = new Map<string, { conceptIdentityId: string; taxonomyVersionId: string }>();
    for (let at = 0; at < wanted.length; at += TAXONOMY_BATCH) {
      const taxonomy = await this.deps.content.taxonomyForItemVersions.handle({ itemVersionIds: wanted.slice(at, at + TAXONOMY_BATCH) }, context);
      if (!taxonomy.ok) return { ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: `content could not be read: ${taxonomy.error.code}` } };
      for (const entry of taxonomy.value) byVersion.set(entry.itemVersionId, entry);
    }
    const unresolved = wanted.filter((id) => !byVersion.has(id));
    if (unresolved.length > 0) {
      return { ok: false, error: { code: 'ITEM_VERSION_UNRESOLVED', message: `content has no published, tagged version for ${unresolved.length} of the attempt's item versions`, itemVersionIds: unresolved } };
    }
    const slots: ReportSlot[] = outcomes.value.map((slot) => {
      const tag = byVersion.get(slot.itemVersionId)!;
      return Object.freeze({ slotRef: slot.slotRef, conceptIdentityId: tag.conceptIdentityId, taxonomyVersionId: tag.taxonomyVersionId, outcome: slot.outcome, marksAwarded: slot.marksAwarded, marksAvailable: slot.marksAvailable });
    });
    return { ok: true, value: { learnerRef: timings.value.learnerRef, slots: Object.freeze(slots) } };
  }

  /**
   * The responses of the learner's own attempt with the time each took (M7-46): scoring says which were given and how they came out, assessment says how long the
   * response log counted and what it lost, content says what each is about and how hard it was authored to be. An attempt that is not the learner's is `NotFound`, the
   * same answer as one that does not exist. All or nothing, as evidence is.
   */
  async paceSlotsForAttempt(learnerRef: string, attemptId: string) {
    const context = { principal: SYSTEM, correlationId: `learning-pace:${attemptId}` };
    const notFound = () => ({ ok: false as const, error: applicationError('NotFound', 'ATTEMPT_NOT_FOUND', 'there is no scored attempt of yours with that id') });
    const unavailable = (what: string, code: string) => ({ ok: false as const, error: applicationError('Unavailable', 'SOURCE_UNAVAILABLE', `${what} could not be read: ${code}`) });

    const timings = await this.deps.assessment.responseTimings.handle({ attemptId }, context);
    if (!timings.ok) return timings.error.kind === 'NotFound' || timings.error.kind === 'PreconditionFailed' ? notFound() : unavailable('assessment', timings.error.code);
    if (timings.value.learnerRef !== learnerRef) return notFound();

    const outcomes = await this.deps.scoring.outcomesForAttempt.handle({ attemptId }, context);
    if (!outcomes.ok) return outcomes.error.kind === 'NotFound' ? notFound() : unavailable('scoring', outcomes.error.code);

    const given = outcomes.value.filter((slot) => (EVIDENCE_OUTCOMES as readonly string[]).includes(slot.outcome));
    const wanted = [...new Set(given.map((slot) => slot.itemVersionId))];
    const byVersion = new Map<string, { conceptIdentityId: string; taxonomyVersionId: string; difficultyEstimate: string }>();
    for (let at = 0; at < wanted.length; at += TAXONOMY_BATCH) {
      const taxonomy = await this.deps.content.taxonomyForItemVersions.handle({ itemVersionIds: wanted.slice(at, at + TAXONOMY_BATCH) }, context);
      if (!taxonomy.ok) return unavailable('content', taxonomy.error.code);
      for (const entry of taxonomy.value) byVersion.set(entry.itemVersionId, entry);
    }
    const timed = new Map(timings.value.slots.map((timing) => [timing.slotRef, timing]));
    const slots: PaceSlot[] = [];
    for (const slot of given) {
      const tag = byVersion.get(slot.itemVersionId);
      const timing = timed.get(slot.slotRef);
      if (tag === undefined || timing === undefined) {
        return { ok: false as const, error: applicationError('Unavailable', 'SOURCE_UNAVAILABLE', `slot ${slot.slotRef} cannot be resolved to a concept and a time`) };
      }
      slots.push(
        Object.freeze({
          slotRef: slot.slotRef,
          conceptIdentityId: tag.conceptIdentityId,
          taxonomyVersionId: tag.taxonomyVersionId,
          difficultyEstimate: tag.difficultyEstimate as PaceSlot['difficultyEstimate'],
          outcome: slot.outcome as PaceSlot['outcome'],
          timeOnItemMs: timing.timeOnItemMs,
          discardedMs: timing.discardedMs,
          unclosedVisits: timing.unclosedVisits,
        }),
      );
    }
    return { ok: true as const, value: Object.freeze(slots) };
  }

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


    const timings = await this.deps.assessment.responseTimings.handle({ attemptId: attempt.attemptId }, context);
    if (!timings.ok) return fail('SOURCE_UNAVAILABLE', `assessment could not be read: ${timings.error.code}`);
    const respondedAt = new Map(timings.value.slots.map((timing) => [timing.slotRef, timing.respondedAt]));
    const gaveUpAt = new Map(timings.value.slots.map((timing) => [timing.slotRef, timing.gaveUpAt]));

    const gaveUpSlots = outcomes.value.filter((slot) => slot.outcome === 'unattempted' && (gaveUpAt.get(slot.slotRef) ?? null) !== null);
    const wanted = [...new Set([...given, ...gaveUpSlots].map((slot) => slot.itemVersionId))];
    const byVersion = new Map<string, { conceptIdentityId: string; taxonomyVersionId: string; difficultyEstimate: string }>();
    for (let at = 0; at < wanted.length; at += TAXONOMY_BATCH) {
      const taxonomy = await this.deps.content.taxonomyForItemVersions.handle(
        { itemVersionIds: wanted.slice(at, at + TAXONOMY_BATCH) },
        context,
      );
      if (!taxonomy.ok) return fail('SOURCE_UNAVAILABLE', `content could not be read: ${taxonomy.error.code}`);
      for (const entry of taxonomy.value) byVersion.set(entry.itemVersionId, entry);
    }

    const withoutInstant = given.filter((slot) => (respondedAt.get(slot.slotRef) ?? null) === null).map((slot) => slot.slotRef);
    if (withoutInstant.length > 0) {
      return {
        ok: false,
        error: {
          code: 'RESPONSE_INSTANT_UNRESOLVED',
          message: `scoring counted ${withoutInstant.length} slots as responses that the response log has no response standing for`,
          slotRefs: withoutInstant,
        },
      };
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
        occurredAt: respondedAt.get(slot.slotRef),
        scoredAt: attempt.scoredAt,
      });
      if (!made.ok && made.error.code === 'EVIDENCE_INSTANT_ORDER') {
        return { ok: false, error: { code: 'RESPONSE_INSTANT_UNRESOLVED', message: `slot ${slot.slotRef}: ${made.error.message}`, slotRefs: [slot.slotRef] } };
      }
      if (!made.ok) return fail('SOURCE_UNAVAILABLE', `slot ${slot.slotRef} produced invalid evidence: ${made.error.code}`);
      evidence.push(made.value);
    }

    const gaveUp: GaveUpSlot[] = gaveUpSlots.map((slot) => {
      const tag = byVersion.get(slot.itemVersionId)!;
      return Object.freeze({
        attemptRef: attempt.attemptId,
        slotRef: slot.slotRef,
        itemVersionRef: slot.itemVersionId,
        conceptIdentityId: tag.conceptIdentityId,
        taxonomyVersionId: tag.taxonomyVersionId,
        occurredAt: gaveUpAt.get(slot.slotRef) as string,
      });
    });

    return { ok: true, value: Object.freeze({ learnerRef: timings.value.learnerRef, evidence: Object.freeze(evidence), notEvidence, gaveUp: Object.freeze(gaveUp) }) };
  }
}

function fail(code: 'ATTEMPT_NOT_SCORED' | 'SOURCE_UNAVAILABLE', message: string): EvidenceSourceResult {
  return { ok: false, error: { code, message } };
}
