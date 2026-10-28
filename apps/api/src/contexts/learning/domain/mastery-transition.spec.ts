import { describe, expect, it } from 'vitest';
import { D002_THRESHOLDS, thresholdsWith } from '../../../testing/learning-thresholds.js';
import { hashThresholds, type MasteryThresholds } from './mastery-rule-set.js';
import type { ConceptEvidence } from './concept-state.js';
import { advanceConcept, assessVerification, isNorthStarEvent, reconcileTransitions, type Advance, type OpenPromotion, type PinnedRules } from './mastery-transition.js';

const CONCEPT = 'concept-1';
const HOUR = 3_600_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (hours: number, minutes = 0) => new Date(t0 + hours * HOUR + minutes * 60_000).toISOString();

const rules = (thresholds: MasteryThresholds = D002_THRESHOLDS, id = 'rs-1'): PinnedRules => ({ ruleSetId: id, ruleSetHash: hashThresholds(thresholds), thresholds });

let counter = 0;
const ev = (outcome: 'correct' | 'incorrect', item: string, session: string, when: string): ConceptEvidence => {
  counter += 1;
  return { evidenceId: `e${String(counter).padStart(4, '0')}`, itemVersionRef: item, outcome, difficultyEstimate: 'moderate', occurredAt: when, sessionId: session };
};

/** A learner who was weak, then qualified: four wrong answers on day 0, and eight right ones over the next two days in two sittings. */
function weakThenQualified() {
  const wrong = Array.from({ length: 4 }, (_, i) => ev('incorrect', `old${i}`, 'sit-0', at(i * 0.1)));
  const right = Array.from({ length: 8 }, (_, i) => ev('correct', `q${i}`, i < 4 ? 'sit-1' : 'sit-2', at(i < 4 ? 24 + i * 0.1 : 30 + i * 0.1)));
  return { wrong, right };
}

let ids = 0;
const advance = (over: Partial<Parameters<typeof advanceConcept>[0]> & Pick<Parameters<typeof advanceConcept>[0], 'prior' | 'arriving'>): Advance =>
  advanceConcept({ conceptIdentityId: CONCEPT, held: false, floor: null, open: null, current: rules(), newTransitionId: () => `t${(ids += 1)}`, ...over });

/** Advances through the qualification and returns it with the evidence behind it. */
function qualified() {
  const { wrong, right } = weakThenQualified();
  const first = advance({ prior: [], arriving: [...wrong, ...right] });
  return { wrong, right, first, all: [...wrong, ...right] };
}

describe('qualifying', () => {
  it('records the promotion at once, from the weakest state the concept was in, with the responses that qualified it and nothing verified', () => {
    const { first } = qualified();
    const promotion = first.created.find((t) => t.to === 'strong')!;
    expect(promotion).toMatchObject({ from: 'weak', to: 'strong', isRegression: false, verifiedAt: null, verifyingEvidence: [], ruleSetId: 'rs-1', ruleSetHash: rules().ruleSetHash });
    expect(promotion.qualifyingEvidence).toHaveLength(D002_THRESHOLDS.promotion.recentWindow);
    expect(first.held).toBe(true);
    expect(first.floor).toBeNull();
    expect(first.open).toMatchObject({ transitionId: promotion.transitionId });
    expect(isNorthStarEvent(promotion)).toBe(false);
  });

  it('reads `from` as the weakest state since last strong, so a concept that passed through developing is still a weakness turned into a strength', () => {
    const { first } = qualified();
    // on the way up it was developing the instant before; the promotion still says weak
    expect(first.created).toHaveLength(1);
    expect(first.created[0]!.from).toBe('weak');
    // a learner who was never weak says developing, and is not a north-star event once verified
    const never = advance({ prior: [], arriving: Array.from({ length: 8 }, (_, i) => ev('correct', `n${i}`, i < 4 ? 's1' : 's2', at(i < 4 ? 0 : 30))) });
    expect(never.created[0]!.from).toBe('developing');
  });

  it('falls back to the state just before when a concept was stored without a floor, as one written before the floor was kept would be', () => {
    const { wrong, right } = weakThenQualified();
    const prior = [...wrong, ...right.slice(0, 6)];
    const result = advance({ prior, arriving: right.slice(6), floor: null });
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ to: 'strong', from: 'developing' });
  });

  it('records nothing for responses that change nothing, and returns where it stands', () => {
    const result = advance({ prior: [], arriving: [ev('correct', 'a', 's1', at(0))] });
    expect(result).toMatchObject({ created: [], held: false, floor: 'developing', open: null, verified: [] });
  });
});

