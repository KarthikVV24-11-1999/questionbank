import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAuditRecorder } from '../../../platform/persistence/audit-recorder.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { D002_THRESHOLDS, PLATFORM_THRESHOLDS_V2, thresholdsWith } from '../../../testing/learning-thresholds.js';
import { PublishMasteryRuleSetHandler } from '../application/handlers/rule-set-handlers.js';
import { hashThresholds } from '../domain/mastery-rule-set.js';
import { PostgresMasteryRuleSetRepository } from './mastery-rule-set.repository.js';

let database: TestDatabase;
let repository: PostgresMasteryRuleSetRepository;
let publish: PublishMasteryRuleSetHandler;

const admin = { principal: { kind: 'human' as const, id: randomUUID(), roleContext: ['admin'] }, correlationId: 'c', stepUpSatisfied: true };
const DEFAULT_ID = '00000000-0000-4000-8000-0000000000d2';
const DEFAULT_V2_ID = '00000000-0000-4000-8000-0000000000d3';

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresMasteryRuleSetRepository(database.pool);
  publish = new PublishMasteryRuleSetHandler({
    ruleSets: repository,
    clock: { now: () => new Date('2026-10-28T09:00:00.000Z') },
    identifiers: { next: () => randomUUID() },
    audit: new PostgresAuditRecorder(database.pool) as never,
  });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('the platform default the migration seeds', () => {
  it('is D-002 as the test fixture states it, and its hash is the one the TypeScript computes: two statements of one set of numbers', async () => {
    const seeded = expectValue(await repository.byId(DEFAULT_ID));
    expect(seeded.thresholds).toEqual(D002_THRESHOLDS);
    expect(seeded.thresholdsHash).toBe(hashThresholds(D002_THRESHOLDS));
    const { rows } = await database.pool.query('SELECT thresholds_hash FROM learning.mastery_rule_set WHERE rule_set_id = $1', [DEFAULT_ID]);
    expect(rows[0].thresholds_hash).toBe(seeded.thresholdsHash);
    expect(seeded).toMatchObject({ taxonomyVersionId: null, versionNo: 1 });
  });

  it('has a second version with the pace and review values, held to the fixture and to its hash, and leaves the first without them (M7-46, M7-47)', async () => {
    const second = expectValue(await repository.byId(DEFAULT_V2_ID));
    expect(second.thresholds).toEqual(PLATFORM_THRESHOLDS_V2);
    expect(second.thresholdsHash).toBe(hashThresholds(PLATFORM_THRESHOLDS_V2));
    const { rows } = await database.pool.query('SELECT thresholds_hash FROM learning.mastery_rule_set WHERE rule_set_id = $1', [DEFAULT_V2_ID]);
    expect(rows[0].thresholds_hash).toBe(second.thresholdsHash);
    expect(second).toMatchObject({ taxonomyVersionId: null, versionNo: 2 });
    expect(expectValue(await repository.byId(DEFAULT_ID)).thresholds).not.toHaveProperty('pace');
  });

  it('is what a taxonomy with nothing published gets: the latest of the default', async () => {
    expect(expectValue(await repository.currentFor(randomUUID())).ruleSetId).toBe(DEFAULT_V2_ID);
  });
});

describe('publishing a version', () => {
  it('appends the next version for a scope, hashes it, audits it, and prefers it to the default for that taxonomy only', async () => {
    const taxonomy = randomUUID();
    const tighter = thresholdsWith({ promotion: { minRecentAccuracy: 0.9 } });
    const first = expectValue(await publish.handle({ taxonomyVersionId: taxonomy, thresholds: tighter }, admin));
    expect(first).toMatchObject({ taxonomyVersionId: taxonomy, versionNo: 1, thresholdsHash: hashThresholds(tighter) });

    const second = expectValue(await publish.handle({ taxonomyVersionId: taxonomy, thresholds: thresholdsWith({ promotion: { minRecentAccuracy: 0.85 } }) }, admin));
    expect(second.versionNo).toBe(2);
    expect(expectValue(await repository.currentFor(taxonomy)).ruleSetId).toBe(second.ruleSetId);
    // the first version is still there, whole, for the transitions that were decided under it
    expect(expectValue(await repository.byId(first.ruleSetId)).thresholds.promotion.minRecentAccuracy).toBe(0.9);
    // another taxonomy still gets the default
    expect(expectValue(await repository.currentFor(randomUUID())).ruleSetId).toBe(DEFAULT_V2_ID);

    const audited = await database.pool.query(`SELECT action, target_context, target_id, target_version FROM platform.audit_record WHERE target_id = $1`, [second.ruleSetId]);
    expect(audited.rows).toEqual([{ action: 'PublishMasteryRuleSet', target_context: 'learning', target_id: second.ruleSetId, target_version: 2 }]);
  });

  it('numbers the platform default\'s versions on from the seed, as a scope of its own', async () => {
    const next = expectValue(await publish.handle({ taxonomyVersionId: null, thresholds: thresholdsWith({ session: { idleGapMinutes: 45 } }) }, admin));
    expect(next.versionNo).toBe(3);
    expect(expectValue(await repository.currentFor(randomUUID())).ruleSetId).toBe(next.ruleSetId);
  });
});

