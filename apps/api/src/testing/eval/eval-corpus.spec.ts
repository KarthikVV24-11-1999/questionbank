import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../contexts/generation/domain/canonical-json.js';
import { PRECHECK_IDS } from '../../contexts/generation/domain/precheck-vocabulary.js';
import {
  DEFECTS,
  DEFECT_PLAN,
  KNOWN_BAD_COUNT,
  POSITIVE_COUNT,
  buildEvalCorpus,
  buildKnownBad,
  buildPositives,
  officialItemCount,
  type EvalCorpus,
} from './eval-corpus.js';

/**
 * The corpus is the artifact, so what it *is* is pinned: the number of items, the
 * defect each carries, that it is synthetic, and a digest of its bytes — so a change
 * to the builder is a reviewed diff to this file and not a quiet shift in what the
 * catch rate is a rate of.
 */
const PINNED_DIGEST = 'e853bfa0114874e716362b7f2bdb14e9e0e0edb121034fde90c0a0885c01c18d';

const digest = (corpus: EvalCorpus) => createHash('sha256').update(canonicalJson(corpus as never)).digest('hex');

describe('the corpus has the shape DEC-M5-4 asks for', () => {
  const corpus = buildEvalCorpus();

  it('holds 100 known-bad negative controls and 40 synthetic positives', () => {
    expect(KNOWN_BAD_COUNT).toBe(100);
    expect(POSITIVE_COUNT).toBe(40);
    expect(corpus.knownBad).toHaveLength(100);
    expect(corpus.positives).toHaveLength(40);
  });

  it('plants exactly the defects the plan says, in the counts it says, and the counts sum to 100', () => {
    expect(Object.values(DEFECT_PLAN).reduce((total, plan) => total + plan.count, 0)).toBe(100);
    const planted = Object.fromEntries(DEFECTS.map((defect) => [defect, corpus.knownBad.filter((item) => item.defect === defect).length]));
    expect(planted).toEqual(Object.fromEntries(DEFECTS.map((defect) => [defect, DEFECT_PLAN[defect].count])));
  });

  it('labels every known-bad item with a defect and no positive with one', () => {
    expect(corpus.knownBad.every((item) => item.defect !== undefined)).toBe(true);
    expect(corpus.positives.every((item) => item.defect === undefined)).toBe(true);
  });

  it('assigns each catchable defect a blocking check that exists, and the three it cannot catch none', () => {
    const owners = DEFECTS.map((defect) => DEFECT_PLAN[defect].caughtBy);
    for (const owner of owners) if (owner !== undefined) expect(PRECHECK_IDS).toContain(owner);
    expect(DEFECTS.filter((defect) => DEFECT_PLAN[defect].caughtBy === undefined)).toEqual(['difficulty_mislabel']);
    expect(DEFECT_PLAN.difficulty_mislabel.count).toBe(3);
  });

  it('gives every item an id and a stem of its own — the oracle recognises an item by what a check sends it', () => {
    const everything = [...corpus.knownBad, ...corpus.positives];
    expect(new Set(everything.map((item) => item.id)).size).toBe(140);
    expect(new Set(everything.map((item) => canonicalJson(item.body['stem'] as never))).size).toBe(140);
  });

  it('gives every choice item a true answer that is one of its options', () => {
    for (const item of [...corpus.knownBad, ...corpus.positives].filter((entry) => entry.itemType === 'SINGLE_CORRECT_MCQ')) {
      const ids = (item.body['responseSpec'] as { options: { optionId: string }[] }).options.map((option) => option.optionId);
      expect(ids, item.id).toContain(item.trueAnswer);
    }
  });
});

describe('the corpus is honest about what it is', () => {
  const corpus = buildEvalCorpus();

  it('is entirely synthetic: zero official items, because the 250 real ones are B1', () => {
    expect([...corpus.knownBad, ...corpus.positives].every((item) => item.provenance === 'synthetic')).toBe(true);
    expect(officialItemCount(corpus)).toBe(0);
  });

  it('counts an official item when there is one: the zero is a measurement, not a constant', () => {
    const planted: EvalCorpus = { ...corpus, positives: [{ ...corpus.positives[0]!, provenance: 'official' as never }, ...corpus.positives.slice(1)] };
    expect(officialItemCount(planted)).toBe(1);
  });
});

describe('the corpus is deterministic', () => {
  it('is the same bytes on every build', () => {
    expect(canonicalJson(buildKnownBad() as never)).toBe(canonicalJson(buildKnownBad() as never));
    expect(canonicalJson(buildPositives() as never)).toBe(canonicalJson(buildPositives() as never));
  });

  it('matches the pinned digest, so a change to what it measures is a change to this file', () => {
    expect(digest(buildEvalCorpus())).toBe(PINNED_DIGEST);
  });
});
