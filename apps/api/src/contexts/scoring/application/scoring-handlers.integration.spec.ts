import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { createAnswerKey } from '../domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../domain/aggregation-data.js';
import { createScoringInput, type ResponseSnapshot, type CreateScoredSlot } from '../domain/scoring-input.js';
import { parseRational } from '../domain/numeric/decimal.js';
import { PostgresScoreRecordRepository } from '../infrastructure/score-record.repository.js';
import { PostgresRescoringOperationRepository } from '../infrastructure/rescoring-operation.repository.js';
import { InMemoryAuditRecorder, type Clock, type IdentifierFactory } from './ports.js';
import { HandlerRegistry, MissingAuthorizationPolicyError, type Handler } from './handler-registry.js';
import { ScoreAttemptHandler } from './handlers/scoring-handlers.js';
import {
  ApproveRescoringHandler,
  DraftRescoringHandler,
  ExecuteRescoringHandler,
  RunRescoringDryRunHandler,
} from './handlers/rescoring-handlers.js';
import {
  GetAttemptOutcomesHandler,
  GetScoreRecordHandler,
  ListScoreRecordGenerationsHandler,
  GetRescoringDryRunHandler,
} from './queries/scoring-queries.js';
import type { ScoreAttempt } from './commands/scoring-commands.js';
import { JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

let database: TestDatabase;

const HASH = '4fe24605633c';
const PROFILE_ID = randomUUID();
const TAXONOMY_ID = randomUUID();
const LEARNER = randomUUID();
const ADMIN = randomUUID();

const keyB = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const keyA = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'A' }));

const principal = (id: string, roles: readonly string[]): PrincipalRef => ({
  kind: 'human',
  id,
  roleContext: [...roles],
});

const learnerContext = { principal: principal(LEARNER, ['learner']), correlationId: 'c-1' };
const opsContext = { principal: principal(ADMIN, ['ops']), correlationId: 'c-1' };
const adminContext = { principal: principal(ADMIN, ['admin']), correlationId: 'c-1', stepUpSatisfied: true };
const adminNoStepUp = { principal: principal(ADMIN, ['admin']), correlationId: 'c-1' };

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
  }
}

class SequentialIdentifiers implements IdentifierFactory {
  next(): string {
    return randomUUID();
  }
}

/** Every message an operation produced, whatever its aggregate: the operation's own and one per attempt it superseded. */
async function outboxFor(operationId: string): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
  const found = await database.pool.query(
    `SELECT event_type, payload FROM platform.outbox_message WHERE payload->>'rescoringOperationId' = $1 ORDER BY occurred_at, outbox_message_id`,
    [operationId],
  );
  return found.rows;
}

/** What the outbox holds for one aggregate: the only place an event of this context is written. */
async function eventsFor(aggregateId: string): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
  const found = await database.pool.query(
    'SELECT event_type, payload FROM platform.outbox_message WHERE aggregate_id = $1 ORDER BY occurred_at',
    [aggregateId],
  );
  return found.rows;
}

/**
 * The pool the handlers see, with one fault planted: any statement matching `refuse` is rejected on the connection a
 * handler's own write is using. A record is written on that connection first, so a refusal here falls *between* the
 * record's write and the event's — the exact window a second transaction used to leave open (DEC-M7-6).
 */