describe('a published version is immutable, at the database', () => {
  it('refuses an update and a delete, whoever asks, and the row is as it was', async () => {
    for (const statement of [
      `UPDATE learning.mastery_rule_set SET thresholds_hash = repeat('0', 64) WHERE rule_set_id = '${DEFAULT_ID}'`,
      `DELETE FROM learning.mastery_rule_set WHERE rule_set_id = '${DEFAULT_ID}'`,
    ]) {
      await expect(database.pool.query(statement)).rejects.toThrow(/learning_mastery_rule_set_is_immutable/u);
    }
    expect(expectValue(await repository.byId(DEFAULT_ID)).thresholdsHash).toBe(hashThresholds(D002_THRESHOLDS));
  });

  it('refuses a second row for the same scope and version, and a hash that is not one', async () => {
    const row = (id: string, hash: string) =>
      database.pool.query(
        `INSERT INTO learning.mastery_rule_set (rule_set_id, taxonomy_version_id, version_no, thresholds, thresholds_hash, authored_by_kind, authored_by_id, created_at)
         VALUES ($1, NULL, 1, '{}', $2, 'system', $1, now())`,
        [id, hash],
      );
    await expect(row(randomUUID(), 'a'.repeat(64))).rejects.toThrow(/mastery_rule_set_scope_version/u);
    await expect(row(randomUUID(), 'not-a-hash')).rejects.toThrow(/thresholds_hash/u);
  });
});

describe('what the store says when it cannot answer', () => {
  it('reports a version taken at the same moment as a Conflict, and an unreachable store as Unavailable', async () => {
    const taken = new PostgresMasteryRuleSetRepository({ query: async () => Promise.reject(Object.assign(new Error('duplicate'), { code: '23505' })) } as never);
    const draft = { ruleSetId: randomUUID(), taxonomyVersionId: null, thresholds: D002_THRESHOLDS, thresholdsHash: hashThresholds(D002_THRESHOLDS), principal: admin.principal, createdAt: new Date() };
    expect(expectError(await taken.append(draft)).code).toBe('RULE_SET_VERSION_TAKEN');

    const down = new PostgresMasteryRuleSetRepository({ query: async () => Promise.reject(new Error('relation "secret" missing')) } as never);
    for (const failure of [await down.append(draft), await down.currentFor(randomUUID()), await down.byId(randomUUID())]) {
      const error = expectError(failure);
      expect(error.code).toBe('STORE_UNAVAILABLE');
      expect(error.message).not.toContain('secret');
    }
  });

  it('says not found for a version there is none of, and refuses to read a stored row that no longer satisfies the domain', async () => {
    expect(expectError(await repository.byId(randomUUID())).code).toBe('NO_RULE_SET');
    const empty = new PostgresMasteryRuleSetRepository({ query: async () => ({ rows: [] }) } as never);
    expect(expectError(await empty.currentFor(randomUUID())).code).toBe('NO_RULE_SET');
    const corrupt = new PostgresMasteryRuleSetRepository({ query: async () => ({ rows: [{ rule_set_id: randomUUID(), taxonomy_version_id: null, version_no: 1, thresholds: {} }] }) } as never);
    expect(expectError(await corrupt.byId(randomUUID())).code).toBe('PERSISTENCE_REJECTED');
  });
});