describe('verifying: three conditions, each refused on its own', () => {
  /** The qualification, and the responses up to the one that made it: the eighth right answer comes after it, and is a response since. */
  const open = (): { pending: OpenPromotion; all: ConceptEvidence[] } => {
    const { first, all } = qualified();
    const last = Math.max(...first.open!.qualifyingEvidence.map((id) => all.findIndex((e) => e.evidenceId === id)));
    return { pending: first.open!, all: all.slice(0, last + 1) };
  };

  it('is refused with nothing correct since the qualification', () => {
    const { pending, all } = open();
    expect(assessVerification(pending, all, D002_THRESHOLDS)).toEqual({ verified: false, refusal: 'NOT_ENOUGH_CORRECT' });
    const wrong = [...all, ev('incorrect', 'x', 'sit-3', at(100))];
    expect(assessVerification(pending, wrong, D002_THRESHOLDS)).toEqual({ verified: false, refusal: 'NOT_ENOUGH_CORRECT' });
  });

  it('is refused inside the gap, however many correct answers on new items in a new sitting: immediate correctness never counts', () => {
    const { pending, all } = open();
    const soon = [...all, ev('correct', 'v1', 'sit-3', at(31 + 8)), ev('correct', 'v2', 'sit-3', at(31 + 8, 5)), ev('correct', 'v3', 'sit-3', at(31 + 9))];
    expect(assessVerification(pending, soon, D002_THRESHOLDS)).toEqual({ verified: false, refusal: 'WITHIN_GAP' });
  });

  it('measures the gap from the qualification, and takes exactly the gap', () => {
    const { pending, all } = open();
    const gap = D002_THRESHOLDS.verification.minGapHours;
    const justUnder = [...all, ev('correct', 'v1', 'sit-3', new Date(Date.parse(pending.occurredAt) + gap * HOUR - 1).toISOString()), ev('correct', 'v2', 'sit-3', new Date(Date.parse(pending.occurredAt) + gap * HOUR - 1).toISOString())];
    expect(assessVerification(pending, justUnder, D002_THRESHOLDS)).toMatchObject({ verified: false, refusal: 'WITHIN_GAP' });
    const exactly = [...all, ev('correct', 'v1', 'sit-3', new Date(Date.parse(pending.occurredAt) + gap * HOUR).toISOString()), ev('correct', 'v2', 'sit-3', new Date(Date.parse(pending.occurredAt) + gap * HOUR).toISOString())];
    expect(assessVerification(pending, exactly, D002_THRESHOLDS)).toMatchObject({ verified: true });
  });

  it('is refused in the same sitting the qualifying evidence was in, even a long time later and on new items', () => {
    const { pending, all } = open();
    // far past the gap, but in a sitting the qualifying responses were already in: only possible when the sitting is long, which the rule set allows
    const sameSitting = [...all, ev('correct', 'v1', 'sit-2', at(30 + 72)), ev('correct', 'v2', 'sit-2', at(30 + 72, 5))];
    expect(assessVerification(pending, sameSitting, D002_THRESHOLDS)).toEqual({ verified: false, refusal: 'SAME_SESSION' });
  });

  it('is refused on items the qualification already used, and on one new item when two are needed', () => {
    const { pending, all } = open();
    const reused = [...all, ev('correct', 'q1', 'sit-3', at(100)), ev('correct', 'q2', 'sit-3', at(101))];
    expect(assessVerification(pending, reused, D002_THRESHOLDS)).toEqual({ verified: false, refusal: 'NOT_ENOUGH_NEW_ITEMS' });
    const sameItemTwice = [...all, ev('correct', 'new', 'sit-3', at(100)), ev('correct', 'new', 'sit-3', at(101))];
    expect(assessVerification(pending, sameItemTwice, D002_THRESHOLDS)).toEqual({ verified: false, refusal: 'NOT_ENOUGH_NEW_ITEMS' });
  });

  it('is granted when the gap, a different sitting and different items all hold, at the instant of the response that completed it', () => {
    const { pending, all } = open();
    const verifying = [ev('correct', 'v1', 'sit-3', at(100)), ev('correct', 'v2', 'sit-3', at(101))];
    const result = assessVerification(pending, [...all, ...verifying], D002_THRESHOLDS);
    expect(result).toMatchObject({ verified: true, verifiedAt: at(101) });
    expect(result.verified && result.verifying.map((e) => e.evidenceId)).toEqual(verifying.map((e) => e.evidenceId));
  });

  it('is decided by the thresholds it is given: the gap and the count are the rule set\'s', () => {
    const { pending, all } = open();
    const three = [...all, ev('correct', 'v1', 'sit-3', at(100)), ev('correct', 'v2', 'sit-3', at(101))];
    expect(assessVerification(pending, three, thresholdsWith({ verification: { minVerifyingResponses: 3 } }))).toMatchObject({ verified: false, refusal: 'NOT_ENOUGH_NEW_ITEMS' });
    expect(assessVerification(pending, three, thresholdsWith({ verification: { minGapHours: 200 } }))).toMatchObject({ verified: false, refusal: 'WITHIN_GAP' });
  });
});

