import { ROLES } from '../../../../platform/auth/roles.js';
import { conceptMapOf, type ConceptMap } from '../../domain/concept-map.js';
import type { ConceptEvidence, MasteryState } from '../../domain/concept-state.js';
import { errorEntryFromEvidence, errorEntryFromGaveUp, type ErrorEntry, type GaveUpSlot } from '../../domain/error-entry.js';
import { advanceConcept, reconcileTransitions, type MasteryTransition, type OpenPromotion } from '../../domain/mastery-transition.js';
import type { MasteryEvidence } from '../../domain/mastery-evidence.js';
import type { MasteryRuleSet } from '../../domain/mastery-rule-set.js';
import { escalationDue, scheduleOf } from '../../domain/review-schedule.js';
import { placeInSession } from '../../domain/study-session.js';
import { err, type Result } from '../../domain/result.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import { LedgerAbort, type ApplicationContext, type Clock, type IdentifierFactory, type EvidenceCorrectionOutcome, type LearningLedger, type MasteryRuleSetRepository, type NewEvidenceRow } from '../ports.js';

/**
 * `RecordMasteryEvidence` — stores one attempt's evidence for a learner, places each response in a sitting, and recomputes the concepts it touched
 * (M7-14). The system's alone: it is what the relay's consumer runs, and it has no route.
 *
 * **At-most-once effect.** A response already stored for its attempt and slot is not stored again, and a delivery whose responses were all stored already
 * does nothing else: no sitting is placed, no state recomputed. So the same event twice produces one set of evidence and one recomputation.
 *
 * **Everything is one transaction for the learner:** the rows, their sittings, the states they produced and the transitions between states commit together or
 * not at all. Transitions are *advanced* from what is stored, one response at a time (`advanceConcept`); a promotion still awaiting verification is verified
 * under the rule set it was pinned to, which is read by identifier, and a new transition is pinned to the rule set in force now.
 *
 * **A re-score reaches the learner (D72, DEC-M7-20).** A response already stored whose outcome the score now changes is corrected in a row beside it, and one the score no longer
 * counts is withdrawn; a concept with a corrected response is re-advanced from nothing and its stored transitions are held against the result, the ones that disagree
 * revoked beside themselves. The error notebook is not corrected (D81).
 *
 * Responses are advanced in the order they were given, not the order they arrived; a delivery that arrives out of order is advanced as if last (D74).
 *
 * Which rule set decides is the taxonomy version's own (`currentFor`), read once per taxonomy version in the delivery; a sitting is placed with the idle gap of
 * the rule set of the evidence being placed.
 */
export const RECORD_MASTERY_EVIDENCE_POLICY = policy('RecordMasteryEvidence', [ROLES.system]);

export interface RecordMasteryEvidence {
  readonly learnerRef: string;
  readonly evidence: readonly MasteryEvidence[];
  /** Questions the learner gave up on in the attempt (M7-38): not evidence, and an entry each in the error notebook. Absent means none. */
  readonly gaveUp?: readonly GaveUpSlot[];
  /**
   * The attempt this is the evidence of. It is what lets a delivery that finds the attempt now has *less* evidence than was stored (a re-score that dropped a
   * question) correct the rows that no longer count; absent, it is read from the evidence, which is enough whenever the attempt still has any.
   */
  readonly attemptRef?: string;
}

export interface RecordedEvidence {
  /** Responses stored by this delivery. */
  readonly recorded: number;
  /** Responses already stored: a replay, and nothing was done for them. */
  readonly replayed: number;
  /** The concept maps this delivery changed, one per taxonomy version it touched. */
  readonly maps: readonly ConceptMap[];
  /** The transitions this delivery created, oldest first; a promotion verified within the delivery is already verified. */
  readonly transitions: readonly MasteryTransition[];
  /** Responses already stored whose outcome this delivery corrected, or withdrew (D72). */
  readonly corrected: number;
  /** Transitions revoked because the corrected evidence no longer supports them. They are kept, and no longer read as where the concept stands. */
  readonly revoked: readonly string[];
  /** Promotions stored by an earlier delivery that this one verified. */
  readonly verified: readonly { readonly transitionId: string; readonly verifiedAt: string }[];
  /** Concepts this delivery escalated to remediation because they lapsed often enough (M7-48): each is named once, in the delivery that escalated it. */
  readonly escalated: readonly { readonly taxonomyVersionId: string; readonly conceptIdentityId: string; readonly lapseCount: number }[];
  /** Escalations this delivery resolved (D85): the concept recovered, or a correction took the lapses it was escalated for away. The escalation is kept; a resolution sits beside it. */
  readonly resolved: readonly { readonly taxonomyVersionId: string; readonly conceptIdentityId: string; readonly reason: 'recovered' | 'lapses_corrected' }[];
}

