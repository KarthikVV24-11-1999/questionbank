import { describe, expect, it } from 'vitest';
import { rankCandidates, trigramSimilarity, trigrams, type RankableCandidate } from './trigram.js';

describe('trigrams', () => {
  it('returns a Set', () => {
    expect(trigrams('the quick brown fox')).toBeInstanceOf(Set);
  });

  it('yields at least one gram even for a one-character string, via padding', () => {
    expect(trigrams('x').size).toBeGreaterThan(0);
  });

  it('yields at least one gram for an empty string', () => {
    expect(trigrams('').size).toBeGreaterThan(0);
  });
});

describe('trigramSimilarity', () => {
  it('is symmetric', () => {
    const a = 'a ball falls five metres in two seconds';
    const b = 'a rock falls five metres in three seconds';
    expect(trigramSimilarity(a, b)).toBe(trigramSimilarity(b, a));
  });

  it('is exactly 1 on identical text', () => {
    const text = 'a ball falls five metres in two seconds';
    expect(trigramSimilarity(text, text)).toBe(1);
  });

  it('is exactly 1 on text differing only by normalization (case, punctuation)', () => {
    expect(trigramSimilarity('A ball falls.', 'a ball falls')).toBe(1);
  });

  it('is exactly 0 on completely disjoint trigram sets', () => {
    expect(trigramSimilarity('aaa', 'zzz')).toBe(0);
  });

  it('stays within [0, 1]', () => {
    const samples = ['a ball falls', 'a completely different sentence about chemistry', 'x', ''];
    for (const a of samples) {
      for (const b of samples) {
        const score = trigramSimilarity(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is monotonically non-decreasing as a candidate shares more of its prefix with the query', () => {
    const query = 'the rate of change of momentum is proportional to the applied force';
    const scores = [];
    for (let cut = 0; cut <= query.length; cut += 5) {
      scores.push(trigramSimilarity(query, query.slice(0, cut)));
    }
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1] as number);
    }
  });
});

describe('rankCandidates', () => {
  const candidates: RankableCandidate[] = [
    { id: 'c', similarity: 0.4 },
    { id: 'a', similarity: 0.9 },
    { id: 'b', similarity: 0.9 },
    { id: 'd', similarity: 0.1 },
  ];

  it('orders by similarity descending', () => {
    expect(rankCandidates(candidates).map((c) => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('breaks a similarity tie by id ascending', () => {
    const tied = rankCandidates(candidates);
    expect(tied[0]?.id).toBe('a');
    expect(tied[1]?.id).toBe('b');
  });

  it('breaks a similarity tie by id ascending, from the reverse starting order too', () => {
    const reversed = rankCandidates([...candidates].reverse());
    expect(reversed[0]?.id).toBe('a');
    expect(reversed[1]?.id).toBe('b');
  });

  it('caps at the default limit of 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `id-${i}`, similarity: i / 10 }));
    expect(rankCandidates(many)).toHaveLength(5);
  });

  it('caps at an explicit limit', () => {
    expect(rankCandidates(candidates, 2)).toHaveLength(2);
  });

  it('returns fewer than the limit when there are fewer candidates', () => {
    expect(rankCandidates(candidates.slice(0, 1), 5)).toHaveLength(1);
  });

  it('treats two fully-tied entries (same id and similarity) as equal, without crashing', () => {
    const tied = [
      { id: 'same', similarity: 0.5 },
      { id: 'same', similarity: 0.5 },
    ];
    expect(rankCandidates(tied)).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const original = [...candidates];
    rankCandidates(candidates);
    expect(candidates).toEqual(original);
  });
});

describe('no function in this module returns a boolean — ranking only, never a verdict', () => {
  it('trigrams returns a Set, not a boolean', () => {
    expect(typeof trigrams('x')).not.toBe('boolean');
    expect(trigrams('x')).toBeInstanceOf(Set);
  });

  it('trigramSimilarity returns a number, not a boolean', () => {
    expect(typeof trigramSimilarity('a', 'b')).toBe('number');
  });

  it('rankCandidates returns an array of numeric-scored records, not a boolean', () => {
    const result = rankCandidates([{ id: 'x', similarity: 0.5 }]);
    expect(Array.isArray(result)).toBe(true);
    for (const entry of result) {
      expect(typeof entry.similarity).toBe('number');
      expect(typeof entry.id).toBe('string');
    }
  });
});