describe('the north-star event', () => {
  it('is a weak → strong promotion with verifiedAt set, and only that', () => {
    const { first, all } = qualified();
    const later = [ev('correct', 'v1', 'sit-3', at(100)), ev('correct', 'v2', 'sit-3', at(101))];
    const done = advance({ prior: all, arriving: later, held: first.held, floor: first.floor, open: first.open });
    expect(done.created).toEqual([]);
    expect(done.verified).toEqual([{ transitionId: first.open!.transitionId, verifiedAt: at(101), verifyingEvidence: later.map((e) => e.evidenceId) }]);
    expect(done.open).toBeNull();
    expect(done.held).toBe(true);

    const promotion = first.created.find((t) => t.to === 'strong')!;
    const verifiedPromotion = { ...promotion, verifiedAt: at(101), verifyingEvidence: later.map((e) => e.evidenceId) };
    expect(isNorthStarEvent(verifiedPromotion)).toBe(true);
    // each part of the definition, taken away on its own
    expect(isNorthStarEvent({ ...verifiedPromotion, verifiedAt: null })).toBe(false);
    expect(isNorthStarEvent({ ...verifiedPromotion, from: 'developing' })).toBe(false);
    expect(isNorthStarEvent({ ...verifiedPromotion, to: 'developing' })).toBe(false);
    expect(isNorthStarEvent({ ...verifiedPromotion, isRegression: true })).toBe(false);
  });

  it('verifies a promotion made earlier in the same delivery, returning it already verified', () => {
    const { wrong, right } = weakThenQualified();
    const later = [ev('correct', 'v1', 'sit-3', at(100)), ev('correct', 'v2', 'sit-3', at(101))];
    const result = advance({ prior: [], arriving: [...wrong, ...right, ...later] });
    const promotion = result.created.find((t) => t.to === 'strong')!;
    expect(promotion).toMatchObject({ verifiedAt: at(101), verifyingEvidence: later.map((e) => e.evidenceId) });
    expect(isNorthStarEvent(promotion)).toBe(true);
    expect(result.verified).toEqual([]);
  });

  it('is the same however the responses arrive: all at once, or one delivery at a time', () => {
    const { wrong, right } = weakThenQualified();
    const later = [ev('correct', 'v1', 'sit-3', at(100)), ev('correct', 'v2', 'sit-3', at(101)), ev('incorrect', 'w', 'sit-3', at(102))];
    const everything = [...wrong, ...right, ...later];
    let n = 0;
    const whole = advanceConcept({ conceptIdentityId: CONCEPT, prior: [], arriving: everything, held: false, floor: null, open: null, current: rules(), newTransitionId: () => `x${(n += 1)}` });

    // one response per delivery, carrying forward only what would be stored: the evidence, whether it is held, the floor and the open promotion
    let m = 0;
    let state = { prior: [] as ConceptEvidence[], held: false, floor: null as Advance['floor'], open: null as OpenPromotion | null };
    const created: ReturnType<typeof advanceConcept>['created'][number][] = [];
    const patches = new Map<string, { verifiedAt: string; verifyingEvidence: readonly string[] }>();
    for (const e of everything) {
      const step = advanceConcept({ conceptIdentityId: CONCEPT, ...state, arriving: [e], current: rules(), newTransitionId: () => `y${(m += 1)}` });
      created.push(...step.created);
      for (const v of step.verified) patches.set(v.transitionId, v);
      state = { prior: [...state.prior, e], held: step.held, floor: step.floor, open: step.open };
    }
    const settled = created.map((t) => ({ ...t, ...(patches.get(t.transitionId) ?? {}) }));
    const shape = (list: readonly { from: string; to: string; occurredAt: string; verifiedAt: string | null; isRegression: boolean; verifyingEvidence: readonly string[] }[]) =>
      list.map((t) => [t.from, t.to, t.occurredAt, t.verifiedAt, t.isRegression, t.verifyingEvidence.join()]);
    expect(shape(settled)).toEqual(shape(whole.created));
    expect(whole.created.some((t) => isNorthStarEvent(t))).toBe(true);
  });
});

