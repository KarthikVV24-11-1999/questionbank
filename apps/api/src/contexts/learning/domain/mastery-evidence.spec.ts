import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { DIFFICULTY_ESTIMATES, EVIDENCE_OUTCOMES, createMasteryEvidence, type MasteryEvidenceProps } from './mastery-evidence.js';

const ID = '3f2b8a52-6f0c-4c1e-9a52-0d4b1c7e9a10';
const valid: MasteryEvidenceProps = {
  attemptRef: ID,
  slotRef: 'a',
  itemVersionRef: ID,
  conceptIdentityId: ID,
  taxonomyVersionId: ID,
  outcome: 'correct',
  difficultyEstimate: 'moderate',
  occurredAt: '2026-10-27T10:00:00.000Z',
  scoredAt: '2026-10-27T12:00:00.000Z',
};

describe('MasteryEvidence', () => {
  it('is built from valid parts, frozen, and holds exactly the fields named', () => {
    const evidence = expectValue(createMasteryEvidence(valid));
    expect(evidence).toEqual(valid);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.keys(evidence).sort()).toEqual(
      ['attemptRef', 'conceptIdentityId', 'difficultyEstimate', 'itemVersionRef', 'occurredAt', 'outcome', 'scoredAt', 'slotRef', 'taxonomyVersionId'],
    );
  });

  it('refuses each reference that is not an identifier, naming the field', () => {
    for (const field of ['attemptRef', 'itemVersionRef', 'conceptIdentityId', 'taxonomyVersionId'] as const) {
      for (const bad of ['', 'not-an-id', 7, undefined]) {
        const error = expectError(createMasteryEvidence({ ...valid, [field]: bad }));
        expect(error.code, field).toBe('EVIDENCE_REFERENCE_INVALID');
        expect(error.message).toContain(field);
      }
    }
  });

  it('refuses a slot reference that names nothing, and accepts the paper\'s own short names', () => {
    for (const bad of ['', '   ', 3, undefined]) {
      expect(expectError(createMasteryEvidence({ ...valid, slotRef: bad })).code).toBe('EVIDENCE_REFERENCE_INVALID');
    }
    expect(expectValue(createMasteryEvidence({ ...valid, slotRef: 'phy-12' })).slotRef).toBe('phy-12');
  });

  it('takes a correct and an incorrect response as evidence and nothing else a score can say', () => {
    expect([...EVIDENCE_OUTCOMES]).toEqual(['correct', 'incorrect']);
    for (const outcome of EVIDENCE_OUTCOMES) expect(expectValue(createMasteryEvidence({ ...valid, outcome })).outcome).toBe(outcome);
    for (const outcome of ['unattempted', 'dropped', 'bonus', 'indeterminate', '', undefined]) {
      expect(expectError(createMasteryEvidence({ ...valid, outcome })).code).toBe('EVIDENCE_OUTCOME_INVALID');
    }
  });

  it('takes each authored difficulty band and refuses a number, which would read as a measured value', () => {
    for (const difficultyEstimate of DIFFICULTY_ESTIMATES) {
      expect(expectValue(createMasteryEvidence({ ...valid, difficultyEstimate })).difficultyEstimate).toBe(difficultyEstimate);
    }
    for (const bad of [0.62, 'easy', '', undefined]) {
      expect(expectError(createMasteryEvidence({ ...valid, difficultyEstimate: bad })).code).toBe('EVIDENCE_DIFFICULTY_INVALID');
    }
  });

  it('holds the instant of the response apart from the instant of the score, and refuses a response that follows its score', () => {
    const evidence = expectValue(createMasteryEvidence(valid));
    expect(evidence.occurredAt).not.toBe(evidence.scoredAt);
    // equal is allowed: a response and its score may share a millisecond
    expect(expectValue(createMasteryEvidence({ ...valid, scoredAt: valid.occurredAt })).scoredAt).toBe(valid.occurredAt);
    expect(expectError(createMasteryEvidence({ ...valid, scoredAt: '2026-10-27T09:59:59.999Z' })).code).toBe('EVIDENCE_INSTANT_ORDER');
  });

  it('takes only the one canonical rendering of an instant, for both instants', () => {
    for (const field of ['occurredAt', 'scoredAt'] as const) {
      for (const bad of ['2026-10-27', '2026-10-27T10:00:00Z', 'yesterday', null, undefined, 1_761_559_200_000]) {
        expect(expectError(createMasteryEvidence({ ...valid, [field]: bad })).code, `${field} ${String(bad)}`).toBe('EVIDENCE_INSTANT_INVALID');
      }
    }
    for (const bad of ['2026-10-27', '2026-10-27T10:00:00Z', '2026-10-27T10:00:00.000+05:30', 'yesterday', 1_761_559_200_000, null, undefined]) {
      expect(expectError(createMasteryEvidence({ ...valid, occurredAt: bad })).code, String(bad)).toBe('EVIDENCE_INSTANT_INVALID');
    }
  });
});
