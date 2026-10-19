import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { ensureVersions, registering } from '../../../../testing/generation-fixtures.js';
import { RecordingAudit, contextFor, principalWith } from '../../../../testing/generation-context.js';
import { periodOf } from '../../domain/ai-budget.js';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { PostgresEvaluationRunRepository } from '../../infrastructure/evaluation-run.repository.js';
import { PostgresAIBudgetRepository } from '../../infrastructure/ai-budget.repository.js';
import type { Clock } from '../ports.js';
import { DeclareAIBudgetHandler, StartGenerationRunHandler } from './run-handlers.js';

/**
 * The budget at enqueue (M5-41, DEC-M5-9), against real Postgres. No provider is
 * involved anywhere in this file: a run that does not fit is refused before
 * anything could be dispatched, which is the property under test, so what it costs
 * to prove it is nothing.
 *
 * Each test works in a month of its own, so a budget and the runs against it
 * belong to that test alone and nothing depends on the order the others ran in.
 */
let database: TestDatabase;
let runs: GenerationRunRepository;
let budgets: PostgresAIBudgetRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  await ensureVersions(database.pool, { modelVersionId: '00000000-0000-4000-8000-0000000a0003', promptVersionId: '00000000-0000-4000-8000-0000000b0007' });
  budgets = new PostgresAIBudgetRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const pipeline = principalWith(['generation_pipeline'], 'system');
const ops = principalWith(['content_ops']);

let monthCounter = 0;
/** A fresh UTC month per call: 2027-01, 2027-02, … */
function nextMonth(): { period: string; clock: Clock; at: (day: string) => Clock } {
  monthCounter += 1;
  const period = `${2027 + Math.floor((monthCounter - 1) / 12)}-${String(((monthCounter - 1) % 12) + 1).padStart(2, '0')}`;
  const at = (rest: string): Clock => ({ now: () => new Date(`${period}-${rest}Z`) });
  return { period, clock: at('10T09:00:00.000'), at };
}

async function declare(period: string, ceilingTokens: number) {
  return budgets.declare({ feature: 'generation', period, ceilingTokens }, { kind: 'human', id: randomUUID() }, '2026-10-01T00:00:00.000Z');
}

function starter(clock: Clock, audit = new RecordingAudit()) {
  return { audit, start: new StartGenerationRunHandler({ runs, evaluations: new PostgresEvaluationRunRepository(database.pool), clock, identifiers: { next: () => randomUUID() }, audit }) };
}

const command = (budgetTokens: number) => ({
  modelVersionId: '00000000-0000-4000-8000-0000000a0003',
  promptVersionId: '00000000-0000-4000-8000-0000000b0007',
  request: { band: 'medium' },
  budgetTokens,
});

const runCount = async (): Promise<number> => (await database.pool.query('SELECT count(*)::int AS n FROM ai.generation_run')).rows[0].n as number;