function poolRefusing(refuse: RegExp): Pool {
  return new Proxy(database.pool, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          const client = await target.connect();
          const original = client.query;
          const release = client.release.bind(client);
          client.query = ((text: unknown, ...rest: unknown[]) =>
            typeof text === 'string' && refuse.test(text)
              ? Promise.reject(new Error('injected: the event write is refused'))
              : (original as (...a: unknown[]) => unknown).call(client, text, ...rest)) as never;
          // the connection goes back to the pool, so the fault must not travel with it
          client.release = ((...args: unknown[]) => {
            client.query = original;
            return (release as (...a: unknown[]) => void)(...args);
          }) as never;
          return client;
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Pool;
}

function slot(answerKey = keyB, chosen = 'B'): CreateScoredSlot {
  return {
    slotId: 'a',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: randomUUID(),
    marksAvailable: 4,
    answerKey,
    response: { kind: 'OPTION_SELECTION', optionIds: [chosen] } satisfies ResponseSnapshot,
  };
}

function command(attemptId: string, answerKey = keyB, chosen = 'B'): ScoreAttempt {
  return {
    input: expectValue(
      createScoringInput({
        attemptId,
        pin: {
          examProfileVersionId: PROFILE_ID,
          markingRuleSetHash: HASH,
          ruleSchemaVersion: 1,
          taxonomyVersionId: TAXONOMY_ID,
          itemVersionIds: [randomUUID()],
        },
        sections: [{ ordinal: 1, slots: [slot(answerKey, chosen)] }],
        overrides: [],
      }),
    ),
    ruleSet: JEE_MAIN_RULE_SET,
    ruleSetHash: HASH,
    aggregation: DEFAULT_AGGREGATION,
    idempotencyKey: attemptId,
  };
}

interface Harness {
  readonly score: ScoreAttemptHandler;
  readonly draft: DraftRescoringHandler;
  readonly dryRun: RunRescoringDryRunHandler;
  readonly approve: ApproveRescoringHandler;
  readonly execute: ExecuteRescoringHandler;
  readonly getRecord: GetScoreRecordHandler;
  readonly listGenerations: ListScoreRecordGenerationsHandler;
  readonly getDryRun: GetRescoringDryRunHandler;
  readonly audit: InMemoryAuditRecorder;
}

function harness(pool: Pool = database.pool): Harness {
  const records = new PostgresScoreRecordRepository(pool);
  const operations = new PostgresRescoringOperationRepository(pool);
  const audit = new InMemoryAuditRecorder();
  const deps = {
    records,
    operations,
    clock: new FixedClock(new Date('2026-08-07T00:00:00.000Z')),
    identifiers: new SequentialIdentifiers(),
    audit,
  };
  return {
    score: new ScoreAttemptHandler(deps),
    draft: new DraftRescoringHandler(deps),
    dryRun: new RunRescoringDryRunHandler(deps),
    approve: new ApproveRescoringHandler(deps),
    execute: new ExecuteRescoringHandler(deps),
    getRecord: new GetScoreRecordHandler(records),
    listGenerations: new ListScoreRecordGenerationsHandler(records),
    getDryRun: new GetRescoringDryRunHandler(operations),
    audit,
  };
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('ScoreAttempt', () => {
  it('scores and persists an attempt', async () => {
    const attemptId = randomUUID();
    const record = expectValue(await harness().score.handle(command(attemptId), opsContext));
    expect(record.attemptId).toBe(attemptId);
    expect(record.generation).toBe(1);
  });

  it('is idempotent: a repeat returns the existing record, never a second generation', async () => {
    const attemptId = randomUUID();
    const bench = harness();
    const first = expectValue(await bench.score.handle(command(attemptId), opsContext));
    const second = expectValue(await bench.score.handle(command(attemptId), opsContext));

    expect(second.scoreRecordId).toBe(first.scoreRecordId);
    const all = expectValue(
      await bench.listGenerations.handle({ attemptId, ownerUserId: LEARNER }, opsContext),
    );
    expect(all).toHaveLength(1);
  });

  it('takes computedAt from the injected clock, not from the domain', async () => {
    const record = expectValue(await harness().score.handle(command(randomUUID()), opsContext));
    expect(record.computedAt).toBe('2026-08-07T00:00:00.000Z');
  });

  it('writes an audit record', async () => {
    const bench = harness();
    const record = expectValue(await bench.score.handle(command(randomUUID()), opsContext));
    expect(bench.audit.entriesFor(record.scoreRecordId)).toHaveLength(1);
  });

  it('publishes AttemptScored with the total as decimal text', async () => {
    const bench = harness();
    const record = expectValue(await bench.score.handle(command(randomUUID()), opsContext));
    const [event] = await eventsFor(record.scoreRecordId);
    expect(event!.event_type).toBe('AttemptScored');
    expect(event!.payload.totalRaw).toBe('4');
  });

  it('refuses a principal without the role', async () => {
    const denied = expectError(await harness().score.handle(command(randomUUID()), learnerContext));
    expect(denied.kind).toBe('Authorization');
    expect(denied.code).toBe('NOT_PERMITTED');
  });

  it('surfaces a domain refusal as an application error', async () => {
    const bad = { ...command(randomUUID()), ruleSetHash: 'a-different-hash' };
    expect(expectError(await harness().score.handle(bad, opsContext)).code).toBe('RULE_SET_NOT_PINNED');
  });
});

describe('a score and its event are one transaction (M7-01, DEC-M7-6)', () => {
  const scoreRows = async (attemptId: string) =>
    (await database.pool.query('SELECT 1 FROM scoring.score_record WHERE attempt_id = $1', [attemptId])).rowCount;
  const OUTBOX_WRITE = /INSERT INTO platform\.outbox_message/u;

  it('commits neither when the event write fails after the record was written: never a score alone', async () => {
    const attemptId = randomUUID();
    const refused = expectError(await harness(poolRefusing(OUTBOX_WRITE)).score.handle(command(attemptId), opsContext));
    expect(refused.code).toBe('PERSISTENCE_REJECTED');

    expect(await scoreRows(attemptId)).toBe(0);
    const sections = await database.pool.query(
      `SELECT 1 FROM scoring.item_outcome o JOIN scoring.score_record r USING (score_record_id) WHERE r.attempt_id = $1`,
      [attemptId],
    );
    expect(sections.rowCount).toBe(0);
    const stray = await database.pool.query(
      `SELECT 1 FROM platform.outbox_message WHERE event_type = 'AttemptScored' AND payload->>'attemptId' = $1`,
      [attemptId],
    );
    expect(stray.rowCount).toBe(0);

    // the fault did not outlive its connection, and nothing was left in the way: the same attempt now scores once, with one event
    const record = expectValue(await harness().score.handle(command(attemptId), opsContext));
    expect(await eventsFor(record.scoreRecordId)).toHaveLength(1);
  });

  it('gives a successful score exactly one event, naming the record it was written with', async () => {
    const attemptId = randomUUID();
    const record = expectValue(await harness().score.handle(command(attemptId), opsContext));
    const events = await eventsFor(record.scoreRecordId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ scoreRecordId: record.scoreRecordId, attemptId, generation: 1 });
  });

  it('writes no second event for a retried submission', async () => {
    const attemptId = randomUUID();
    const bench = harness();
    const first = expectValue(await bench.score.handle(command(attemptId), opsContext));
    expectValue(await bench.score.handle(command(attemptId), opsContext));
    expect(await eventsFor(first.scoreRecordId)).toHaveLength(1);
  });

  it('leaves a re-score executing, with no AttemptsRescored, when the completion cannot write its event', async () => {
    const attemptId = randomUUID();
    const steady = harness();
    expectValue(await steady.score.handle(command(attemptId), opsContext));
    const operation = expectValue(
      await steady.draft.handle(
        { trigger: 'RULE_CORRECTION', scope: 'RULE_CHANGE', scopeRef: 'rs-atomic', reason: 'rule corrected' },
        opsContext,
      ),
    );
    const corrected = [command(attemptId, keyA, 'B')];
    expectValue(await steady.dryRun.handle({ operationId: operation.operationId, attempts: corrected }, opsContext));
    expectValue(await steady.approve.handle({ operationId: operation.operationId }, adminContext));

    expectError(await harness(poolRefusing(OUTBOX_WRITE)).execute.handle({ operationId: operation.operationId, attempts: corrected }, adminContext));

    const state = await database.pool.query(
      'SELECT state FROM scoring.rescoring_operation WHERE rescoring_operation_id = $1',
      [operation.operationId],
    );
    expect(state.rows[0].state).toBe('executing');
    expect(await eventsFor(operation.operationId)).toEqual([]);
    // the supersession is in the transaction that failed: the first score still stands, and no second generation exists (D72)
    const generations = await database.pool.query('SELECT generation, is_current FROM scoring.score_record WHERE attempt_id = $1 ORDER BY generation', [attemptId]);
    expect(generations.rows).toEqual([{ generation: 1, is_current: true }]);
  });
});

describe('what scoring offers learning (M7-02)', () => {
  const systemContext = { principal: { kind: 'system' as const, id: ADMIN, roleContext: ['system'] }, correlationId: 'c-1' };
  const outcomes = () => new GetAttemptOutcomesHandler(new PostgresScoreRecordRepository(database.pool));

  it('offers each slot as identifiers, an outcome and marks as decimal text, and nothing else', async () => {
    const attemptId = randomUUID();
    expectValue(await harness().score.handle(command(attemptId), opsContext));
    const views = expectValue(await outcomes().handle({ attemptId }, systemContext));
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({
      slotRef: 'a',
      itemVersionId: expect.any(String),
      outcome: 'correct',
      marksAwarded: '4',
      marksAvailable: '4',
    });
    // the set, not the loop: a response, a key or a rule appearing here is a failure
    expect(Object.keys(views[0]!).sort()).toEqual(['itemVersionId', 'marksAvailable', 'marksAwarded', 'outcome', 'slotRef']);
  });

  it('is the system\'s alone: a learner, an operator and an administrator are refused', async () => {
    const attemptId = randomUUID();
    for (const context of [learnerContext, opsContext, adminContext]) {
      expect(expectError(await outcomes().handle({ attemptId }, context)).code).toBe('NOT_PERMITTED');
    }
  });

  it('reports an attempt that was never scored as not found', async () => {
    expect(expectError(await outcomes().handle({ attemptId: randomUUID() }, systemContext)).kind).toBe('NotFound');
  });
});

describe('re-scoring: the preview is the gate', () => {
  async function scored(attemptId: string, bench: Harness): Promise<void> {
    expectValue(await bench.score.handle(command(attemptId), opsContext));
  }

  it('refuses execution before a dry run', async () => {
    const bench = harness();
    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'upheld' },
        opsContext,
      ),
    );
    const refused = expectError(
      await bench.execute.handle({ operationId: operation.operationId, attempts: [] }, adminContext),
    );
    expect(refused.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses approval without step-up', async () => {
    const bench = harness();
    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'upheld' },
        opsContext,
      ),
    );
    const refused = expectError(await bench.approve.handle({ operationId: operation.operationId }, adminNoStepUp));
    expect(refused.code).toBe('STEP_UP_REQUIRED');
  });

  it('refuses approval from a principal who is only ops', async () => {
    const bench = harness();
    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'upheld' },
        opsContext,
      ),
    );
    expect(expectError(await bench.approve.handle({ operationId: operation.operationId }, opsContext)).code).toBe(
      'NOT_PERMITTED',
    );
  });

  it('previews, approves and executes, and the preview matches the execution exactly', async () => {
    const bench = harness();
    const attempts = [randomUUID(), randomUUID(), randomUUID()];
    for (const attemptId of attempts) await scored(attemptId, bench);

    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'key corrected to A' },
        opsContext,
      ),
    );

    // The corrected key turns every previously-correct answer into a wrong one.
    const corrected = attempts.map((attemptId) => command(attemptId, keyA, 'B'));

    const preview = expectValue(
      await bench.dryRun.handle({ operationId: operation.operationId, attempts: corrected }, opsContext),
    );
    expect(preview.affectedAttemptCount).toBe(3);
    expect(preview.scoreDeltaDistribution.worsened).toBe(3);

    expectValue(await bench.approve.handle({ operationId: operation.operationId }, adminContext));
    expectValue(await bench.execute.handle({ operationId: operation.operationId, attempts: corrected }, adminContext));

    // Every delta the preview promised is what the stored records now show.
    for (const delta of preview.deltas) {
      const current = expectValue(
        await bench.getRecord.handle({ attemptId: delta.attemptId, ownerUserId: LEARNER }, opsContext),
      );
      expect(current.totalRaw, delta.attemptId).toBe(delta.after);
      expect(current.generation).toBe(2);
    }
  });

  it('retains both generations after execution', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    await scored(attemptId, bench);

    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'KEY_DEFECT_CONFIRMED', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'defect' },
        opsContext,
      ),
    );
    const corrected = [command(attemptId, keyA, 'B')];
    expectValue(await bench.dryRun.handle({ operationId: operation.operationId, attempts: corrected }, opsContext));
    expectValue(await bench.approve.handle({ operationId: operation.operationId }, adminContext));
    expectValue(await bench.execute.handle({ operationId: operation.operationId, attempts: corrected }, adminContext));

    const generations = expectValue(
      await bench.listGenerations.handle({ attemptId, ownerUserId: LEARNER }, opsContext),
    );
    expect(generations.map((view) => view.generation)).toEqual([1, 2]);
    expect(generations.map((view) => view.isCurrent)).toEqual([false, true]);
  });

  it('publishes AttemptsRescored when execution completes', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    await scored(attemptId, bench);

    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'RULE_CORRECTION', scope: 'RULE_CHANGE', scopeRef: 'rs-1', reason: 'rule corrected' },
        opsContext,
      ),
    );
    const corrected = [command(attemptId, keyA, 'B')];
    expectValue(await bench.dryRun.handle({ operationId: operation.operationId, attempts: corrected }, opsContext));
    expectValue(await bench.approve.handle({ operationId: operation.operationId }, adminContext));
    expectValue(await bench.execute.handle({ operationId: operation.operationId, attempts: corrected }, adminContext));

    const rescored = (await outboxFor(operation.operationId)).filter((e) => e.event_type === 'AttemptsRescored');
    expect(rescored).toHaveLength(1);
    expect(rescored[0]!.payload.attemptCount).toBe(1);
  });

  it('announces each attempt it superseded, naming the record that stands and the one it replaced (D72)', async () => {
    const bench = harness();
    const attempts = [randomUUID(), randomUUID(), randomUUID()];
    for (const attemptId of attempts) await scored(attemptId, bench);
    const first = (await database.pool.query('SELECT attempt_id, score_record_id FROM scoring.score_record WHERE attempt_id = ANY($1::uuid[])', [attempts])).rows;

    const operation = expectValue(
      await bench.draft.handle({ trigger: 'RULE_CORRECTION', scope: 'RULE_CHANGE', scopeRef: 'rs-d72', reason: 'rule corrected' }, opsContext),
    );
    const corrected = attempts.map((attemptId) => command(attemptId, keyA, 'B'));
    expectValue(await bench.dryRun.handle({ operationId: operation.operationId, attempts: corrected }, opsContext));
    expectValue(await bench.approve.handle({ operationId: operation.operationId }, adminContext));
    expectValue(await bench.execute.handle({ operationId: operation.operationId, attempts: corrected }, adminContext));

    const events = await outboxFor(operation.operationId);
    const superseded = events.filter((e) => e.event_type === 'AttemptScoreSuperseded');
    expect(superseded).toHaveLength(3);
    expect(new Set(superseded.map((e) => e.payload.attemptId))).toEqual(new Set(attempts));
    for (const event of superseded) {
      const before = first.find((record) => record.attempt_id === event.payload.attemptId)!;
      const now = await database.pool.query('SELECT score_record_id, generation FROM scoring.score_record WHERE attempt_id = $1 AND is_current', [event.payload.attemptId]);
      expect(event.payload).toMatchObject({ rescoringOperationId: operation.operationId, supersededScoreRecordId: before.score_record_id, scoreRecordId: now.rows[0].score_record_id, generation: 2 });
    }
    expect(events.filter((e) => e.event_type === 'AttemptsRescored')).toHaveLength(1);
  });

  it('audits every step of the operation', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    await scored(attemptId, bench);
    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'upheld' },
        opsContext,
      ),
    );
    const corrected = [command(attemptId, keyA, 'B')];
    expectValue(await bench.dryRun.handle({ operationId: operation.operationId, attempts: corrected }, opsContext));
    expectValue(await bench.approve.handle({ operationId: operation.operationId }, adminContext));
    expectValue(await bench.execute.handle({ operationId: operation.operationId, attempts: corrected }, adminContext));

    const actions = bench.audit.entriesFor(operation.operationId).map((entry) => entry.action);
    expect(actions).toEqual(['DraftRescoring', 'ApproveRescoring', 'ExecuteRescoring']);
  });

  it('refuses a draft with no reason', async () => {
    const refused = expectError(
      await harness().draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: '   ' },
        opsContext,
      ),
    );
    expect(refused.code).toBe('REASON_REQUIRED');
  });
});