describe('regression', () => {
  it('is appended when accuracy falls, from strong, and the verified gain is left exactly as it was', () => {
    const { first, all } = qualified();
    const later = [ev('correct', 'v1', 'sit-3', at(100)), ev('correct', 'v2', 'sit-3', at(101))];
    const verified = advance({ prior: all, arriving: later, held: first.held, floor: first.floor, open: first.open });
    const gain = { ...first.created.find((t) => t.to === 'strong')!, verifiedAt: verified.verified[0]!.verifiedAt };

    const wrong = [ev('incorrect', 'z1', 'sit-4', at(200)), ev('incorrect', 'z2', 'sit-4', at(201)), ev('incorrect', 'z3', 'sit-4', at(202))];
    const fell = advance({ prior: [...all, ...later], arriving: wrong, held: verified.held, floor: verified.floor, open: verified.open });
    const regression = fell.created.find((t) => t.isRegression)!;
    expect(regression).toMatchObject({ from: 'strong', isRegression: true, verifiedAt: null, qualifyingEvidence: [], verifyingEvidence: [] });
    expect(regression.to).not.toBe('strong');
    expect(fell.held).toBe(false);
    // advancing never returns, nor can it touch, a transition stored before it: the gain is not among what it hands back
    expect(fell.created.filter((t) => t.transitionId === gain.transitionId)).toEqual([]);
    expect(isNorthStarEvent(gain)).toBe(true);
  });

  it('is appended when decay alone takes a held strong state below the floor, observed at the next response', () => {
    const { first, all } = qualified();
    const long = at(30 + 24 * 400);
    const back = ev('correct', 'after', 'sit-9', long);
    const result = advance({ prior: all, arriving: [back], held: first.held, floor: first.floor, open: first.open });
    expect(result.created[0]).toMatchObject({ from: 'strong', to: 'developing', isRegression: true, occurredAt: long });
    // the unverified qualification that decayed is closed and can no longer be verified; the response that
    // follows re-qualifies the concept, which is a promotion of its own with its own verification to earn
    expect(result.created[1]).toMatchObject({ to: 'strong', isRegression: false, verifiedAt: null, from: 'developing' });
    expect(result.open!.transitionId).toBe(result.created[1]!.transitionId);
    expect(result.open!.transitionId).not.toBe(first.open!.transitionId);
  });

  it('starts a new qualification, needing its own verification, when a regressed concept qualifies again', () => {
    const { first, all } = qualified();
    const wrong = Array.from({ length: 5 }, (_, i) => ev('incorrect', `z${i}`, 'sit-4', at(60 + i * 0.1)));
    const fell = advance({ prior: all, arriving: wrong, held: first.held, floor: first.floor, open: first.open });
    expect(fell.held).toBe(false);
    const again = Array.from({ length: 8 }, (_, i) => ev('correct', `r${i}`, i < 4 ? 'sit-5' : 'sit-6', at(i < 4 ? 80 + i * 0.1 : 120 + i * 0.1)));
    const regained = advance({ prior: [...all, ...wrong], arriving: again, held: fell.held, floor: fell.floor, open: fell.open });
    const promotions = regained.created.filter((t) => t.to === 'strong');
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({ isRegression: false, verifiedAt: null });
    expect(regained.open!.transitionId).toBe(promotions[0]!.transitionId);
  });
});

