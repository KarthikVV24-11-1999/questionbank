import { assessPromotion, deriveConceptState, inGivenOrder, type ConceptEvidence, type MasteryState } from './concept-state.js';
import type { MasteryThresholds } from './mastery-rule-set.js';

/**
 * `MasteryTransition` — a concept's state changing, with the responses that changed it (M7-15, DOMAIN-MODEL 12.2).
 *
 * **A `weak → strong` transition with `verifiedAt` set is one north-star event.** `isNorthStarEvent` says so, and is the only place that does.
 *
 * **`from` is the weakest state the concept was in since it was last `strong`** (or since it was first assessed), not merely the state it was in the instant before. Accuracy
 * moves one response at a time, so a concept that was weak passes through `developing` on the way up; read as "the state just before", a promotion's `from` would almost
 * never be `weak` and the north-star event would almost never happen. This reading is what "turned a weakness into a strength" means (DEC-M7-9).
 *
 * **Qualifying is not verifying.** Reaching `strong` on the five clauses of D-002 is a *qualification*: it is recorded at once, with the responses that
 * qualified it and `verifiedAt` empty. It becomes a gain only when confirmed by further correct responses on **different items**, in a **different
 * session**, at least the rule set's gap **after** the qualifying evidence: "immediate post-remediation correctness alone never counts — it is confounded by
 * recency". The three conditions are evaluated separately, and a refusal says which one failed (`VerificationRefusal`) — the clauses are measured on the
 * instant of the response and on the learner's sitting (M7-11, M7-13), and a verification that cannot tell them apart is the defect this track opened with.
 *
 * **A regression is recorded, never a deletion.** When a concept that was held at `strong` stops being so (its recent accuracy falls, or it decays below the
 * floor) a transition with `isRegression` is appended; the gain it reverses stays exactly as it was.
 *
 * **Pinned on what decided it.** Every transition names the rule set it was decided under, and a pending qualification is verified under the thresholds it
 * was pinned to, so publishing a new rule set never restates a decision already made. History is *advanced*, one response at a time, from what is stored; it
 * is not replayed under today's thresholds.
 *
 * Pure: no clock (every instant is a response's or the caller's), no identifiers (the caller names new transitions).
 */
export interface MasteryTransition {
  readonly transitionId: string;
  readonly conceptIdentityId: string;
  readonly from: MasteryState;
  readonly to: MasteryState;
  /** The responses that qualified a promotion: the recent window the accuracy and the band were measured over. Empty for a regression. */
  readonly qualifyingEvidence: readonly string[];
  /** The responses that confirmed it; empty until verified. */
  readonly verifyingEvidence: readonly string[];
  /** The instant of the response that caused the transition, or of the response a decay was observed at. */
  readonly occurredAt: string;
  /** The instant of the response that completed the verification, or `null`. Always `null` for a regression. */
  readonly verifiedAt: string | null;
  readonly isRegression: boolean;
  readonly ruleSetId: string;
  readonly ruleSetHash: string;
}

const STRENGTH: readonly MasteryState[] = ['unassessed', 'weak', 'developing', 'strong'];
const weaker = (a: MasteryState | null, b: MasteryState): MasteryState => (a === null || STRENGTH.indexOf(b) < STRENGTH.indexOf(a) ? b : a);

export function isNorthStarEvent(transition: MasteryTransition): boolean {
  return transition.from === 'weak' && transition.to === 'strong' && transition.verifiedAt !== null && !transition.isRegression;
}

export type VerificationRefusal = 'NOT_ENOUGH_CORRECT' | 'WITHIN_GAP' | 'SAME_SESSION' | 'NOT_ENOUGH_NEW_ITEMS';

export type Verification =
  | { readonly verified: true; readonly verifying: readonly ConceptEvidence[]; readonly verifiedAt: string }
  | { readonly verified: false; readonly refusal: VerificationRefusal };

const HOUR_MS = 3_600_000;
const at = (instant: string): number => Date.parse(instant);

