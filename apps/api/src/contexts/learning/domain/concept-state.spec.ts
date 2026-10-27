import { describe, expect, it } from 'vitest';
import { D002_THRESHOLDS, thresholdsWith } from '../../../testing/learning-thresholds.js';
import { assessPromotion, decayedTo, deriveConceptState, inGivenOrder, type ConceptEvidence } from './concept-state.js';
import type { DifficultyEstimate, EvidenceOutcome } from './mastery-evidence.js';

const CONCEPT = '3f2b8a52-6f0c-4c1e-9a52-0d4b1c7e9a10';
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (days: number, minutes = 0) => new Date(t0 + days * DAY + minutes * 60_000).toISOString();

let n = 0;
function ev(outcome: EvidenceOutcome, over: Partial<ConceptEvidence> & { day?: number; item?: number; session?: number } = {}): ConceptEvidence {
  n += 1;
  return {
    evidenceId: `e${String(n).padStart(4, '0')}`,
    itemVersionRef: `item${over.item ?? n}`,
    outcome,
    difficultyEstimate: over.difficultyEstimate ?? 'moderate',
    occurredAt: over.occurredAt ?? at(over.day ?? 0, n),
    sessionId: over.sessionId ?? `s${over.session ?? 1}`,
  };
}

/** Eight correct responses on eight items in two sessions: exactly D-002's promotion, as the base each clause test takes one thing away from. */
function strongEvidence(): ConceptEvidence[] {
  return Array.from({ length: 8 }, (_, i) => ev('correct', { item: i + 1, session: i < 4 ? 1 : 2, day: i < 4 ? 0 : 1 }));
}

const derive = (evidence: ConceptEvidence[], asOf = at(1, 600), thresholds = D002_THRESHOLDS) => deriveConceptState(CONCEPT, evidence, thresholds, asOf);

describe('the states', () => {
  it('is unassessed with no evidence, with nothing to be confident of', () => {
    const state = derive([]);
    expect(state).toMatchObject({ state: 'unassessed', rawState: 'unassessed', confidence: 0, baseConfidence: 0, evidenceCount: 0, lastEvidenceAt: null, difficultyBandDemonstrated: null, evidenceIds: [] });
    expect(state.lowConfidence).toBe(true);
  });

  it('is weak when there is evidence and recent accuracy is below the rule set\'s line', () => {
    expect(derive([ev('incorrect'), ev('incorrect'), ev('incorrect'), ev('correct')]).state).toBe('weak');
  });

  it('is developing with evidence, accuracy at the line or above it, and no promotion', () => {
    expect(derive([ev('correct'), ev('incorrect')]).state).toBe('developing');
    expect(derive([ev('correct')]).state).toBe('developing');
  });

  it('is strong when all five clauses hold', () => {
    const state = derive(strongEvidence());
    expect(state).toMatchObject({ state: 'strong', rawState: 'strong', evidenceCount: 8, distinctItemCount: 8, distinctSessionCount: 2, difficultyBandDemonstrated: 'moderate' });
  });
});

describe('promotion needs every clause, each refused on its own', () => {
  it('refuses with seven responses', () => {
    expect(derive(strongEvidence().slice(1)).rawState).not.toBe('strong');
  });

  it('refuses with too few distinct items, however many responses', () => {
    const few = strongEvidence().map((e, i) => ({ ...e, itemVersionRef: `item${(i % 3) + 1}` }));
    expect(derive(few).distinctItemCount).toBe(3);
    expect(derive(few).rawState).not.toBe('strong');
    expect(derive(strongEvidence().map((e, i) => ({ ...e, itemVersionRef: `item${(i % 4) + 1}` }))).rawState).toBe('strong');
  });

  it('refuses with one session: evidence massed in one afternoon is not mastery', () => {
    const massed = strongEvidence().map((e) => ({ ...e, sessionId: 's1' }));
    expect(derive(massed).distinctSessionCount).toBe(1);
    expect(derive(massed).rawState).not.toBe('strong');
  });

  it('refuses with recent accuracy below the line, and takes it at the line', () => {
    const six = strongEvidence().map((e, i) => (i < 2 ? { ...e, outcome: 'incorrect' as const } : e)); // 6 of 8
    expect(derive(six).rawState).not.toBe('strong');
    const oneWrong = strongEvidence().map((e, i) => (i === 0 ? { ...e, outcome: 'incorrect' as const } : e)); // 7 of 8 = 0.875
    expect(derive(oneWrong).rawState).toBe('strong');
    const atTheLine = thresholdsWith({ promotion: { minRecentAccuracy: 0.75 } });
    expect(derive(six, at(1, 600), atTheLine).rawState).toBe('strong'); // 6 of 8 = 0.75 exactly
  });

  it('refuses when too few of the recent responses are at the demonstrated band, and takes it when three are', () => {
    // seven foundational and one advanced, all correct: the demonstrated band is advanced, and one response is at it
    const mixed = strongEvidence().map((e, i) => ({ ...e, difficultyEstimate: (i === 7 ? 'advanced' : 'foundational') as DifficultyEstimate }));
    expect(derive(mixed).difficultyBandDemonstrated).toBe('advanced');
    expect(derive(mixed).rawState).not.toBe('strong');
    const three = strongEvidence().map((e, i) => ({ ...e, difficultyEstimate: (i >= 5 ? 'advanced' : 'foundational') as DifficultyEstimate }));
    expect(derive(three).rawState).toBe('strong');
  });

  it('takes the band from the correct responses only: an incorrect response at a higher band demonstrates nothing', () => {
    const evidence = strongEvidence().map((e, i) => (i === 3 ? { ...e, outcome: 'incorrect' as const, difficultyEstimate: 'advanced' as const } : e));
    expect(derive(evidence).difficultyBandDemonstrated).toBe('moderate');
    expect(derive([ev('incorrect', { difficultyEstimate: 'advanced' })]).difficultyBandDemonstrated).toBeNull();
  });

  it('measures accuracy and the band over the recent window and the counts over everything', () => {
    const early = Array.from({ length: 12 }, (_, i) => ev('incorrect', { item: 100 + i, session: 1, day: -10 }));
    const state = derive([...early, ...strongEvidence()]);
    expect(state).toMatchObject({ rawState: 'strong', evidenceCount: 20, distinctItemCount: 20, distinctSessionCount: 2 });
    expect(assessPromotion(inGivenOrder([...early, ...strongEvidence()]), D002_THRESHOLDS).window).toHaveLength(8);
  });

  it('is decided by the rule set it is given: a stricter one refuses what D-002 grants', () => {
    expect(derive(strongEvidence()).rawState).toBe('strong');
    expect(derive(strongEvidence(), at(1, 600), thresholdsWith({ promotion: { minDistinctSessions: 3 } })).rawState).not.toBe('strong');
  });
});

