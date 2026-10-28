import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AssessmentForLearning } from '../../contexts/assessment/public/composition.js';
import type { ContentForLearning } from '../../contexts/content/public/composition.js';
import type { ScoringForLearning } from '../../contexts/scoring/public/composition.js';
import { ScoredAttemptEvidenceSource, scoredAttemptOf } from './learning-evidence.js';

/**
 * The adapter against stubbed seams: every way a seam can answer, and what the adapter does about each. The real seams, joined
 * against real Postgres, are in `learning-evidence.integration.spec.ts`.
 */
const ATTEMPT = { attemptId: randomUUID(), scoreRecordId: randomUUID(), scoredAt: '2026-10-27T10:00:00.000Z' };
const TAXONOMY = randomUUID();

type Slot = { slotRef: string; itemVersionId: string; outcome: string; marksAwarded: string; marksAvailable: string };
const slot = (n: number, outcome: string, itemVersionId = randomUUID()): Slot => ({ slotRef: `s${n}`, itemVersionId, outcome, marksAwarded: '4', marksAvailable: '4' });

function seams(options: {
  outcomes?: unknown;
  taxonomy?: (ids: readonly string[]) => unknown;
  calls?: (readonly string[])[];
  /** What content says one call takes (D86); the adapter pages at it and at nothing of its own. */
  bound?: number;
  /** Per slot ref; defaults to a response at a distinct minute for every slot, all before the score. */
  timings?: (slots: readonly string[]) => unknown;
}) {
  const scoring = {
    outcomesForAttempt: { handle: async () => options.outcomes },
  } as unknown as ScoringForLearning;
  const content = {
    batchBound: options.bound ?? 500,
    taxonomyForItemVersions: {
      handle: async (query: { itemVersionIds: readonly string[] }) => {
        options.calls?.push(query.itemVersionIds);
        return (options.taxonomy ?? ((ids) => ({ ok: true, value: ids.map((id) => entry(id)) })))(query.itemVersionIds);
      },
    },
  } as unknown as ContentForLearning;
  const slotRefs = () => ((options.outcomes as { value?: Slot[] } | undefined)?.value ?? []).map((slot) => slot.slotRef);
  const assessment = {
    responseTimings: {
      handle: async () =>
        (options.timings ?? defaultTimings)(slotRefs()),
    },
  } as unknown as AssessmentForLearning;
  return new ScoredAttemptEvidenceSource({ scoring, content, assessment });
}
const entry = (itemVersionId: string, difficultyEstimate = 'moderate') => ({ itemVersionId, conceptIdentityId: randomUUID(), taxonomyVersionId: TAXONOMY, difficultyEstimate });
const LEARNER = randomUUID();
const defaultTimings = (slots: readonly string[]) => ({
  ok: true,
  value: { learnerRef: LEARNER, slots: slots.map((slotRef, n) => ({ slotRef, itemVersionId: 'x', respondedAt: new Date(Date.UTC(2026, 9, 27, 9, n % 60)).toISOString(), timeOnItemMs: 0 })) },
});
const good = (slots: Slot[]) => ({ ok: true, value: slots });