/** What a pending qualification needs to be verified: when it happened and the responses behind it. */
export interface PendingQualification {
  readonly occurredAt: string;
  readonly qualifyingEvidence: readonly string[];
}

/**
 * Whether the responses given since a qualification confirm it, under the thresholds it was pinned to. Three conditions, each its own refusal, in this
 * order of precedence: nothing correct since; none far enough after (`WITHIN_GAP`); none in a sitting the qualifying evidence was not in (`SAME_SESSION`);
 * too few on items the qualifying evidence did not use (`NOT_ENOUGH_NEW_ITEMS`).
 */
export function assessVerification(pending: PendingQualification, evidence: readonly ConceptEvidence[], thresholds: MasteryThresholds): Verification {
  const ordered = inGivenOrder(evidence);
  const qualifying = ordered.filter((e) => pending.qualifyingEvidence.includes(e.evidenceId));
  const lastQualifying = ordered.findLastIndex((e) => pending.qualifyingEvidence.includes(e.evidenceId));
  const qualifyingSessions = new Set(qualifying.map((e) => e.sessionId));
  const qualifyingItems = new Set(qualifying.map((e) => e.itemVersionRef));

  const since = ordered.slice(lastQualifying + 1).filter((e) => e.outcome === 'correct');
  if (since.length === 0) return { verified: false, refusal: 'NOT_ENOUGH_CORRECT' };

  const afterGap = since.filter((e) => at(e.occurredAt) - at(pending.occurredAt) >= thresholds.verification.minGapHours * HOUR_MS);
  if (afterGap.length === 0) return { verified: false, refusal: 'WITHIN_GAP' };

  const otherSession = afterGap.filter((e) => !qualifyingSessions.has(e.sessionId));
  if (otherSession.length === 0) return { verified: false, refusal: 'SAME_SESSION' };

  const seen = new Set<string>();
  const onNewItems = otherSession.filter((e) => {
    if (qualifyingItems.has(e.itemVersionRef) || seen.has(e.itemVersionRef)) return false;
    seen.add(e.itemVersionRef);
    return true;
  });
  const needed = thresholds.verification.minVerifyingResponses;
  if (onNewItems.length < needed) return { verified: false, refusal: 'NOT_ENOUGH_NEW_ITEMS' };

  const verifying = onNewItems.slice(0, needed);
  return { verified: true, verifying: Object.freeze(verifying), verifiedAt: verifying.at(-1)!.occurredAt };
}

/** The rule set a transition is decided under: its identity, its hash and the thresholds themselves. */
export interface PinnedRules {
  readonly ruleSetId: string;
  readonly ruleSetHash: string;
  readonly thresholds: MasteryThresholds;
}

/** A promotion not yet verified, as stored: with the rules it was pinned to, which are the ones that will verify it. */
export interface OpenPromotion extends PendingQualification {
  readonly transitionId: string;
  readonly rules: PinnedRules;
}

export interface Advance {
  /** Transitions this advance created, oldest first; a promotion verified within the same advance is returned already verified. */
  readonly created: readonly MasteryTransition[];
  /** Promotions stored before this advance that it verified. */
  readonly verified: readonly { readonly transitionId: string; readonly verifiedAt: string; readonly verifyingEvidence: readonly string[] }[];
  /** Whether the concept is held at `strong` afterwards, and the promotion awaiting verification if there is one. */
  readonly held: boolean;
  /** The weakest state since it was last strong; `null` while held at `strong`. Stored with the concept's state, and passed back in on the next advance. */
  readonly floor: MasteryState | null;
  readonly open: OpenPromotion | null;
}