describe('the state is derived, so it is traceable and does not depend on the order evidence was handed in', () => {
  it('names the responses it comes from, in the order they were given', () => {
    const evidence = strongEvidence();
    expect(derive([...evidence].reverse()).evidenceIds).toEqual(evidence.map((e) => e.evidenceId));
  });

  it('derives the same state from the same evidence however it is ordered', () => {
    const evidence = [...strongEvidence(), ev('incorrect', { day: 3 })];
    expect(derive([...evidence].reverse())).toEqual(derive(evidence));
  });

  it('breaks a tie between two responses at the same instant by identifier, both ways round', () => {
    const [a, b] = [ev('correct', { occurredAt: at(0) }), ev('incorrect', { occurredAt: at(0) })];
    expect(inGivenOrder([b, a]).map((e) => e.evidenceId)).toEqual([a.evidenceId, b.evidenceId]);
    expect(inGivenOrder([a, b]).map((e) => e.evidenceId)).toEqual([a.evidenceId, b.evidenceId]);
  });

  it('flags a state below the evidence threshold as low-confidence, and one at it as not', () => {
    expect(derive(strongEvidence().slice(1)).lowConfidence).toBe(true);
    expect(derive(strongEvidence()).lowConfidence).toBe(false);
  });

  it('returns a frozen state', () => {
    const state = derive(strongEvidence());
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.evidenceIds)).toBe(true);
  });
});

describe('decay is computed at read', () => {
  // built once: the same responses every time, or "the same evidence" is not
  const fixed = strongEvidence();
  const evidence = () => fixed;
  const lastAt = () => fixed.at(-1)!.occurredAt;

  it('leaves a fresh state strong, lowers confidence with time, and reads a strong state below the floor as developing', () => {
    const fresh = derive(evidence(), lastAt());
    expect(fresh.state).toBe('strong');
    const early = derive(evidence(), at(1 + 20, 600));
    const late = derive(evidence(), at(1 + 400, 600));
    expect(early.confidence).toBeLessThan(fresh.confidence);
    expect(late.confidence).toBeLessThan(early.confidence);
    expect(late).toMatchObject({ state: 'developing', rawState: 'strong' });
    // the evidence is the same: only the read moved
    expect(late.evidenceIds).toEqual(fresh.evidenceIds);
    expect(late.decayAppliedAt).toBe(at(1 + 400, 600));
  });

  it('halves confidence every half-life since the last evidence', () => {
    const fresh = derive(evidence(), lastAt());
    const halfLife = D002_THRESHOLDS.decay.halfLifeDays;
    const later = derive(evidence(), new Date(Date.parse(lastAt()) + halfLife * DAY).toISOString());
    expect(later.confidence).toBeCloseTo(fresh.confidence / 2, 10);
  });

  it('does not decay a state read before its last evidence, and never decays one that is not strong', () => {
    expect(derive(evidence(), at(-5)).confidence).toBeCloseTo(derive(evidence(), lastAt()).confidence, 10);
    const developing = derive([ev('correct'), ev('incorrect')], at(900));
    expect(developing.state).toBe('developing');
    expect(derive([ev('incorrect'), ev('incorrect')], at(900)).state).toBe('weak');
  });

  it('is the same read from the state alone as from the evidence: two paths to one answer, over many instants and rule sets', () => {
    const seen = new Set<string>();
    for (const halfLife of [5, 30, 60, 200]) {
      const thresholds = thresholdsWith({ decay: { halfLifeDays: halfLife } });
      const first = deriveConceptState(CONCEPT, evidence(), thresholds, lastAt());
      for (const days of [0, 1, 7, 30, 59, 61, 120, 365, 1000]) {
        const asOf = new Date(Date.parse(lastAt()) + days * DAY).toISOString();
        const viaState = decayedTo(first, thresholds, asOf);
        const viaEvidence = deriveConceptState(CONCEPT, evidence(), thresholds, asOf);
        expect(viaState, `half-life ${halfLife}, day ${days}`).toEqual(viaEvidence);
        seen.add(viaState.state);
      }
    }
    // both outcomes occur, so agreement is not agreement on one value
    expect([...seen].sort()).toEqual(['developing', 'strong']);
  });

  it('decays an unassessed state to nothing', () => {
    expect(decayedTo(derive([]), D002_THRESHOLDS, at(50))).toMatchObject({ state: 'unassessed', confidence: 0, decayAppliedAt: at(50) });
  });
});