describe('assembling evidence from the two seams', () => {
  it('turns a correct and an incorrect response into evidence in paper order, and counts the rest as not evidence', async () => {
    const slots = [slot(1, 'correct'), slot(2, 'unattempted'), slot(3, 'incorrect'), slot(4, 'dropped'), slot(5, 'bonus'), slot(6, 'indeterminate')];
    const result = await seams({ outcomes: good(slots) }).evidenceForScoredAttempt(ATTEMPT);
    expect(result.ok && result.value.evidence.map((e) => [e.slotRef, e.outcome])).toEqual([['s1', 'correct'], ['s3', 'incorrect']]);
    expect(result.ok && result.value.notEvidence).toBe(4);
    expect(result.ok && result.value.evidence.every((e) => e.scoredAt === ATTEMPT.scoredAt && e.attemptRef === ATTEMPT.attemptId)).toBe(true);
  });

  it('asks content once for the distinct versions, and not at all when no response was given', async () => {
    const shared = randomUUID();
    const calls: (readonly string[])[] = [];
    await seams({ outcomes: good([slot(1, 'correct', shared), slot(2, 'incorrect', shared)]), calls }).evidenceForScoredAttempt(ATTEMPT);
    expect(calls).toEqual([[shared]]);

    const none: (readonly string[])[] = [];
    const result = await seams({ outcomes: good([slot(1, 'unattempted')]), calls: none }).evidenceForScoredAttempt(ATTEMPT);
    expect(none).toEqual([]);
    expect(result.ok && result.value).toEqual({ learnerRef: LEARNER, evidence: [], notEvidence: 1, gaveUp: [] });
  });

  it('hands a question the learner gave up on on as a give-up, and not as evidence, and not a slot that was only never touched (M7-38)', async () => {
    const slots = [slot(1, 'correct'), slot(2, 'unattempted'), slot(3, 'unattempted'), slot(4, 'dropped')];
    const gaveUpAt = '2026-10-27T09:30:00.000Z';
    const result = await seams({
      outcomes: good(slots),
      timings: (refs) => ({
        ok: true,
        value: {
          learnerRef: LEARNER,
          slots: refs.map((slotRef, n) => ({ slotRef, itemVersionId: 'x', respondedAt: slotRef === 's1' ? '2026-10-27T09:00:00.000Z' : null, gaveUpAt: slotRef === 's2' ? gaveUpAt : slotRef === 's4' ? gaveUpAt : null, timeOnItemMs: n })),
        },
      }),
    }).evidenceForScoredAttempt(ATTEMPT);
    expect(result.ok && result.value.evidence.map((e) => e.slotRef)).toEqual(['s1']);
    // s2 was given up on and scoring says unattempted: a give-up. s3 was never touched. s4 is dropped, which is not a question the learner gave up on whatever the log says.
    expect(result.ok && result.value.gaveUp.map((g) => [g.slotRef, g.occurredAt])).toEqual([['s2', gaveUpAt]]);
    expect(result.ok && result.value.notEvidence).toBe(3);
  });

  describe('pages at the bound content states (D86), at every place it is asked', () => {
    const slots = Array.from({ length: 7 }, (_, n) => slot(n, 'correct'));

    it('for evidence: seven versions under a bound of three are calls of 3, 3 and 1', async () => {
      const calls: (readonly string[])[] = [];
      const result = await seams({ outcomes: good(slots), calls, bound: 3 }).evidenceForScoredAttempt(ATTEMPT);
      expect(calls.map((c) => c.length)).toEqual([3, 3, 1]);
      expect(result.ok && result.value.evidence).toHaveLength(7);
    });

    it('for the report: the same', async () => {
      const calls: (readonly string[])[] = [];
      const result = await seams({ outcomes: good(slots), calls, bound: 3 }).slotsForScoredAttempt(ATTEMPT);
      expect(calls.map((c) => c.length)).toEqual([3, 3, 1]);
      expect(result.ok && result.value.slots).toHaveLength(7);
    });

    it('for pace: the same', async () => {
      const calls: (readonly string[])[] = [];
      const result = await seams({ outcomes: good(slots), calls, bound: 3 }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
      expect(calls.map((c) => c.length)).toEqual([3, 3, 1]);
      expect(result.ok && result.value).toHaveLength(7);
    });

    it('fails the whole read, naming content\'s reason, when a later page is refused', async () => {
      let page = 0;
      const refused = { ok: false, error: { kind: 'Validation', code: 'VERSION_TAXONOMY_QUERY_INVALID' } };
      const result = await seams({ outcomes: good(slots), bound: 3, taxonomy: (ids) => (++page === 2 ? refused : { ok: true, value: ids.map((id) => entry(id)) }) }).evidenceForScoredAttempt(ATTEMPT);
      expect(result).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
      expect(JSON.stringify(result)).toContain('VERSION_TAXONOMY_QUERY_INVALID');
    });
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

  it('names whose evidence it is, from assessment, since nothing in the event does', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct')]) }).evidenceForScoredAttempt(ATTEMPT);
    expect(result.ok && result.value.learnerRef).toBe(LEARNER);
  });

  it('dates each piece of evidence by its response and keeps the score\'s instant apart: more than one distinct occurredAt in one attempt', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct'), slot(2, 'incorrect'), slot(3, 'correct')]) }).evidenceForScoredAttempt(ATTEMPT);
    expect(result.ok && new Set(result.value.evidence.map((e) => e.occurredAt)).size).toBe(3);
    expect(result.ok && result.value.evidence.every((e) => e.scoredAt === ATTEMPT.scoredAt && e.occurredAt < e.scoredAt)).toBe(true);
  });

  it('fails the attempt whole, naming the slots, when scoring counted a response the log has none standing for', async () => {
    const timings = () => ({ ok: true, value: { learnerRef: LEARNER, slots: [{ slotRef: 's1', itemVersionId: 'x', respondedAt: '2026-10-27T09:00:00.000Z', timeOnItemMs: 0 }, { slotRef: 's2', itemVersionId: 'x', respondedAt: null, timeOnItemMs: 0 }] } });
    const result = await seams({ outcomes: good([slot(1, 'correct'), slot(2, 'incorrect'), slot(3, 'correct')]), timings }).evidenceForScoredAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, error: { code: 'RESPONSE_INSTANT_UNRESOLVED', slotRefs: ['s2', 's3'] } });
  });

  it('fails the attempt when a response is dated after the score that counted it', async () => {
    const timings = () => ({ ok: true, value: { learnerRef: LEARNER, slots: [{ slotRef: 's1', itemVersionId: 'x', respondedAt: '2026-10-27T11:00:00.000Z', timeOnItemMs: 0 }] } });
    const result = await seams({ outcomes: good([slot(1, 'correct')]), timings }).evidenceForScoredAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, error: { code: 'RESPONSE_INSTANT_UNRESOLVED', slotRefs: ['s1'] } });
  });

  it('says unavailable when assessment cannot be read', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct')]), timings: () => ({ ok: false, error: { kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'x' } }) }).evidenceForScoredAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  });

  it('names an AttemptScored event\'s attempt, record and instant, and nothing of the score', () => {
    const ref = scoredAttemptOf({
      occurredAt: new Date('2026-10-27T10:00:00.000Z'),
      payload: { scoreRecordId: 'r', attemptId: 'a' },
    });
    expect(ref).toEqual({ attemptId: 'a', scoreRecordId: 'r', scoredAt: '2026-10-27T10:00:00.000Z' });
  });
});

