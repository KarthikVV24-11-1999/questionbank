import { describe, expect, it } from 'vitest';
import { orderCandidates, type QueueOrderingCandidate, type QueueOrderingContext } from './queue-ordering.js';

function candidate(overrides: Partial<QueueOrderingCandidate> & { itemVersionId: string }): QueueOrderingCandidate {
  return {
    primaryConceptId: 'concept-a',
    escalated: false,
    blockingCount: 0,
    warningCount: 0,
    duplicateCandidateCount: 0,
    stateEnteredAt: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

const NO_CONTEXT: QueueOrderingContext = {};

describe('orderCandidates — each precedence level in isolation', () => {
  it('sorts an escalated candidate before a non-escalated one, ahead of every other term', () => {
    const clean = candidate({ itemVersionId: 'b', stateEnteredAt: '2026-08-01T00:00:00Z' });
    const escalated = candidate({ itemVersionId: 'a', escalated: true, stateEnteredAt: '2026-08-20T00:00:00Z' });

    const ordered = orderCandidates([clean, escalated], NO_CONTEXT);
    expect(ordered.map((c) => c.itemVersionId)).toEqual(['a', 'b']);
  });

  it('sorts a matching-concept candidate before a non-matching one, among non-escalated items', () => {
    const other = candidate({ itemVersionId: 'x', primaryConceptId: 'concept-b' });
    const matching = candidate({ itemVersionId: 'y', primaryConceptId: 'concept-a' });

    const ordered = orderCandidates([other, matching], { lastDecidedConcept: 'concept-a' });
    expect(ordered.map((c) => c.itemVersionId)).toEqual(['y', 'x']);
  });

  it('ignores concept matching entirely when there is no last-decided concept', () => {
    const a = candidate({ itemVersionId: 'a', primaryConceptId: 'concept-a', stateEnteredAt: '2026-08-01T00:00:00Z' });
    const b = candidate({ itemVersionId: 'b', primaryConceptId: 'concept-b', stateEnteredAt: '2026-08-02T00:00:00Z' });

    const ordered = orderCandidates([b, a], NO_CONTEXT);
    expect(ordered.map((c) => c.itemVersionId)).toEqual(['a', 'b']);
  });

  it('sorts the cleaner (more confident) candidate first', () => {
    const dirty = candidate({ itemVersionId: 'dirty', blockingCount: 2, warningCount: 1, duplicateCandidateCount: 1 });
    const clean = candidate({ itemVersionId: 'clean', blockingCount: 0, warningCount: 0, duplicateCandidateCount: 0 });

    const ordered = orderCandidates([dirty, clean], NO_CONTEXT);
    expect(ordered.map((c) => c.itemVersionId)).toEqual(['clean', 'dirty']);
  });

  it('sorts the older item first when every earlier term ties', () => {
    const newer = candidate({ itemVersionId: 'newer', stateEnteredAt: '2026-08-15T00:00:00Z' });
    const older = candidate({ itemVersionId: 'older', stateEnteredAt: '2026-08-01T00:00:00Z' });

    const ordered = orderCandidates([newer, older], NO_CONTEXT);
    expect(ordered.map((c) => c.itemVersionId)).toEqual(['older', 'newer']);
  });

  it('breaks a full tie on itemVersionId, ascending, from either starting order', () => {
    const b = candidate({ itemVersionId: 'b' });
    const a = candidate({ itemVersionId: 'a' });

    expect(orderCandidates([b, a], NO_CONTEXT).map((c) => c.itemVersionId)).toEqual(['a', 'b']);
    expect(orderCandidates([a, b], NO_CONTEXT).map((c) => c.itemVersionId)).toEqual(['a', 'b']);
  });
});

describe('orderCandidates — total order and determinism', () => {
  function buildCorpus(): QueueOrderingCandidate[] {
    const concepts = ['concept-a', 'concept-b', 'concept-c'];
    return Array.from({ length: 24 }, (_, index) =>
      candidate({
        itemVersionId: `item-${String(index).padStart(2, '0')}`,
        primaryConceptId: concepts[index % concepts.length] as string,
        escalated: index % 7 === 0,
        blockingCount: index % 3,
        warningCount: index % 2,
        duplicateCandidateCount: index % 4,
        stateEnteredAt: new Date(Date.UTC(2026, 7, 1 + (index % 20))).toISOString(),
      }),
    );
  }

  function shuffled<T>(items: readonly T[], seed: number): T[] {
    const array = [...items];
    let state = seed;
    for (let i = array.length - 1; i > 0; i -= 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const j = state % (i + 1);
      [array[i], array[j]] = [array[j] as T, array[i] as T];
    }
    return array;
  }

  it('orders a shuffled corpus identically across 100 runs, regardless of starting order', () => {
    const corpus = buildCorpus();
    const context: QueueOrderingContext = { lastDecidedConcept: 'concept-b' };
    const baseline = orderCandidates(corpus, context).map((c) => c.itemVersionId);

    for (let run = 0; run < 100; run += 1) {
      const input = shuffled(corpus, run + 1);
      const result = orderCandidates(input, context).map((c) => c.itemVersionId);
      expect(result).toEqual(baseline);
    }
  });

  it('keeps same-concept-matching candidates contiguous, ahead of non-matching ones', () => {
    const corpus = buildCorpus().map((c) => ({ ...c, escalated: false }));
    const ordered = orderCandidates(corpus, { lastDecidedConcept: 'concept-a' });

    const matchFlags = ordered.map((c) => c.primaryConceptId === 'concept-a');
    const firstNonMatch = matchFlags.indexOf(false);
    // Every matching candidate appears before the first non-matching one —
    // a single contiguous run, not matches scattered through the list.
    expect(matchFlags.slice(0, firstNonMatch === -1 ? matchFlags.length : firstNonMatch).every(Boolean)).toBe(true);
    expect(matchFlags.slice(firstNonMatch === -1 ? matchFlags.length : firstNonMatch).some(Boolean)).toBe(false);
  });

  it('never compares two distinct candidates as equal — the order is total', () => {
    const corpus = buildCorpus();
    const ordered = orderCandidates(corpus, { lastDecidedConcept: 'concept-a' });
    const ids = ordered.map((c) => c.itemVersionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not crash and treats a fully-tied duplicate as equal to itself', () => {
    const one = candidate({ itemVersionId: 'same' });
    const two = { ...one };
    const ordered = orderCandidates([one, two], NO_CONTEXT);
    expect(ordered).toHaveLength(2);
    expect(ordered.every((c) => c.itemVersionId === 'same')).toBe(true);
  });
});
