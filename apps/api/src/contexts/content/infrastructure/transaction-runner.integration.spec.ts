import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { err, ok } from '../domain/result.js';
import { validationError } from '../domain/content-error.js';
import type { TransactionContext } from '../domain/repository-ports.js';
import { clientOf, PostgresTransactionRunner } from './transaction-runner.js';

let database: TestDatabase;
let runner: PostgresTransactionRunner;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runner = new PostgresTransactionRunner(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('PostgresTransactionRunner (M4-28)', () => {
  it('commits when fn resolves ok, and the tx it hands fn can run a real query', async () => {
    const result = await runner.run(async (tx) => {
      const client = clientOf(tx);
      const row = await client.query<{ one: number }>('SELECT 1 AS one');
      return ok(row.rows[0]!.one);
    });
    expect(result).toEqual({ ok: true, value: 1 });
  });

  it('rolls back when fn resolves an error Result, and returns that Result untouched', async () => {
    const forced = validationError('PERSISTENCE_REJECTED', 'forced', 'test');
    const result = await runner.run(async () => err(forced));
    expect(result).toEqual({ ok: false, error: forced });
  });

  it('rolls back and converts a thrown error to a PERSISTENCE_REJECTED Result, rather than rethrowing', async () => {
    const result = await runner.run(async () => {
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PERSISTENCE_REJECTED');
      expect(result.error.message).toContain('boom');
    }
  });

  it('a write inside a rolled-back transaction does not survive', async () => {
    const marker = `txr-${Date.now()}`;
    const result = await runner.run(async (tx) => {
      const client = clientOf(tx);
      await client.query('CREATE TEMP TABLE IF NOT EXISTS txr_probe (marker text) ON COMMIT DROP');
      await client.query('INSERT INTO txr_probe (marker) VALUES ($1)', [marker]);
      return err(validationError('PERSISTENCE_REJECTED', 'forced', 'test'));
    });
    expect(result.ok).toBe(false);
    // The temp table itself lived only inside the rolled-back transaction —
    // asking a fresh connection about it is asking whether anything at all
    // survived, which is the strongest form of "nothing was written".
    const survived = await database.pool.query(`SELECT to_regclass('txr_probe') AS reg`);
    expect(survived.rows[0]!.reg).toBeNull();
  });
});

describe('clientOf (M4-28)', () => {
  it('refuses a TransactionContext this module did not construct', () => {
    const foreign: TransactionContext = { kind: 'TransactionContext' };
    expect(() => clientOf(foreign)).toThrow(TypeError);
    expect(() => clientOf(foreign)).toThrow(/not constructed by PostgresTransactionRunner/u);
  });
});