describe('a run is admitted against its period’s budget at enqueue', () => {
  it('starts when it fits, and records what it reserved', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    const started = expectValue(await starter(clock).start.handle(command(4_000), contextFor(pipeline)));
    expect(expectValue(await runs.findById(started.pin.runId)).budgetTokens).toBe(4_000);
  });

  it('is refused when it would exceed the ceiling: nothing is written, nothing is audited, and the figures are in the error', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    const before = await runCount();
    const { start, audit } = starter(clock);

    const failure = expectError(await start.handle(command(10_001), contextFor(pipeline)));

    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('RUN_EXCEEDS_BUDGET');
    expect(failure.message).toContain('10001');
    expect(failure.message).toContain('10000');
    expect(await runCount()).toBe(before);
    expect(audit.entries).toEqual([]);
  });

  it('fits exactly to the ceiling, and one token over does not', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    const { start } = starter(clock);
    expectValue(await start.handle(command(6_000), contextFor(pipeline)));
    expect(expectError(await start.handle(command(4_001), contextFor(pipeline))).code).toBe('RUN_EXCEEDS_BUDGET');
    expectValue(await start.handle(command(4_000), contextFor(pipeline)));
    expect(expectError(await start.handle(command(1), contextFor(pipeline))).code).toBe('RUN_EXCEEDS_BUDGET');
  });

  it('counts what earlier runs reserved, not only the run asking: two runs that each fit alone do not both start', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    const { start } = starter(clock);
    expectValue(await start.handle(command(7_000), contextFor(pipeline)));
    const second = expectError(await start.handle(command(7_000), contextFor(pipeline)));
    expect(second.code).toBe('RUN_EXCEEDS_BUDGET');
    expect(second.message).toContain('7000 of the period');
    expect(second.message).toContain('3000 remain');
  });

  it('refuses a period with no declared budget — an absent ceiling is not an unlimited one', async () => {
    const { clock } = nextMonth();
    const before = await runCount();
    const failure = expectError(await starter(clock).start.handle(command(1), contextFor(pipeline)));
    expect(failure.code).toBe('BUDGET_NOT_DECLARED');
    expect(failure.message).toContain('generation');
    expect(await runCount()).toBe(before);
  });

  it('charges each month to its own budget: a full month does not close the next', async () => {
    const first = nextMonth();
    const second = nextMonth();
    expectValue(await declare(first.period, 1_000));
    expectValue(await declare(second.period, 1_000));
    expectValue(await starter(first.clock).start.handle(command(1_000), contextFor(pipeline)));
    expect(expectError(await starter(first.clock).start.handle(command(1), contextFor(pipeline))).code).toBe('RUN_EXCEEDS_BUDGET');
    expectValue(await starter(second.clock).start.handle(command(1_000), contextFor(pipeline)));
  });

  // Two implementations of one rule drift: the period's name is TypeScript (`periodOf`) and its
  // bounds are SQL. Held to the same answer at the last millisecond of a month and the first of the next.
  it('puts the last millisecond of a month in that month and the first of the next in the next — SQL and TypeScript agree', async () => {
    const first = nextMonth();
    const second = nextMonth();
    expectValue(await declare(first.period, 1_000));
    expectValue(await declare(second.period, 1_000));
    const lastDay = new Date(Date.UTC(Number(first.period.slice(0, 4)), Number(first.period.slice(5)), 0)).getUTCDate();
    const lastMillisecond = first.at(`${String(lastDay)}T23:59:59.999`);
    const firstMillisecond: Clock = { now: () => new Date(`${second.period}-01T00:00:00.000Z`) };

    expect(periodOf(lastMillisecond.now().toISOString())).toBe(first.period);
    expect(periodOf(firstMillisecond.now().toISOString())).toBe(second.period);
    expectValue(await starter(lastMillisecond).start.handle(command(1_000), contextFor(pipeline)));
    expectValue(await starter(firstMillisecond).start.handle(command(1_000), contextFor(pipeline)));
    // Each filled its own month exactly; if SQL had counted either in the other's, the next would have fit or this would have refused.
    expect(expectError(await starter(lastMillisecond).start.handle(command(1), contextFor(pipeline))).code).toBe('RUN_EXCEEDS_BUDGET');
    expect(expectError(await starter(firstMillisecond).start.handle(command(1), contextFor(pipeline))).code).toBe('RUN_EXCEEDS_BUDGET');
  });

  it('cannot be oversubscribed by runs enqueued at the same moment', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    const before = await runCount();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => starter(clock).start.handle(command(4_000), contextFor(pipeline))),
    );

    // 4,000 × 2 fits in 10,000 and a third does not: exactly two, however the eight interleave.
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    expect(outcomes.filter((outcome) => !outcome.ok).every((outcome) => !outcome.ok && outcome.error.code === 'RUN_EXCEEDS_BUDGET')).toBe(true);
    expect(await runCount()).toBe(before + 2);
  });

  // The test above is the outcome; this is the mechanism. Racing eight requests passes whether or not
  // anything serializes them (it did, with the lock removed), so the proof is made deterministic: the test
  // holds the budget's lock itself, starts an enqueue, and waits — for a condition, not a duration — until
  // the database reports that enqueue waiting on that lock. An enqueue that never takes the lock never
  // appears there, and this fails.
  it('serializes enqueues for one budget on a lock: an enqueue waits while the lock is held, and runs when it is released', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    const before = await runCount();
    const holder = await database.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai_budget:generation:${period}`]);

      const pending = starter(clock).start.handle(command(1_000), contextFor(pipeline));

      await vi.waitFor(
        async () => {
          const waiting = await database.pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
          expect(waiting.rows[0].n).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 25 },
      );
      expect(await runCount()).toBe(before);

      await holder.query('COMMIT');
      expectValue(await pending);
      expect(await runCount()).toBe(before + 1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('refuses a reservation that is not a positive whole number of tokens, naming the field', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declare(period, 10_000));
    for (const bad of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const failure = expectError(await starter(clock).start.handle(command(bad), contextFor(pipeline)));
      expect(failure.code, String(bad)).toBe('RUN_BUDGET_INVALID');
      expect(failure.location).toBe('budgetTokens');
    }
  });
});

describe('DeclareAIBudget', () => {
  const declaring = (clock: Clock) => {
    const audit = new RecordingAudit();
    return { audit, handler: new DeclareAIBudgetHandler({ budgets, clock, audit }) };
  };

  it('declares a ceiling for a feature and month, audited under the declarer', async () => {
    const { period, clock } = nextMonth();
    const { handler, audit } = declaring(clock);
    const declared = expectValue(await handler.handle({ feature: 'generation', period, ceilingTokens: 5_000 }, contextFor(ops, 'corr-budget-1')));

    expect(declared).toEqual({ feature: 'generation', period, ceilingTokens: 5_000 });
    expect(expectValue(await budgets.find('generation', period))).toEqual(declared);
    expect(audit.entries.map((entry) => [entry.action, entry.targetId, entry.correlationId])).toEqual([['DeclareAIBudget', `generation:${period}`, 'corr-budget-1']]);
  });

  it('is Content Ops’ alone: the pipeline that spends against a ceiling cannot set it', async () => {
    const { period, clock } = nextMonth();
    for (const roles of [['generation_pipeline'], ['author'], ['reviewer'], []]) {
      const refused = expectError(await declaring(clock).handler.handle({ feature: 'generation', period, ceilingTokens: 5_000 }, contextFor(principalWith(roles))));
      expect(refused.code, roles.join()).toBe('NOT_PERMITTED');
    }
    expect(expectValue(await budgets.find('generation', period))).toBeUndefined();
  });

  it('declares a period once: a second declaration is a conflict, and the first ceiling stands (D48)', async () => {
    const { period, clock } = nextMonth();
    const { handler } = declaring(clock);
    expectValue(await handler.handle({ feature: 'generation', period, ceilingTokens: 5_000 }, contextFor(ops)));
    expect(expectError(await handler.handle({ feature: 'generation', period, ceilingTokens: 9_000 }, contextFor(ops))).kind).toBe('Conflict');
    expect(expectValue(await budgets.find('generation', period))?.ceilingTokens).toBe(5_000);
  });

  it('refuses a blank feature, a period that is not a month, and a ceiling that is not a positive whole number', async () => {
    const { period, clock } = nextMonth();
    const { handler } = declaring(clock);
    const cases: [Parameters<typeof handler.handle>[0], string][] = [
      [{ feature: ' ', period, ceilingTokens: 1 }, 'BUDGET_FEATURE_INVALID'],
      [{ feature: 'generation', period: '2027-13', ceilingTokens: 1 }, 'BUDGET_PERIOD_INVALID'],
      [{ feature: 'generation', period: '2027-1', ceilingTokens: 1 }, 'BUDGET_PERIOD_INVALID'],
      [{ feature: 'generation', period, ceilingTokens: 0 }, 'BUDGET_CEILING_INVALID'],
      [{ feature: 'generation', period, ceilingTokens: 2.5 }, 'BUDGET_CEILING_INVALID'],
    ];
    for (const [input, code] of cases) expect(expectError(await handler.handle(input, contextFor(ops))).code).toBe(code);
  });

  it('is append-only: the table refuses an UPDATE or DELETE from every role', async () => {
    const { period, clock } = nextMonth();
    expectValue(await declaring(clock).handler.handle({ feature: 'generation', period, ceilingTokens: 5_000 }, contextFor(ops)));
    await expect(database.pool.query(`UPDATE ai.ai_budget SET ceiling_tokens = 9 WHERE period = $1`, [period])).rejects.toThrow(/append-only/u);
    await expect(database.pool.query(`DELETE FROM ai.ai_budget WHERE period = $1`, [period])).rejects.toThrow(/append-only/u);
  });
});