describe('pinned on the rules that decided it', () => {
  it('names the rule set of every transition it creates', () => {
    const wider = thresholdsWith({ promotion: { minDistinctSessions: 1 } });
    const { wrong, right } = weakThenQualified();
    const result = advance({ prior: [], arriving: [...wrong, ...right], current: rules(wider, 'rs-2') });
    expect(result.created.every((t) => t.ruleSetId === 'rs-2' && t.ruleSetHash === hashThresholds(wider))).toBe(true);
  });

  it('verifies a pending qualification under the thresholds it was pinned to, not under the rule set published since', () => {
    const { first, all } = qualified();
    const later = [ev('correct', 'v1', 'sit-3', at(31 + 10)), ev('correct', 'v2', 'sit-3', at(31 + 11))];
    // a looser gap is in force now; the qualification was pinned to forty-eight hours, which these answers do not meet
    const loose = rules(thresholdsWith({ verification: { minGapHours: 1 } }), 'rs-2');
    const kept = advance({ prior: all, arriving: later, held: first.held, floor: first.floor, open: first.open, current: loose });
    expect(kept.verified).toEqual([]);
    expect(kept.open).not.toBeNull();
    // and had it been pinned to the loose one, it would have verified
    const pinnedLoose = { ...first.open!, rules: loose };
    expect(advance({ prior: all, arriving: later, held: true, floor: null, open: pinnedLoose, current: loose }).verified).toHaveLength(1);
  });
});

describe('setting stored transitions beside the history corrected evidence gives (M7-40)', () => {
  it('keeps everything when the corrected evidence gives the history already stored, whatever the identifiers and the rules that decided it', () => {
    const { first, all } = qualified();
    const again = advance({ prior: [], arriving: all, current: rules(D002_THRESHOLDS, 'rs-later') });
    expect(again.created[0]!.ruleSetId).toBe('rs-later');
    expect(reconcileTransitions(first.created, again.created)).toMatchObject({ kept: first.created.length, revoked: [], created: [] });
  });

  it('revokes a promotion whose qualifying responses are no longer the ones the corrected evidence gives, and creates what replaces it', () => {
    const { first, all } = qualified();
    // half of the right answers were wrong: the concept no longer qualifies, so the promotion has no replacement
    const worse = all.map((e, i) => (e.outcome === 'correct' && i % 2 === 0 ? { ...e, outcome: 'incorrect' as const } : e));
    const replayed = advance({ prior: [], arriving: worse });
    const settled = reconcileTransitions(first.created, replayed.created);
    expect(replayed.created).toEqual([]);
    expect(settled.kept).toBe(0);
    expect(settled.revoked).toEqual(first.created.map((t) => t.transitionId));
    expect(settled.created).toEqual([]);
  });

  it('keeps the transitions before the first disagreement, with the rules that decided them, and replaces the rest', () => {
    const { first } = qualified();
    const [promotion] = first.created;
    const regression = { ...promotion!, transitionId: 'r1', from: 'strong' as const, to: 'developing' as const, qualifyingEvidence: [], isRegression: true, occurredAt: at(60) };
    const stored = [promotion!, regression];
    const replayed = [{ ...promotion!, transitionId: 'new-1', ruleSetId: 'other' }, { ...regression, transitionId: 'new-2', to: 'weak' as const }];
    const settled = reconcileTransitions(stored, replayed);
    expect(settled.kept).toBe(1);
    expect(settled.revoked).toEqual(['r1']);
    expect(settled.created.map((t) => t.transitionId)).toEqual(['new-2']);
  });
});