describe('assembling the slots of a report from the two seams (M7-41)', () => {
  it('gives every slot, the ones that were not responses included, at its concept and its marks as text', async () => {
    const slots = [slot(1, 'correct'), slot(2, 'unattempted'), slot(3, 'incorrect'), slot(4, 'dropped')];
    const result = await seams({ outcomes: good(slots) }).slotsForScoredAttempt(ATTEMPT);
    expect(result.ok && result.value.learnerRef).toBe(LEARNER);
    expect(result.ok && result.value.slots.map((s) => [s.slotRef, s.outcome, s.marksAwarded, s.marksAvailable, s.taxonomyVersionId])).toEqual(slots.map((s) => [s.slotRef, s.outcome, '4', '4', TAXONOMY]));
  });

  it('says an attempt that was never scored is not scored, and that a seam which could not answer is unavailable', async () => {
    const notFound = { ok: false, error: { kind: 'NotFound', code: 'NOT_FOUND', message: 'none' } };
    expect(await seams({ outcomes: notFound }).slotsForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'ATTEMPT_NOT_SCORED' } });
    expect(await seams({ outcomes: { ok: false, error: { kind: 'Unavailable', code: 'X', message: 'x' } } }).slotsForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(await seams({ outcomes: good([slot(1, 'correct')]), timings: () => ({ ok: false, error: { code: 'X' } }) }).slotsForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(await seams({ outcomes: good([slot(1, 'correct')]), taxonomy: () => ({ ok: false, error: { code: 'X' } }) }).slotsForScoredAttempt(ATTEMPT)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
  });

  it('fails the attempt whole, naming the versions, when content cannot resolve one: a report never ranks from part of an exam', async () => {
    const missing = randomUUID();
    const result = await seams({ outcomes: good([slot(1, 'correct'), slot(2, 'incorrect', missing)]), taxonomy: (ids) => ({ ok: true, value: ids.filter((i) => i !== missing).map((i) => entry(i)) }) }).slotsForScoredAttempt(ATTEMPT);
    expect(result).toMatchObject({ ok: false, error: { code: 'ITEM_VERSION_UNRESOLVED', itemVersionIds: [missing] } });
  });
});

describe('the responses of an attempt with the time each took (M7-46)', () => {
  const timed = (rows: Record<string, { timeOnItemMs: number; discardedMs?: number; unclosedVisits?: number }>, learnerRef = LEARNER) => (slots: readonly string[]) => ({
    ok: true,
    value: { learnerRef, slots: slots.map((slotRef) => ({ slotRef, itemVersionId: 'x', respondedAt: null, gaveUpAt: null, truncatedIntervals: 0, discardedMs: 0, unclosedVisits: 0, ...rows[slotRef] })) },
  });

  it('carries each response\'s time, what was discarded and the unclosed visits through to the slot, and leaves out what was not a response', async () => {
    const slots = [slot(1, 'correct'), slot(2, 'unattempted'), slot(3, 'incorrect')];
    const result = await seams({ outcomes: good(slots), timings: timed({ s1: { timeOnItemMs: 7, discardedMs: 11, unclosedVisits: 3 }, s2: { timeOnItemMs: 99 }, s3: { timeOnItemMs: 5 } }) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok && result.value.map((s) => [s.slotRef, s.outcome, s.timeOnItemMs, s.discardedMs, s.unclosedVisits, s.difficultyEstimate])).toEqual([
      ['s1', 'correct', 7, 11, 3, 'moderate'],
      ['s3', 'incorrect', 5, 0, 0, 'moderate'],
    ]);
  });

  it('says not found, and reads no score, for an attempt that belongs to someone else', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct')]), timings: timed({}, randomUUID()) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error).toMatchObject({ kind: 'NotFound', code: 'ATTEMPT_NOT_FOUND' });
  });

  it('says not found for an attempt that is not submitted, as for one that is not there', async () => {
    const result = await seams({ outcomes: good([]), timings: () => ({ ok: false, error: { kind: 'PreconditionFailed', code: 'ATTEMPT_NOT_SUBMITTED' } }) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error.kind).toBe('NotFound');
  });

  it('fails whole, as unavailable, naming the slot, when content answers but has no tag for a response', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct')]), taxonomy: () => ({ ok: true, value: [] }), timings: timed({ s1: { timeOnItemMs: 1 } }) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error).toMatchObject({ kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE', message: 'slot s1 cannot be resolved to a concept and a time' });
  });

  it('fails as unavailable, naming assessment, when assessment errors with anything but not found or not submitted', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct')]), timings: () => ({ ok: false, error: { kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'x' } }) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error).toMatchObject({ kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE', message: 'assessment could not be read: STORE_UNAVAILABLE' });
  });

  it('says not found when the attempt is the learner\'s but scoring has no record of it', async () => {
    const outcomes = { ok: false, error: { kind: 'NotFound', code: 'NOT_FOUND', message: 'x' } };
    const result = await seams({ outcomes, timings: timed({}) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error).toMatchObject({ kind: 'NotFound', code: 'ATTEMPT_NOT_FOUND' });
  });

  it('fails as unavailable, naming scoring, when scoring errors with anything but not found', async () => {
    const outcomes = { ok: false, error: { kind: 'Unavailable', code: 'SCORING_DOWN', message: 'x' } };
    const result = await seams({ outcomes, timings: timed({}) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error).toMatchObject({ kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE', message: 'scoring could not be read: SCORING_DOWN' });
  });

  it('fails as unavailable, naming content, when the taxonomy seam does not answer', async () => {
    const result = await seams({ outcomes: good([slot(1, 'correct')]), taxonomy: () => ({ ok: false, error: { kind: 'Unavailable', code: 'TAXONOMY_DOWN', message: 'x' } }), timings: timed({ s1: { timeOnItemMs: 1 } }) }).paceSlotsForAttempt(LEARNER, ATTEMPT.attemptId);
    expect(result.ok === false && result.error).toMatchObject({ kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE', message: 'content could not be read: TAXONOMY_DOWN' });
  });
});
