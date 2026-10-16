import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, registering } from '../../../../testing/generation-fixtures.js';
import { contextFor, principalWith } from '../../../../testing/generation-context.js';
import type { GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { PostgresVersionRegistry } from '../../infrastructure/version-registry.repository.js';
import { toAiProvenance } from '../content-draft-acl.js';
import { licensingProblems, provenanceLicensingCheck, RESOLVED_LICENSING_STATUSES } from './provenance-check.js';

/** Real Postgres and the real registry. Check 12 closes by itself, so it is tested whole. */
let database: TestDatabase;
let runs: GenerationRunRepository;
let registry: PostgresVersionRegistry;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  registry = new PostgresVersionRegistry(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const machine = contextFor(principalWith(['generation_pipeline'], 'system'));
const check = () => provenanceLicensingCheck(registry);
const GOOD_BODY = { licensing: { status: 'owned' } };

async function candidateWith(body: Record<string, unknown> = GOOD_BODY, confidence = 0.8): Promise<GenerationCandidate> {
  const run = aRun({ modelVersionId: randomUUID(), promptVersionId: randomUUID() });
  expectValue(await runs.save(run));
  return aCandidate(run, { body, confidence });
}

describe('check 12 — provenance and licensing completeness', () => {
  it('is a blocking check named for what it checks', () => {
    expect(check().check).toBe('provenance_licensing_completeness');
  });

  it('passes a candidate whose pin resolves, whose provenance content would take, and whose licensing is complete', async () => {
    const outcome = expectValue(await check().run(await candidateWith(), machine));
    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toContain('registry rows');
  });

  it('fails a candidate whose pin names a model version with no registry row, naming it', async () => {
    const candidate = await candidateWith();
    const ghost = randomUUID();
    const outcome = expectValue(await check().run({ ...candidate, pin: { ...candidate.pin, modelVersionId: ghost } }, machine));
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toContain(`the model version ${ghost} is not in the registry`);
  });

  it('fails one whose pin names a prompt version with no registry row, naming it', async () => {
    const candidate = await candidateWith();
    const ghost = randomUUID();
    const outcome = expectValue(await check().run({ ...candidate, pin: { ...candidate.pin, promptVersionId: ghost } }, machine));
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toContain(`the prompt version ${ghost} is not in the registry`);
  });

  it('reports both missing rows together, so a reviewer sees everything wrong at once', async () => {
    const candidate = await candidateWith();
    const outcome = expectValue(
      await check().run({ ...candidate, pin: { ...candidate.pin, modelVersionId: randomUUID(), promptVersionId: randomUUID() } }, machine),
    );
    expect(outcome.detail?.split('; ')).toHaveLength(2);
  });

  it('cannot run — rather than failing the candidate — when the registry itself cannot answer', async () => {
    const candidate = await candidateWith();
    const unreadable = { ...candidate, pin: { ...candidate.pin, modelVersionId: 'not-a-uuid' } };
    const result = await check().run(unreadable, machine);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PERSISTENCE_REJECTED');

    const unreadablePrompt = await check().run({ ...candidate, pin: { ...candidate.pin, promptVersionId: 'not-a-uuid' } }, machine);
    expect(unreadablePrompt.ok).toBe(false);
  });

  describe('it and the anti-corruption layer agree about provenance, because they are one function', () => {
    it('fails exactly when the ACL would refuse, with the ACL’s own words', async () => {
      const candidate = await candidateWith();
      const cases: GenerationCandidate[] = [
        { ...candidate, confidence: 2 },
        { ...candidate, confidence: Number.NaN },
        { ...candidate, confidence: undefined as never },
        { ...candidate, pin: { ...candidate.pin, runId: 'run-42' } },
        candidate,
      ];
      for (const forged of cases) {
        const acl = toAiProvenance(forged);
        const outcome = expectValue(await check().run(forged, machine));
        expect(outcome.outcome === 'pass', JSON.stringify(forged.confidence)).toBe(acl.ok && forged.pin.runId === candidate.pin.runId);
        if (!acl.ok) expect(outcome.detail).toContain(acl.error.message);
      }
    });
  });

  describe('licensing', () => {
    async function outcomeFor(licensing: unknown) {
      return expectValue(await check().run(await candidateWith({ licensing }), machine));
    }

    it('fails a proposal with no licensing at all', async () => {
      const candidate = await candidateWith({});
      const outcome = expectValue(await check().run(candidate, machine));
      expect(outcome.outcome).toBe('fail');
      expect(outcome.detail).toContain('no licensing');
    });

    it('fails licensing that is unresolved, which blocks publication', async () => {
      const outcome = await outcomeFor({ status: 'unresolved' });
      expect(outcome.outcome).toBe('fail');
      expect(outcome.detail).toContain('unresolved');
    });

    it.each(RESOLVED_LICENSING_STATUSES.filter((status) => status !== 'licensed'))('passes %s', async (status) => {
      expect((await outcomeFor({ status })).outcome).toBe('pass');
    });

    it('passes a licensed item that names its licence and its attribution', async () => {
      expect((await outcomeFor({ status: 'licensed', licenseRef: 'CC-BY-4.0', attribution: 'Example Press', expiresAt: '2030-01-01T00:00:00Z' })).outcome).toBe('pass');
    });
  });
});

describe('licensingProblems — every way licensing can be incomplete', () => {
  it('names each, so the verdict says what to fix', () => {
    expect(licensingProblems(undefined)).toEqual(['the proposal carries no licensing, which content treats as unresolved and will not publish']);
    expect(licensingProblems(null)).toHaveLength(1);
    expect(licensingProblems([])).toHaveLength(1);
    expect(licensingProblems('owned')).toHaveLength(1);
    expect(licensingProblems({ status: 'unresolved' })).toEqual(['licensing is unresolved, which blocks publication']);
    expect(licensingProblems({ status: 'sold' })).toEqual(['licensing status "sold" is not one content knows']);
    expect(licensingProblems({})).toEqual(['licensing status "undefined" is not one content knows']);
    expect(licensingProblems({ status: 'licensed' })).toEqual([
      'a licensed item requires a licenseRef naming the licence',
      'a licensed item requires the attribution its licence demands',
    ]);
    expect(licensingProblems({ status: 'licensed', licenseRef: ' ', attribution: 'x' })).toHaveLength(1);
    expect(licensingProblems({ status: 'licensed', licenseRef: 'x', attribution: 5 })).toHaveLength(1);
    expect(licensingProblems({ status: 'licensed', licenseRef: 'x', attribution: 'y', expiresAt: 'soon' })).toEqual([
      'expiresAt "soon" is not an ISO-8601 instant',
    ]);
    expect(licensingProblems({ status: 'licensed', licenseRef: 'x', attribution: 'y', expiresAt: 7 })).toHaveLength(1);
    expect(licensingProblems({ status: 'owned', expiresAt: '2030-01-01T00:00:00Z' })).toEqual([
      'status owned does not expire; an expiry here suggests it is really a licence',
    ]);
  });

  it('is silent on complete licensing, of each kind', () => {
    expect(licensingProblems({ status: 'owned' })).toEqual([]);
    expect(licensingProblems({ status: 'public_domain' })).toEqual([]);
    expect(licensingProblems({ status: 'licensed', licenseRef: 'x', attribution: 'y' })).toEqual([]);
    expect(licensingProblems({ status: 'licensed', licenseRef: 'x', attribution: 'y', expiresAt: '2030-01-01T00:00:00.5+05:30' })).toEqual([]);
  });
});
