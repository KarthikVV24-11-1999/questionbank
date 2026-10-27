import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from '../../contexts/content/application/ports.js';
import { contentForLearning } from '../../contexts/content/public/composition.js';
import { createAnswerKey } from '../../contexts/scoring/domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../../contexts/scoring/domain/aggregation-data.js';
import { createScoringInput, type CreateScoredSlot } from '../../contexts/scoring/domain/scoring-input.js';
import { scoringForAssessment, scoringForLearning } from '../../contexts/scoring/public/composition.js';
import type { ScoreAttempt } from '../../contexts/scoring/public/index.js';
import { createMediaStore } from '../persistence/filesystem-media-store.js';
import { JEE_MAIN_RULE_SET } from '../../testing/marking-fixtures.js';
import { itemContent, publishItem, uuid } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectValue } from '../../testing/expect-result.js';
import { ScoredAttemptEvidenceSource, scoredAttemptOf, type ScoredAttemptEvent } from './learning-evidence.js';

/**
 * A scored attempt in, the evidence rows out (M7-05): real Postgres, items published through content's own handlers, scored by
 * the real handler — whose event is written in the score's transaction (M7-01) — and read back through the two seams.
 */
let database: TestDatabase;
let source: ScoredAttemptEvidenceSource;
let score: ReturnType<typeof scoringForAssessment>['scoreAttempt'];

const HASH = '4fe24605633c';
const clock = { now: () => new Date('2026-10-27T10:00:00.000Z') };
const identifiers = { next: () => randomUUID() };
const audit = { record: async () => undefined };
const principals = { resolve: () => null };
const system = { principal: { kind: 'system' as const, id: uuid(), roleContext: ['system'] }, correlationId: 'c' };
const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  const base = { pool: database.pool, clock, identifiers, audit, principals };
  score = scoringForAssessment(base).scoreAttempt;
  source = new ScoredAttemptEvidenceSource({
    scoring: scoringForLearning(base),
    content: contentForLearning({
      ...base,
      mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
      idempotency: new InMemoryIdempotencyStore(),
      reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
    }),
  });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const TAXONOMY = randomUUID();
const tag = (conceptIdentityId: string, weight: number, isPrimary: boolean) => ({ conceptIdentityId, taxonomyVersionId: TAXONOMY, weight, isPrimary });

async function published(stem: string, difficulty: 'foundational' | 'advanced', tags: ReturnType<typeof tag>[]) {
  const item = await publishItem(database.pool, { ...itemContent(stem, difficulty), taxonomyTags: tags });
  return item.versions[0]!.versionId;
}

function slot(n: number, itemVersionId: string, chosen: string | undefined): CreateScoredSlot {
  return {
    slotId: `s${n}`,
    ordinal: n,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId,
    marksAvailable: 4,
    answerKey: key,
    ...(chosen === undefined ? {} : { response: { kind: 'OPTION_SELECTION' as const, optionIds: [chosen] } }),
  };
}

async function scored(slots: CreateScoredSlot[]): Promise<{ attemptId: string; event: ScoredAttemptEvent }> {
  const attemptId = randomUUID();
  const command: ScoreAttempt = {
    input: expectValue(
      createScoringInput({
        attemptId,
        pin: { examProfileVersionId: randomUUID(), markingRuleSetHash: HASH, ruleSchemaVersion: 1, taxonomyVersionId: TAXONOMY, itemVersionIds: slots.map((s) => s.itemVersionId) },
        sections: [{ ordinal: 1, slots }],
        overrides: [],
      }),
    ),
    ruleSet: JEE_MAIN_RULE_SET,
    ruleSetHash: HASH,
    aggregation: DEFAULT_AGGREGATION,
    idempotencyKey: attemptId,
  };
  const record = expectValue(await score.handle(command, system));
  // the event as the relay would hand it on: read back from the outbox, not rebuilt
  const row = (await database.pool.query('SELECT payload, occurred_at FROM platform.outbox_message WHERE aggregate_id = $1', [record.scoreRecordId])).rows[0];
  const event = { payload: row.payload, occurredAt: row.occurred_at };
  return { attemptId, event };
}

describe('a scored attempt becomes evidence for each item\'s primary concept', () => {
  it('counts one piece of evidence per response, for the primary concept only, whatever the secondary tags weigh', async () => {
    const [primaryA, secondary1, secondary2, primaryB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const three = await published('An item carrying three tags, one of them primary.', 'advanced', [tag(primaryA, 0.1, true), tag(secondary1, 0.9, false), tag(secondary2, 0.8, false)]);
    const plain = await published('An item carrying one tag.', 'foundational', [tag(primaryB, 1, true)]);
    const skipped = await published('An item the learner left alone.', 'foundational', [tag(randomUUID(), 1, true)]);

    const { attemptId, event } = await scored([slot(1, three, 'B'), slot(2, plain, 'A'), slot(3, skipped, undefined)]);
    const result = await source.evidenceForScoredAttempt(scoredAttemptOf(event));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notEvidence).toBe(1);
    // two responses, two rows: the three-tag item yields one row, for its primary, and nothing for the other two
    expect(result.value.evidence).toHaveLength(2);
    expect(result.value.evidence.map((e) => [e.slotRef, e.conceptIdentityId, e.outcome, e.difficultyEstimate])).toEqual([
      ['s1', primaryA, 'correct', 'advanced'],
      ['s2', primaryB, 'incorrect', 'foundational'],
    ]);
    const concepts = result.value.evidence.map((e) => e.conceptIdentityId);
    expect(concepts).not.toContain(secondary1);
    expect(concepts).not.toContain(secondary2);
    expect(result.value.evidence.every((e) => e.attemptRef === attemptId && e.taxonomyVersionId === TAXONOMY)).toBe(true);
    expect(result.value.evidence.map((e) => e.itemVersionRef)).toEqual([three, plain]);
    expect(result.value.evidence.every((e) => e.occurredAt === '2026-10-27T10:00:00.000Z')).toBe(true);
  });

  it('fails the attempt whole, naming the version, when one item version is not one content published', async () => {
    const known = await published('A published item.', 'foundational', [tag(randomUUID(), 1, true)]);
    const draftless = randomUUID();
    const { event } = await scored([slot(1, known, 'B'), slot(2, draftless, 'B')]);
    const result = await source.evidenceForScoredAttempt(scoredAttemptOf(event));
    expect(result).toMatchObject({ ok: false, error: { code: 'ITEM_VERSION_UNRESOLVED', itemVersionIds: [draftless] } });
  });

  it('says an attempt that was never scored is not scored', async () => {
    const result = await source.evidenceForScoredAttempt({ attemptId: randomUUID(), scoreRecordId: randomUUID(), occurredAt: '2026-10-27T10:00:00.000Z' });
    expect(result).toMatchObject({ ok: false, error: { code: 'ATTEMPT_NOT_SCORED' } });
  });
});
