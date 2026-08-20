import { describe, expect, it } from 'vitest';
import { AI_AGENT, AUTHOR, REVIEWER } from '../../../../testing/content-fixtures.js';
import { expectValue } from '../../../../testing/expect-result.js';
import * as qcSampling from './qc-sampling.js';
import { isSampled, secondReviewerExcludes, type ReviewSamplingPolicy } from './qc-sampling.js';
import { assertDecisionEvidenceComplete } from './decision-evidence.js';

const FIVE_PERCENT: ReviewSamplingPolicy = { sampleRate: 0.05 };

describe('isSampled — deterministic, never random', () => {
  it('gives the same answer for the same decision id, across 1,000 calls', () => {
    const decisionId = 'decision-repeatable-1';
    const first = isSampled(decisionId, FIVE_PERCENT);
    for (let i = 0; i < 1000; i += 1) {
      expect(isSampled(decisionId, FIVE_PERCENT)).toBe(first);
    }
  });

  it('is uniform within ±1pp of the configured rate over 10,000 ids', () => {
    let sampledCount = 0;
    const total = 10_000;
    for (let i = 0; i < total; i += 1) {
      if (isSampled(`decision-${i}`, FIVE_PERCENT)) sampledCount += 1;
    }
    const observedRate = sampledCount / total;
    expect(observedRate).toBeGreaterThanOrEqual(0.04);
    expect(observedRate).toBeLessThanOrEqual(0.06);
  });

  it('a rate change moves the boundary — a higher rate samples a superset', () => {
    const low: ReviewSamplingPolicy = { sampleRate: 0.05 };
    const high: ReviewSamplingPolicy = { sampleRate: 0.5 };
    let sampledUnderLowButNotHigh = 0;
    for (let i = 0; i < 1000; i += 1) {
      const id = `decision-${i}`;
      if (isSampled(id, low)) expect(isSampled(id, high)).toBe(true);
      if (isSampled(id, low) && !isSampled(id, high)) sampledUnderLowButNotHigh += 1;
    }
    expect(sampledUnderLowButNotHigh).toBe(0);
  });

  it('samples everything at rate 1 and nothing at rate 0', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(isSampled(`decision-${i}`, { sampleRate: 1 })).toBe(true);
      expect(isSampled(`decision-${i}`, { sampleRate: 0 })).toBe(false);
    }
  });
});

describe('a sampled approval is not blocked', () => {
  it('exports exactly isSampled and secondReviewerExcludes — nothing that could gate a transition', () => {
    const exported = Object.keys(qcSampling).sort();
    expect(exported).toEqual(['isSampled', 'secondReviewerExcludes']);
  });

  it("a sampled decision's approval evidence check succeeds identically to an unsampled one's", () => {
    // Finds one id the default policy samples and one it does not, then
    // proves assertDecisionEvidenceComplete — the actual approval-path gate
    // — treats them identically. Sampling has no opinion here at all.
    let sampledId: string | undefined;
    let unsampledId: string | undefined;
    for (let i = 0; i < 1000 && (sampledId === undefined || unsampledId === undefined); i += 1) {
      const id = `decision-${i}`;
      if (isSampled(id, FIVE_PERCENT)) sampledId ??= id;
      else unsampledId ??= id;
    }
    expect(sampledId).toBeDefined();
    expect(unsampledId).toBeDefined();

    const version = { authoredBy: AUTHOR };
    const input = { outcome: 'approve' as const, reviewer: REVIEWER, candidatesShownIds: [] };

    // The decision id plays no role in assertDecisionEvidenceComplete's
    // signature at all — this is the structural proof, not just an
    // observation: whichever id is used, the same input produces the same
    // result.
    const resultForSampled = assertDecisionEvidenceComplete(input, version);
    const resultForUnsampled = assertDecisionEvidenceComplete(input, version);
    expect(resultForSampled).toEqual(resultForUnsampled);
    expectValue(resultForSampled);
  });
});

describe('secondReviewerExcludes', () => {
  it('excludes the reviewer and the author', () => {
    const excluded = secondReviewerExcludes({ reviewer: REVIEWER, version: { authoredBy: AUTHOR } });
    expect(excluded.map((p) => p.id).sort()).toEqual([AUTHOR.id, REVIEWER.id].sort());
  });

  it('also excludes the editor when the version has one', () => {
    const excluded = secondReviewerExcludes({
      reviewer: REVIEWER,
      version: { authoredBy: AUTHOR, editedBy: AI_AGENT },
    });
    expect(excluded.map((p) => p.id).sort()).toEqual([AI_AGENT.id, AUTHOR.id, REVIEWER.id].sort());
  });
});
