import { randomUUID } from 'node:crypto';
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
import { ScoreAttemptHandler, type EventPublisher } from './handlers/scoring-handlers.js';
import {
  ApproveRescoringHandler,
  DraftRescoringHandler,
  ExecuteRescoringHandler,
  RunRescoringDryRunHandler,
  type RescoringEventPublisher,
} from './handlers/rescoring-handlers.js';
import {
  GetScoreRecordHandler,
  ListScoreRecordGenerationsHandler,
  GetRescoringDryRunHandler,
} from './queries/scoring-queries.js';
import type { AttemptScored, AttemptsRescored } from '../domain/events/scoring-events.js';
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

class RecordingPublisher implements EventPublisher, RescoringEventPublisher {
  readonly events: (AttemptScored | AttemptsRescored)[] = [];
  async publish(event: AttemptScored | AttemptsRescored): Promise<void> {
    this.events.push(event);
  }
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
  readonly publisher: RecordingPublisher;
}

function harness(): Harness {
  const records = new PostgresScoreRecordRepository(database.pool);
  const operations = new PostgresRescoringOperationRepository(database.pool);
  const audit = new InMemoryAuditRecorder();
  const publisher = new RecordingPublisher();
  const deps = {
    records,
    operations,
    clock: new FixedClock(new Date('2026-08-07T00:00:00.000Z')),
    identifiers: new SequentialIdentifiers(),
    audit,
    events: publisher,
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
    publisher,
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
    await bench.score.handle(command(randomUUID()), opsContext);
    const event = bench.publisher.events[0] as AttemptScored;
    expect(event.eventType).toBe('AttemptScored');
    expect(event.payload.totalRaw).toBe('4');
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

    const rescored = bench.publisher.events.find((event) => event.eventType === 'AttemptsRescored');
    expect(rescored).toBeDefined();
    expect((rescored as AttemptsRescored).payload.attemptCount).toBe(1);
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
