import { describe, expect, it } from 'vitest';
import { D002_THRESHOLDS } from '../../../testing/learning-thresholds.js';
import { conceptMapOf, readConceptMap, stateOf } from './concept-map.js';
import type { ConceptEvidence } from './concept-state.js';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (days: number, minutes = 0) => new Date(t0 + days * DAY + minutes * 60_000).toISOString();
const LEARNER = '00000000-0000-4000-8000-0000000000aa';
const TAXONOMY = '00000000-0000-4000-8000-0000000000bb';

let n = 0;
const ev = (item: number, session: number, day: number, outcome: 'correct' | 'incorrect' = 'correct'): ConceptEvidence => {
  n += 1;
  return { evidenceId: `e${String(n).padStart(4, '0')}`, itemVersionRef: `item${item}`, outcome, difficultyEstimate: 'moderate', occurredAt: at(day, n), sessionId: `s${session}` };
};
const strong = (): ConceptEvidence[] => Array.from({ length: 8 }, (_, i) => ev(i + 1, i < 4 ? 1 : 2, i < 4 ? 0 : 1));

describe('the concept map', () => {
  const map = () => conceptMapOf(LEARNER, TAXONOMY, new Map([['c-b', strong()], ['c-a', [ev(1, 1, 0)]], ['c-none', []]]), D002_THRESHOLDS, at(2));

  it('holds a state for each concept with evidence, ordered by concept, and none for a concept with none', () => {
    const built = map();
    expect(built.conceptStates.map((s) => s.conceptIdentityId)).toEqual(['c-a', 'c-b']);
    expect(built).toMatchObject({ learnerRef: LEARNER, taxonomyVersionId: TAXONOMY, lastRecomputedAt: at(2) });
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.conceptStates)).toBe(true);
  });

  it('answers a concept it has no state for with null, and does not invent a row', () => {
    expect(stateOf(map(), 'c-b')).toMatchObject({ state: 'strong' });
    expect(stateOf(map(), 'c-none')).toBeNull();
    expect(stateOf(map(), 'c-unknown')).toBeNull();
  });

  it('is read at another instant by decaying every state, without recomputing the evidence behind it', () => {
    const built = map();
    const later = readConceptMap(built, D002_THRESHOLDS, at(2 + 500));
    expect(later.lastRecomputedAt).toBe(at(2));
    expect(stateOf(later, 'c-b')).toMatchObject({ state: 'developing', rawState: 'strong', decayAppliedAt: at(2 + 500) });
    expect(stateOf(later, 'c-b')!.evidenceIds).toEqual(stateOf(built, 'c-b')!.evidenceIds);
    // the map it was read from is as it was
    expect(stateOf(built, 'c-b')!.state).toBe('strong');
  });
});