export interface RecordMasteryEvidenceDependencies {
  readonly ledger: LearningLedger;
  readonly ruleSets: MasteryRuleSetRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
}

export class RecordMasteryEvidenceHandler {
  readonly name = 'RecordMasteryEvidence';
  readonly policy = RECORD_MASTERY_EVIDENCE_POLICY;

  constructor(private readonly deps: RecordMasteryEvidenceDependencies) {}

  async handle(command: RecordMasteryEvidence, context: ApplicationContext): Promise<Result<RecordedEvidence, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const taxonomies = [...new Set(command.evidence.map((e) => e.taxonomyVersionId))];
    const ruleSets = new Map<string, MasteryRuleSet>();
    for (const taxonomy of taxonomies) {
      const found = await this.deps.ruleSets.currentFor(taxonomy);
      if (!found.ok) return err(found.error);
      ruleSets.set(taxonomy, found.value);
    }

    const now = this.deps.clock.now();
    const rows: NewEvidenceRow[] = command.evidence.map((evidence) => ({
      evidenceId: this.deps.identifiers.next(),
      learnerRef: command.learnerRef,
      evidence,
      recordedAt: now,
    }));

    return this.deps.ledger.inTransaction(command.learnerRef, async (tx) => {
      // before the early return below: an attempt of nothing but give-ups stores no evidence and still has entries to make, and a replay of one writes nothing more
      await tx.insertErrorEntries((command.gaveUp ?? []).map((slot) => errorEntryFromGaveUp(command.learnerRef, this.deps.identifiers.next(), slot)), now);
      const stored = await tx.insertEvidence(rows);
      const storedIds = new Set(stored.map((r) => r.evidenceId));

      // A response stored by an earlier delivery whose outcome is not what the score now says is corrected, beside the row and not in it; a stored response the
      // score no longer counts is withdrawn. This is what makes a re-score reach the learner (D72), and it is also why a replayed delivery of a score that has
      // since been superseded is not a no-op: it finds the difference and writes it.
      const attempts = new Set([...command.evidence.map((e) => e.attemptRef), ...(command.attemptRef === undefined ? [] : [command.attemptRef])]);
      const corrections: { evidenceId: string; outcome: EvidenceCorrectionOutcome }[] = [];
      const corrected = new Map<string, Set<string>>();
      for (const attemptRef of attempts) {
        const now = new Map(command.evidence.filter((e) => e.attemptRef === attemptRef).map((e) => [e.slotRef, e.outcome]));
        for (const held of await tx.attemptEvidence(attemptRef)) {
          if (storedIds.has(held.evidenceId)) continue;
          const outcome: EvidenceCorrectionOutcome = now.get(held.slotRef) ?? 'withdrawn';
          if (outcome === held.outcome) continue;
          corrections.push({ evidenceId: held.evidenceId, outcome });
          const key = held.taxonomyVersionId;
          corrected.set(key, (corrected.get(key) ?? new Set<string>()).add(held.conceptIdentityId));
        }
      }
      await tx.correctEvidence(corrections, now);

      if (stored.length === 0 && corrections.length === 0) return Object.freeze({ recorded: 0, replayed: rows.length, maps: Object.freeze([]), transitions: Object.freeze([]), corrected: 0, revoked: Object.freeze([]), verified: Object.freeze([]), escalated: Object.freeze([]), resolved: Object.freeze([]) });

      const wrong = stored.flatMap((row) => errorEntryFromEvidence(command.learnerRef, this.deps.identifiers.next(), row.evidence) ?? []);
      await tx.insertErrorEntries(wrong satisfies ErrorEntry[], now);

      // placed in the order they were given, so the sittings read the way the learner worked; the partition does not depend on it
      let sessions = await tx.sessions();
      for (const row of [...stored].sort((a, b) => a.evidence.occurredAt.localeCompare(b.evidence.occurredAt))) {
        const thresholds = ruleSets.get(row.evidence.taxonomyVersionId)!.thresholds;
        const placed = placeInSession(sessions, row.evidence.occurredAt, thresholds.session.idleGapMinutes, this.deps.identifiers.next());
        const session = placed.sessions.find((s) => s.sessionId === placed.sessionId)!;
        await tx.placeEvidence(row.evidenceId, session, placed.absorbed);
        sessions = placed.sessions;
      }

      const maps: ConceptMap[] = [];
      const transitions: MasteryTransition[] = [];
      const verified: { transitionId: string; verifiedAt: string }[] = [];
      const revoked: string[] = [];
      const escalated: { taxonomyVersionId: string; conceptIdentityId: string; lapseCount: number }[] = [];
      const resolved: { taxonomyVersionId: string; conceptIdentityId: string; reason: 'recovered' | 'lapses_corrected' }[] = [];
      const asOf = now.toISOString();
      // only the taxonomy versions this delivery actually changed: one whose responses were all stored already, and none corrected, is left as it is
      for (const taxonomy of new Set([...stored.map((r) => r.evidence.taxonomyVersionId), ...corrected.keys()])) {
        const arrived = stored.filter((r) => r.evidence.taxonomyVersionId === taxonomy).map((r) => r.evidence.conceptIdentityId);
        const changed = corrected.get(taxonomy) ?? new Set<string>();
        const touched = [...new Set([...arrived, ...changed])];
        // a correction can touch a taxonomy version no response of this delivery names (every question dropped), whose rule set has not been read yet
        if (!ruleSets.has(taxonomy)) {
          const found = await this.deps.ruleSets.currentFor(taxonomy);
          if (!found.ok) throw new LedgerAbort(found.error);
          ruleSets.set(taxonomy, found.value);
        }
        const ruleSet = ruleSets.get(taxonomy)!;
        const evidenceByConcept: ReadonlyMap<string, readonly ConceptEvidence[]> = await tx.conceptEvidence(taxonomy, touched);
        const map = conceptMapOf(command.learnerRef, taxonomy, evidenceByConcept, ruleSet.thresholds, asOf);

        const tracking = await tx.conceptTracking(taxonomy, touched);
        const floors = new Map<string, MasteryState | null>();
        const current = { ruleSetId: ruleSet.ruleSetId, ruleSetHash: ruleSet.thresholdsHash, thresholds: ruleSet.thresholds };
        for (const concept of touched) {
          // every touched concept has the response that touched it — unless a correction withdrew the last one it had
          const all = evidenceByConcept.get(concept) ?? [];
          const known = tracking.get(concept)!;
          let open: OpenPromotion | null = null;
          if (known.open !== null) {
            const pinned = await this.deps.ruleSets.byId(known.open.ruleSetId);
            if (!pinned.ok) throw new LedgerAbort(pinned.error);
            open = { transitionId: known.open.transitionId, occurredAt: known.open.occurredAt, qualifyingEvidence: known.open.qualifyingEvidence, rules: { ruleSetId: pinned.value.ruleSetId, ruleSetHash: pinned.value.thresholdsHash, thresholds: pinned.value.thresholds } };
          }
          if (changed.has(concept)) {
            // A response of this concept was corrected: its history is re-advanced from nothing over the evidence as it now stands, held against what is stored,
            // and everything from the first disagreement on is revoked and replaced. A promotion granted on an outcome that changed does not survive (D72).
            const replayed = advanceConcept({ conceptIdentityId: concept, prior: [], arriving: all, held: false, floor: null, open: null, current, newTransitionId: () => this.deps.identifiers.next() });
            const settled = reconcileTransitions(await tx.activeTransitions(taxonomy, concept), replayed.created);
            await tx.revokeTransitions(settled.revoked, now);
            await tx.saveTransitions(taxonomy, settled.created, now);
            for (const done of settled.created.filter((t) => t.verifiedAt !== null)) await tx.resolveErrorEntries(done.transitionId);
            revoked.push(...settled.revoked);
            transitions.push(...settled.created);
            floors.set(concept, replayed.floor);
            continue;
          }
          const advanced = advanceConcept({
            conceptIdentityId: concept,
            prior: all.filter((e) => !storedIds.has(e.evidenceId)),
            arriving: all.filter((e) => storedIds.has(e.evidenceId)),
            held: known.held,
            floor: known.floor,
            open,
            current,
            newTransitionId: () => this.deps.identifiers.next(),
          });
          await tx.saveTransitions(taxonomy, advanced.created, now);
          for (const v of advanced.verified) {
            await tx.verifyTransition(v.transitionId, v.verifiedAt, v.verifyingEvidence);
            verified.push({ transitionId: v.transitionId, verifiedAt: v.verifiedAt });
          }
          // a promotion verified at once, and one verified now that was stored earlier, each clears the concept's earlier open entries
          for (const done of [...advanced.created.filter((t) => t.verifiedAt !== null).map((t) => t.transitionId), ...advanced.verified.map((v) => v.transitionId)]) {
            await tx.resolveErrorEntries(done);
          }
          transitions.push(...advanced.created);
          floors.set(concept, advanced.floor);
        }
        await tx.saveConceptStates(taxonomy, map.conceptStates, ruleSet.ruleSetId, floors);
        // a concept left with no evidence is unassessed, and unassessed is the absence of a state: the one it had before the correction goes
        await tx.dropConceptStates(taxonomy, [...changed].filter((concept) => (evidenceByConcept.get(concept) ?? []).length === 0));
        // The schedule is derived as the state is: from the evidence as it now stands, for every concept the delivery touched. A rule set published before the review
        // values existed has none, and its concepts are not scheduled until one that has them is in force (DEC-M7-24).
        const review = ruleSet.thresholds.review;
        if (review !== undefined) {
          const schedules = touched.flatMap((concept) => scheduleOf(concept, evidenceByConcept.get(concept) ?? [], review) ?? []);
          await tx.saveReviewSchedules(taxonomy, schedules, ruleSet.ruleSetId);
          // A concept that has lapsed often enough is not given a still shorter interval; it is escalated (DEC-M7-25). One that has recovered is not escalated, and its
          // escalation, if it has one, is resolved: the same fold decides both, so an escalation stands exactly while this would make it (D85, DEC-M7-27).
          const strong = new Set(map.conceptStates.filter((state) => state.state === 'strong').map((state) => state.conceptIdentityId));
          const lapsed = schedules.filter((schedule) => escalationDue(schedule, review) && !strong.has(schedule.conceptIdentityId));
          const fresh = new Set(await tx.escalate(taxonomy, lapsed.map((s) => ({ conceptIdentityId: s.conceptIdentityId, lapseCount: s.lapseCount })), ruleSet.ruleSetId, now));
          escalated.push(...lapsed.filter((s) => fresh.has(s.conceptIdentityId)).map((s) => ({ taxonomyVersionId: taxonomy, conceptIdentityId: s.conceptIdentityId, lapseCount: s.lapseCount })));
          const standing = new Set(lapsed.map((s) => s.conceptIdentityId));
          const lapsedOften = new Set(schedules.filter((schedule) => escalationDue(schedule, review)).map((schedule) => schedule.conceptIdentityId));
          const settled = await tx.resolveEscalations(
            taxonomy,
            touched.filter((concept) => !standing.has(concept)).map((concept) => ({ conceptIdentityId: concept, reason: lapsedOften.has(concept) ? ('recovered' as const) : ('lapses_corrected' as const) })),
            ruleSet.ruleSetId,
            now,
          );
          resolved.push(...settled.map((r) => ({ taxonomyVersionId: taxonomy, conceptIdentityId: r.conceptIdentityId, reason: r.reason })));
          await tx.dropReviewSchedules(taxonomy, [...changed].filter((concept) => (evidenceByConcept.get(concept) ?? []).length === 0));
        }
        maps.push(map);
      }
      return Object.freeze({ recorded: stored.length, replayed: rows.length - stored.length, maps: Object.freeze(maps), transitions: Object.freeze(transitions), corrected: corrections.length, revoked: Object.freeze(revoked), verified: Object.freeze(verified), escalated: Object.freeze(escalated), resolved: Object.freeze(resolved) });
    });
  }
}

