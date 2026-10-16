import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { aCandidate, aRun, registering, versionId } from '../../../testing/generation-fixtures.js';
import { createModelVersion, createPromptVersion } from '../domain/version-registry.js';
import { PostgresGenerationCandidateRepository } from './generation-candidate.repository.js';
import { PostgresVersionRegistry } from './version-registry.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let registry: PostgresVersionRegistry;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  registry = new PostgresVersionRegistry(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const model = (providerModelId = `model-${randomUUID()}`) =>
  expectValue(createModelVersion({ modelVersionId: randomUUID(), providerModelId, automaticUpgradesProhibited: true }));
const prompt = (sourceFile = `prompts/${randomUUID()}.md`, contentSha256 = 'b'.repeat(64)) =>
  expectValue(createPromptVersion({ promptVersionId: randomUUID(), sourceFile, contentSha256 }));

describe('publishing and reading a model version', () => {
  it('reads back every field it was published with', async () => {
    const published = model('claude-opus-5-5-' + randomUUID());
    expectValue(await registry.registerModelVersion(published));

    const found = expectValue(await registry.findModelVersion(published.modelVersionId));
    expect(found.modelVersionId).toBe(published.modelVersionId);
    expect(found.providerModelId).toBe(published.providerModelId);
    expect(found.automaticUpgradesProhibited).toBe(true);
  });

  it('reports a version never published as NotFound', async () => {
    const id = randomUUID();
    const failure = expectError(await registry.findModelVersion(id));
    expect(failure.kind).toBe('NotFound');
    expect(failure.message).toContain(id);
  });

  it('refuses the same model under a second id as a Conflict — two ids for one version is what the registry prevents', async () => {
    const first = model();
    expectValue(await registry.registerModelVersion(first));
    const failure = expectError(await registry.registerModelVersion({ ...model(), providerModelId: first.providerModelId }));
    expect(failure.kind).toBe('Conflict');
    expect(failure.location).toBe('model_version_provider_model_key');
  });

  it('refuses the same id twice as a Conflict', async () => {
    const first = model();
    expectValue(await registry.registerModelVersion(first));
    expect(expectError(await registry.registerModelVersion({ ...first, providerModelId: 'other' })).kind).toBe('Conflict');
  });

  it('refuses an identifier the store cannot hold', async () => {
    expect(expectError(await registry.findModelVersion('not-a-uuid')).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('publishing and reading a prompt version', () => {
  it('reads back every field it was published with', async () => {
    const published = prompt('prompts/generate-mcq.md', 'c'.repeat(64));
    expectValue(await registry.registerPromptVersion(published));

    const found = expectValue(await registry.findPromptVersion(published.promptVersionId));
    expect(found.promptVersionId).toBe(published.promptVersionId);
    expect(found.sourceFile).toBe('prompts/generate-mcq.md');
    expect(found.contentSha256).toBe('c'.repeat(64));
  });

  it('refuses the same file at the same digest under a second id, and accepts a changed file', async () => {
    const first = prompt();
    expectValue(await registry.registerPromptVersion(first));
    const again = { ...prompt(), sourceFile: first.sourceFile, contentSha256: first.contentSha256 };
    expect(expectError(await registry.registerPromptVersion(again)).kind).toBe('Conflict');

    const edited = { ...prompt(), sourceFile: first.sourceFile, contentSha256: 'd'.repeat(64) };
    expectValue(await registry.registerPromptVersion(edited));
  });

  it('reports a version never published as NotFound, and a malformed identifier as refused', async () => {
    expect(expectError(await registry.findPromptVersion(randomUUID())).kind).toBe('NotFound');
    expect(expectError(await registry.findPromptVersion('not-a-uuid')).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('what the store refuses when the domain was bypassed', () => {
  it('a model version that does not prohibit upgrades, a bad digest, a blank file', async () => {
    const bad = (sql: string, params: unknown[]) => database.pool.query(sql, params).then(() => 'accepted', (error: Error) => error.message);
    expect(await bad(`INSERT INTO ai.model_version (provider_model_id, automatic_upgrades_prohibited) VALUES ('x-${randomUUID()}', false)`, [])).toContain('automatic_upgrades_prohibited');
    expect(await bad(`INSERT INTO ai.model_version (provider_model_id, automatic_upgrades_prohibited) VALUES ('  ', true)`, [])).toContain('provider_model_id');
    expect(await bad(`INSERT INTO ai.prompt_version (source_file, content_sha256) VALUES ('p.md', 'XYZ')`, [])).toContain('content_sha256');
    expect(await bad(`INSERT INTO ai.prompt_version (source_file, content_sha256) VALUES ('  ', '${'a'.repeat(64)}')`, [])).toContain('source_file');
  });
});

describe('F28 — “which candidates did prompt v7 produce?” is one query, now by join', () => {
  it('finds them through the registry row, however the runs were spelled', async () => {
    const runs = registering(database.pool);
    const candidates = new PostgresGenerationCandidateRepository(database.pool);
    const v7 = prompt('prompts/v7.md', 'e'.repeat(64));
    const v8 = prompt('prompts/v8.md', 'f'.repeat(64));
    expectValue(await registry.registerPromptVersion(v7));
    expectValue(await registry.registerPromptVersion(v8));
    const m = model();
    expectValue(await registry.registerModelVersion(m));

    const made: string[] = [];
    for (const [prompt_, count] of [[v7, 2], [v8, 1]] as const) {
      const run = aRun({ modelVersionId: m.modelVersionId, promptVersionId: prompt_.promptVersionId });
      expectValue(await runs.save(run));
      for (let index = 0; index < count; index += 1) {
        const candidate = aCandidate(run);
        expectValue(await candidates.save(candidate));
        if (prompt_ === v7) made.push(candidate.candidateId);
      }
    }

    const { rows } = await database.pool.query(
      `SELECT c.candidate_id
         FROM ai.generation_candidate c
         JOIN ai.prompt_version p ON p.prompt_version_id = c.prompt_version_id
        WHERE p.source_file = $1 AND p.content_sha256 = $2
        ORDER BY c.candidate_id`,
      ['prompts/v7.md', 'e'.repeat(64)],
    );
    expect(rows.map((row: { candidate_id: string }) => row.candidate_id).sort()).toEqual([...made].sort());
  });
});

describe('the migration’s own safety assertion', () => {
  // The column type change is safe only because nothing has written a text
  // version yet. The migration says so by refusing to run otherwise; this runs
  // that guard against a database that does hold a run.
  const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../infra/migrations');
  const guard = (() => {
    const text = readFileSync(join(MIGRATIONS, '20260903100000_ai_version_registry.sql'), 'utf8');
    const match = /(DO \$\$\nBEGIN\n {2}IF EXISTS \(SELECT 1 FROM ai\.generation_run\)[\s\S]*?END \$\$;)/u.exec(text);
    if (match === null) throw new Error('the migration no longer carries its safety guard');
    return match[1] as string;
  })();

  it('passes over an empty run table', async () => {
    // Triggers are switched off for this transaction alone, which is rolled back, only to empty the table the guard reads.
    const empty = await database.pool.connect();
    try {
      await empty.query('BEGIN');
      await empty.query('SET LOCAL session_replication_role = replica');
      await empty.query('DELETE FROM ai.generation_candidate');
      await empty.query('DELETE FROM ai.generation_run');
      await expect(empty.query(guard)).resolves.toBeDefined();
    } finally {
      await empty.query('ROLLBACK');
      empty.release();
    }
  });

  it('refuses to run over an existing run, naming how many', async () => {
    const runs = registering(database.pool);
    expectValue(await runs.save(aRun({ modelVersionId: versionId('model', 8001), promptVersionId: versionId('prompt', 8001) })));
    await expect(database.pool.query(guard)).rejects.toThrow(/ai_version_registry_refuses_existing_runs: \d+ run/u);
  });
});
