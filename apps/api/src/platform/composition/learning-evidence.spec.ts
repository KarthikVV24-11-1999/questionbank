import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ContentForLearning } from '../../contexts/content/public/composition.js';
import type { ScoringForLearning } from '../../contexts/scoring/public/composition.js';
import { ScoredAttemptEvidenceSource, scoredAttemptOf } from './learning-evidence.js';

/**
 * The adapter against stubbed seams: every way a seam can answer, and what the adapter does about each. The real seams, joined
 * against real Postgres, are in `learning-evidence.integration.spec.ts`.
 */
const ATTEMPT = { attemptId: randomUUID(), scoreRecordId: randomUUID(), occurredAt: '2026-10-27T10:00:00.000Z' };
const TAXONOMY = randomUUID();

type Slot = { slotRef: string; itemVersionId: string; outcome: string; marksAwarded: string; marksAvailable: string };
const slot = (n: number, outcome: string, itemVersionId = randomUUID()): Slot => ({ slotRef: `s${n}`, itemVersionId, outcome, marksAwarded: '4', marksAvailable: '4' });

function seams(options: {
  outcomes?: unknown;
  taxonomy?: (ids: readonly string[]) => unknown;
  calls?: (readonly string[])[];
}) {
  const scoring = {
    outcomesForAttempt: { handle: async () => options.outcomes },
  } as unknown as ScoringForLearning;
  const content = {
    taxonomyForItemVersions: {
      handle: async (query: { itemVersionIds: readonly string[] }) => {
        options.calls?.push(query.itemVersionIds);
        return (options.taxonomy ?? ((ids) => ({ ok: true, value: ids.map((id) => entry(id)) })))(query.itemVersionIds);
      },
    },
  } as unknown as ContentForLearning;
  return new ScoredAttemptEvidenceSource({ scoring, content });
}
const entry = (itemVersionId: string, difficultyEstimate = 'moderate') => ({ itemVersionId, conceptIdentityId: randomUUID(), taxonomyVersionId: TAXONOMY, difficultyEstimate });
const good = (slots: Slot[]) => ({ ok: true, value: slots });

describe('assembling evidence from the two seams', () => {
  it('turns a correct and an incorrect response into evidence in paper order, and counts the rest as not evidence', async () => {
    const slots = [slot(1, 'correct'), slot(2, 'unattempted'), slot(3, 'incorrect'), slot(4, 'dropped'), slot(5, 'bonus'), slot(6, 'indeterminate')];
    const result = await seams({ outcomes: good(slots) }).evidenceForScoredAttempt(ATTEMPT);
    expect(result.ok && result.value.evidence.map((e) => [e.slotRef, e.outcome])).toEqual([['s1', 'correct'], ['s3', 'incorrect']]);
    expect(result.ok && result.value.notEvidence).toBe(4);
    expect(result.ok && result.value.evidence.every((e) => e.occurredAt === ATTEMPT.occurredAt && e.attemptRef === ATTEMPT.attemptId)).toBe(true);
  });

  it('asks content once for the distinct versions, and not at all when no response was given', async () => {
    const shared = randomUUID();
    const calls: (readonly string[])[] = [];
    await seams({ outcomes: good([slot(1, 'correct', shared), slot(2, 'incorrect', shared)]), calls }).evidenceForScoredAttempt(ATTEMPT);
    expect(calls).toEqual([[shared]]);

    const none: (readonly string[])[] = [];
    const result = await seams({ outcomes: good([slot(1, 'unattempted')]), calls: none }).evidenceForScoredAttempt(ATTEMPT);
    expect(none).toEqual([]);
    expect(result.ok && result.value).toEqual({ evidence: [], notEvidence: 1 });
  });

  it('batches within content\'s cap: 501 distinct versions are two calls of 500 and 1', async () => {
    const slots = Array.from({ length: 501 }, (_, n) => slot(n, 'correct'));
    const calls: (readonly string[])[] = [];
    const result = await seams({ outcomes: good(slots), calls }).evidenceForScoredAttempt(ATTEMPT);
    expect(calls.map((c) => c.length)).toEqual([500, 1]);
    expect(result.ok && result.value.evidence).toHaveLength(501);
  });

  it('fails the whole attempt, naming the versions, when content cannot resolve one — never partial evidence', async () => {
    const [known, unknown] = [randomUUID(), randomUUID()];
    const result = await seams({
      outcomes: good([slot(1, 'correct', known), slot(2, 'correct', unknown)]),
      taxonomy: () => ({ ok: true, value: [entry(known)] }),
    }).evidenceForScoredAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, error: { code: 'ITEM_VERSION_UNRESOLVED', itemVersionIds: [unknown] } });
  });

  it('says the attempt is not scored when scoring has no record, and unavailable when either seam fails otherwise', async () => {
    const notFound = { ok: false, error: { kind: 'NotFound', code: 'NOT_FOUND', message: 'x' } };
    expect(await seams({ outcomes: notFound }).evidenceForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'ATTEMPT_NOT_SCORED' } });

    const broken = { ok: false, error: { kind: 'Conflict', code: 'PERSISTENCE_REJECTED', message: 'x' } };
    expect(await seams({ outcomes: broken }).evidenceForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(await seams({ outcomes: good([slot(1, 'correct')]), taxonomy: () => broken }).evidenceForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  });

  it('refuses to invent evidence from an answer the domain rejects', async () => {
    const version = randomUUID();
    const result = await seams({ outcomes: good([slot(1, 'correct', version)]), taxonomy: () => ({ ok: true, value: [entry(version, '0.62')] }) }).evidenceForScoredAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  });

  it('names an AttemptScored event\'s attempt, record and instant, and nothing of the score', () => {
    const ref = scoredAttemptOf({
      occurredAt: new Date('2026-10-27T10:00:00.000Z'),
      payload: { scoreRecordId: 'r', attemptId: 'a' },
    });
    expect(ref).toEqual({ attemptId: 'a', scoreRecordId: 'r', occurredAt: '2026-10-27T10:00:00.000Z' });
  });
});
