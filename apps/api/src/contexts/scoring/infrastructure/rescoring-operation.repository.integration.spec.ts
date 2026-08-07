import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { buildDryRunResult } from '../domain/rescoring-dry-run.js';
import {
  approveRescoring,
  beginExecution,
  completeExecution,
  draftRescoring,
  recordDryRun,
  type RescoringOperation,
} from '../domain/rescoring-operation.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { PostgresRescoringOperationRepository } from './rescoring-operation.repository.js';

let database: TestDatabase;
let repository: PostgresRescoringOperationRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  repository = new PostgresRescoringOperationRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const PRINCIPAL = '00000000-0000-0000-0000-0000000000aa';

function drafted(): RescoringOperation {
  return expectValue(
    draftRescoring({
      operationId: randomUUID(),
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'iv-1',
      reason: 'answer key challenge upheld',
    }),
  );
}

describe('round trip', () => {
  it('saves and reloads a draft', async () => {
    const operation = drafted();
    expectValue(await repository.save(operation));

    const loaded = expectValue(await repository.findById(operation.operationId));
    expect(loaded.operationId).toBe(operation.operationId);
    expect(loaded.state).toBe('drafted');
    expect(loaded.reason).toBe('answer key challenge upheld');
    expect(loaded.dryRunResult).toBeUndefined();
  });

  it('round trips the dry-run result through JSONB', async () => {
    const operation = drafted();
    expectValue(await repository.save(operation));

    const preview = buildDryRunResult([]);
    const previewed = expectValue(recordDryRun(expectValue(await repository.findById(operation.operationId)), preview));
    expectValue(await repository.save(previewed));

    const loaded = expectValue(await repository.findById(operation.operationId));
    expect(loaded.state).toBe('previewed');
    expect(loaded.dryRunResult).toEqual(preview);
  });

  it('records who approved it', async () => {
    const operation = drafted();
    expectValue(await repository.save(operation));
    const previewed = expectValue(recordDryRun(operation, buildDryRunResult([])));
    expectValue(await repository.save({ ...previewed, expectedVersion: 1 }));

    const loaded = expectValue(await repository.findById(operation.operationId));
    const approved = expectValue(approveRescoring(loaded, PRINCIPAL));
    expectValue(await repository.save(approved));

    expect(expectValue(await repository.findById(operation.operationId)).authorizedBy).toBe(PRINCIPAL);
  });

  it('stamps completion', async () => {
    const operation = drafted();
    expectValue(await repository.save(operation));
    let current = expectValue(recordDryRun(expectValue(await repository.findById(operation.operationId)), buildDryRunResult([])));
    expectValue(await repository.save(current));
    current = expectValue(approveRescoring(expectValue(await repository.findById(operation.operationId)), PRINCIPAL));
    expectValue(await repository.save(current));
    current = expectValue(beginExecution(expectValue(await repository.findById(operation.operationId))));
    expectValue(await repository.save(current));
    current = expectValue(completeExecution(expectValue(await repository.findById(operation.operationId)), '2026-08-07T01:00:00.000Z'));
    expectValue(await repository.save(current));

    const loaded = expectValue(await repository.findById(operation.operationId));
    expect(loaded.state).toBe('completed');
    expect(loaded.executedAt).toBe('2026-08-07T01:00:00.000Z');
  });

  it('reports a missing operation rather than inventing one', async () => {
    expect(expectError(await repository.findById(randomUUID())).kind).toBe('NotFound');
  });
});

describe('optimistic concurrency (P8)', () => {
  it('refuses a write from a stale read rather than overwriting', async () => {
    const operation = drafted();
    expectValue(await repository.save(operation));

    const readA = expectValue(await repository.findById(operation.operationId));
    const readB = expectValue(await repository.findById(operation.operationId));

    expectValue(await repository.save(expectValue(recordDryRun(readA, buildDryRunResult([])))));

    // B has not seen A's preview. Its write must be refused, not silently win.
    const conflict = expectError(await repository.save(expectValue(recordDryRun(readB, buildDryRunResult([])))));
    expect(conflict.code).toBe('CONFLICT');
  });

  it('surfaces a rejected write rather than swallowing it', async () => {
    const broken = { ...drafted(), state: 'not-a-state' } as unknown as RescoringOperation;
    expect(expectError(await repository.save(broken)).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('querying by state', () => {
  it('returns the operations in a given state', async () => {
    const first = drafted();
    const second = drafted();
    expectValue(await repository.save(first));
    expectValue(await repository.save(second));

    const found = expectValue(await repository.findByState('drafted'));
    const ids = found.map((operation) => operation.operationId);
    expect(ids).toContain(first.operationId);
    expect(ids).toContain(second.operationId);
  });

  it('returns an empty list for a state nothing is in', async () => {
    expect(expectValue(await repository.findByState('executing'))).toEqual([]);
  });
});