export interface AdvanceInput {
  readonly conceptIdentityId: string;
  /** Everything stored for the concept before the new responses. */
  readonly prior: readonly ConceptEvidence[];
  /** The new responses. They are taken in the order they were given. */
  readonly arriving: readonly ConceptEvidence[];
  /** Whether the concept was held at `strong` before, from the last transition stored for it. */
  readonly held: boolean;
  /** The weakest state since it was last strong, as stored; `null` if held at `strong` or never assessed. */
  readonly floor: MasteryState | null;
  /** The promotion awaiting verification, if the last transition stored is one. */
  readonly open: OpenPromotion | null;
  /** The rule set in force now, which decides every new response and pins every new transition. */
  readonly current: PinnedRules;
  readonly newTransitionId: () => string;
}

/**
 * Advances a concept's history by the responses that have arrived, one at a time, in the order they were given — so a delivery of seventy-five responses
 * and seventy-five deliveries of one produce the same transitions.
 */
export function advanceConcept(input: AdvanceInput): Advance {
  const evidence: ConceptEvidence[] = [...input.prior];
  const created: MasteryTransition[] = [];
  const verified: { transitionId: string; verifiedAt: string; verifyingEvidence: readonly string[] }[] = [];
  let held = input.held;
  let floor: MasteryState | null = input.floor;
  let open: OpenPromotion | null = input.open;
  const rules = input.current;

  const record = (partial: Omit<MasteryTransition, 'transitionId' | 'ruleSetId' | 'ruleSetHash'>): MasteryTransition => {
    const transition = Object.freeze({ ...partial, transitionId: input.newTransitionId(), ruleSetId: rules.ruleSetId, ruleSetHash: rules.ruleSetHash });
    created.push(transition);
    return transition;
  };

  for (const arriving of inGivenOrder(input.arriving)) {
    // what the learner had, read at the instant of this response: decay may have taken a strong state below the floor in the meantime
    const before = deriveConceptState(input.conceptIdentityId, evidence, rules.thresholds, arriving.occurredAt);
    if (held && before.rawState === 'strong' && before.state !== 'strong') {
      record({ conceptIdentityId: input.conceptIdentityId, from: 'strong', to: before.state, qualifyingEvidence: [], verifyingEvidence: [], occurredAt: arriving.occurredAt, verifiedAt: null, isRegression: true });
      held = false;
      open = null;
      floor = before.state;
    }

    evidence.push(arriving);
    const after = deriveConceptState(input.conceptIdentityId, evidence, rules.thresholds, arriving.occurredAt);

    if (!held && after.rawState === 'strong') {
      const window = assessPromotion(inGivenOrder(evidence), rules.thresholds).window.map((e) => e.evidenceId);
      const promotion = record({ conceptIdentityId: input.conceptIdentityId, from: floor ?? before.state, to: 'strong', qualifyingEvidence: window, verifyingEvidence: [], occurredAt: arriving.occurredAt, verifiedAt: null, isRegression: false });
      held = true;
      floor = null;
      open = { transitionId: promotion.transitionId, occurredAt: promotion.occurredAt, qualifyingEvidence: window, rules };
      continue;
    }
    if (held && after.rawState !== 'strong') {
      record({ conceptIdentityId: input.conceptIdentityId, from: 'strong', to: after.rawState, qualifyingEvidence: [], verifyingEvidence: [], occurredAt: arriving.occurredAt, verifiedAt: null, isRegression: true });
      held = false;
      open = null;
      floor = after.rawState;
      continue;
    }
    if (!held) floor = weaker(floor, after.rawState);

    if (held && open !== null) {
      const result = assessVerification(open, evidence, open.rules.thresholds);
      if (result.verified) {
        const ids = result.verifying.map((e) => e.evidenceId);
        const index = created.findIndex((t) => t.transitionId === open!.transitionId);
        if (index >= 0) created[index] = Object.freeze({ ...created[index]!, verifyingEvidence: ids, verifiedAt: result.verifiedAt });
        else verified.push({ transitionId: open.transitionId, verifiedAt: result.verifiedAt, verifyingEvidence: ids });
        open = null;
      }
    }
  }

  return Object.freeze({ created: Object.freeze(created), verified: Object.freeze(verified), held, floor, open });
}