describe('queries', () => {
  it('lets a learner read their own record', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    expectValue(await bench.score.handle(command(attemptId), opsContext));

    const view = expectValue(
      await bench.getRecord.handle({ attemptId, ownerUserId: LEARNER }, learnerContext),
    );
    expect(view.attemptId).toBe(attemptId);
  });

  it('refuses a learner reading someone else’s record', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    expectValue(await bench.score.handle(command(attemptId), opsContext));

    const denied = expectError(
      await bench.getRecord.handle({ attemptId, ownerUserId: randomUUID() }, learnerContext),
    );
    expect(denied.code).toBe('NOT_OWNER');
  });

  it('refuses a learner listing someone else’s generations', async () => {
    const denied = expectError(
      await harness().listGenerations.handle(
        { attemptId: randomUUID(), ownerUserId: randomUUID() },
        learnerContext,
      ),
    );
    expect(denied.code).toBe('NOT_OWNER');
  });

  it('explains every outcome by naming its rule', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    expectValue(await bench.score.handle(command(attemptId), opsContext));

    const view = expectValue(await bench.getRecord.handle({ attemptId, ownerUserId: LEARNER }, learnerContext));
    expect(view.itemOutcomes[0]?.ruleAppliedId).toBe('correct');
    expect(view.itemOutcomes[0]?.explanation).toBe('correct → +4 marks');
  });

  it('exposes no answer key, correct option or response payload (§9 rule 10)', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    expectValue(await bench.score.handle(command(attemptId), opsContext));

    const view = expectValue(await bench.getRecord.handle({ attemptId, ownerUserId: LEARNER }, learnerContext));
    const serialized = JSON.stringify(view);
    for (const forbidden of ['answerKey', 'optionId', 'correctOptionIds', 'responseSnapshot', 'expectedValue']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('reports a missing record rather than inventing one', async () => {
    const missing = expectError(
      await harness().getRecord.handle({ attemptId: randomUUID(), ownerUserId: LEARNER }, opsContext),
    );
    expect(missing.kind).toBe('NotFound');
  });

  it('returns a stored dry run', async () => {
    const bench = harness();
    const attemptId = randomUUID();
    expectValue(await bench.score.handle(command(attemptId), opsContext));
    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'upheld' },
        opsContext,
      ),
    );
    expectValue(
      await bench.dryRun.handle(
        { operationId: operation.operationId, attempts: [command(attemptId, keyA, 'B')] },
        opsContext,
      ),
    );

    const stored = expectValue(await bench.getDryRun.handle({ operationId: operation.operationId }, opsContext));
    expect(stored.affectedAttemptCount).toBe(1);
  });

  it('reports no dry run when none has been taken', async () => {
    const bench = harness();
    const operation = expectValue(
      await bench.draft.handle(
        { trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'upheld' },
        opsContext,
      ),
    );
    expect(expectError(await bench.getDryRun.handle({ operationId: operation.operationId }, opsContext)).code).toBe(
      'NO_DRY_RUN',
    );
  });

  it('refuses a learner reading a dry run at all', async () => {
    expect(
      expectError(await harness().getDryRun.handle({ operationId: randomUUID() }, learnerContext)).code,
    ).toBe('NOT_PERMITTED');
  });
});

describe('F36 — a policy-less handler cannot be registered', () => {
  it('registers every scoring handler with a declared policy', () => {
    const bench = harness();
    const registry = HandlerRegistry.of([
      bench.score,
      bench.draft,
      bench.dryRun,
      bench.approve,
      bench.execute,
      bench.getRecord,
      bench.listGenerations,
      bench.getDryRun,
    ] as unknown as Handler<never, unknown>[]);
    expect(registry.names).toHaveLength(8);
  });

  it('refuses a handler that declares none', () => {
    const policyLess = {
      name: 'PlantedPolicyLessHandler',
      policy: undefined,
      async handle() {
        return { ok: true as const, value: undefined };
      },
    };
    expect(() => HandlerRegistry.of([policyLess as unknown as Handler<never, unknown>])).toThrow(
      MissingAuthorizationPolicyError,
    );
  });
});
