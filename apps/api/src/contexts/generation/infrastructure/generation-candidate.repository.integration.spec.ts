import { randomUUID } from 'node:crypto';
import type { GenerationRunRepository } from '../domain/repository-ports.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  PRINCIPAL,
  acceptedEvent,
  aCandidate,
  aRun,
  rejectedEvent, registering } from '../../../testing/generation-fixtures.js';
import {
  acceptCandidate,
  recordVerdict,
  rejectCandidate,
  type GenerationCandidate,
  type PrecheckVerdict,
} from '../domain/generation-candidate.js';
import type { GenerationRun } from '../domain/generation-run.js';
import { BLOCKING_PRECHECKS } from '../domain/precheck-vocabulary.js';
import { PostgresGenerationCandidateRepository } from './generation-candidate.repository.js';
import { PostgresGenerationRunRepository } from './generation-run.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let candidates: PostgresGenerationCandidateRepository;
let runs: GenerationRunRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  candidates = new PostgresGenerationCandidateRepository(database.pool);
  runs = registering(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

async function savedRun(overrides: Parameters<typeof aRun>[0] = {}): Promise<GenerationRun> {
  const run = aRun(overrides);
  expectValue(await runs.save(run));
  return run;
}

function withVerdicts(candidate: GenerationCandidate, verdicts: readonly PrecheckVerdict[]): GenerationCandidate {
  return verdicts.reduce((current, verdict) => expectValue(recordVerdict(current, verdict)), candidate);
}

const ALL_BLOCKING_PASS = BLOCKING_PRECHECKS.map((check) => ({ check, outcome: 'pass' as const }));

async function count(table: string, candidateId: string): Promise<number> {
  const { rows } = await database.pool.query(`SELECT count(*)::int AS n FROM ai.${table} WHERE candidate_id = $1`, [candidateId]);
  return rows[0].n as number;
}

describe('the round trip, field by field', () => {
  // Every expectation below is a literal, never the object that was saved:
  // `toEqual(saved)` would pass if the repository dropped a field from both
  // sides of the comparison (ADR-0017).
  it('reads an accepted candidate back with every field it was saved with', async () => {
    const run = await savedRun();
    const proposed = aCandidate(run);
    const checked = withVerdicts(proposed, [
      ...ALL_BLOCKING_PASS,
      { check: 'duplicate_detection', outcome: 'fail', detail: 'near neighbour at 0.91' },
      { check: 'difficulty_plausibility', outcome: 'pass' },
    ]);
    const accepted = expectValue(acceptCandidate(checked));
    expectValue(await candidates.save(accepted));

    const found = expectValue(await candidates.findById(accepted.candidateId));

    expect(found.candidateId).toBe(accepted.candidateId);
    expect(found.state).toBe('accepted');
    expect(found.confidence).toBe(0.85);

    expect(found.pin.runId).toBe(run.pin.runId);
    expect(found.pin.modelVersionId).toBe('00000000-0000-4000-8000-0000000a0003');
    expect(found.pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    expect(Object.keys(found.pin).sort()).toEqual(['modelVersionId', 'promptVersionId', 'runId']);

    expect(found.content.itemType).toBe('SINGLE_CORRECT_MCQ');
    const body = found.content.body as {
      stem: string;
      options: { id: string; text: string }[];
      meta: { difficulty: number; tags: string[]; reviewed: boolean; note: null };
    };
    expect(body.stem).toBe('A block slides down a ramp.');
    expect(body.options).toHaveLength(2);
    expect(body.options[0]?.id).toBe('a');
    expect(body.options[0]?.text).toBe('one');
    expect(body.options[1]?.id).toBe('b');
    expect(body.options[1]?.text).toBe('two');
    expect(body.meta.difficulty).toBe(0.4);
    expect(body.meta.tags).toEqual(['mechanics']);
    expect(body.meta.reviewed).toBe(false);
    expect(body.meta.note).toBeNull();

    expect(found.verdicts).toHaveLength(BLOCKING_PRECHECKS.length + 2);
    BLOCKING_PRECHECKS.forEach((check, index) => {
      expect(found.verdicts[index]?.check).toBe(check);
      expect(found.verdicts[index]?.outcome).toBe('pass');
      expect(Object.hasOwn(found.verdicts[index]!, 'detail')).toBe(false);
    });
    const duplicate = found.verdicts[BLOCKING_PRECHECKS.length];
    expect(duplicate?.check).toBe('duplicate_detection');
    expect(duplicate?.outcome).toBe('fail');
    expect(duplicate?.detail).toBe('near neighbour at 0.91');
    const difficulty = found.verdicts[BLOCKING_PRECHECKS.length + 1];
    expect(difficulty?.check).toBe('difficulty_plausibility');
    expect(Object.hasOwn(difficulty!, 'detail')).toBe(false);

    expect(Object.keys(found).sort()).toEqual(['candidateId', 'confidence', 'content', 'pin', 'state', 'verdicts']);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('reads back a proposed candidate with no verdicts, and a rejected one', async () => {
    const run = await savedRun();
    const proposed = aCandidate(run);
    expectValue(await candidates.save(proposed));
    const foundProposed = expectValue(await candidates.findById(proposed.candidateId));
    expect(foundProposed.state).toBe('proposed');
    expect(foundProposed.verdicts).toHaveLength(0);

    const rejected = expectValue(rejectCandidate(aCandidate(run)));
    expectValue(await candidates.save(rejected));
    expect(expectValue(await candidates.findById(rejected.candidateId)).state).toBe('rejected');
  });

  it('is indifferent to key order in the proposal, which jsonb does not preserve', async () => {
    const run = await savedRun();
    const candidate = aCandidate(run, { body: { zebra: 1, apple: { y: 2, x: [3, { b: 1, a: 2 }] } } });
    expectValue(await candidates.save(candidate));
    const reordered = { ...candidate, content: { ...candidate.content, body: { apple: { x: [3, { a: 2, b: 1 }], y: 2 }, zebra: 1 } } };
    expectValue(await candidates.save(reordered));
  });
});

describe('saving is reconciliation, not overwrite', () => {
  it('adds the verdicts and the decision a stored candidate has gained, and nothing else', async () => {
    const run = await savedRun();
    const proposed = aCandidate(run);
    expectValue(await candidates.save(proposed));

    const partly = withVerdicts(proposed, ALL_BLOCKING_PASS.slice(0, 3));
    expectValue(await candidates.save(partly));
    expect(await count('candidate_verdict', proposed.candidateId)).toBe(3);

    const fully = withVerdicts(partly, ALL_BLOCKING_PASS.slice(3));
    expectValue(await candidates.save(fully));
    expect(await count('candidate_verdict', proposed.candidateId)).toBe(BLOCKING_PRECHECKS.length);
    expect(await count('candidate_decision', proposed.candidateId)).toBe(0);

    expectValue(await candidates.save(expectValue(acceptCandidate(fully))));
    expect(await count('candidate_decision', proposed.candidateId)).toBe(1);
    expect(await count('generation_candidate', proposed.candidateId)).toBe(1);
  });

  it('accepts saving exactly what is stored, writing nothing new', async () => {
    const run = await savedRun();
    const accepted = expectValue(acceptCandidate(withVerdicts(aCandidate(run), ALL_BLOCKING_PASS)));
    expectValue(await candidates.save(accepted));
    expectValue(await candidates.save(accepted));
    expect(await count('candidate_verdict', accepted.candidateId)).toBe(BLOCKING_PRECHECKS.length);
    expect(await count('candidate_decision', accepted.candidateId)).toBe(1);
  });

  describe('a candidate that disagrees with what is stored is a Conflict, and changes nothing', () => {
    async function storedWithVerdicts() {
      const run = await savedRun();
      const candidate = withVerdicts(aCandidate(run), [
        { check: 'schema_validity', outcome: 'pass' },
        { check: 'renderability', outcome: 'fail', detail: 'overflows on mobile' },
      ]);
      expectValue(await candidates.save(candidate));
      return { run, candidate };
    }

    it('when it has a different proposal body', async () => {
      const { candidate } = await storedWithVerdicts();
      const changed = { ...candidate, content: { ...candidate.content, body: { stem: 'rewritten' } } };
      const failure = expectError(await candidates.save(changed));
      expect(failure.kind).toBe('Conflict');
      expect(failure.location).toBe('candidate');
    });

    it('when it carries a different confidence', async () => {
      const { candidate } = await storedWithVerdicts();
      const failure = expectError(await candidates.save({ ...candidate, confidence: 0.1 }));
      expect(failure.kind).toBe('Conflict');
    });

    it('when it has a different item type', async () => {
      const { candidate } = await storedWithVerdicts();
      const failure = expectError(
        await candidates.save({ ...candidate, content: { ...candidate.content, itemType: 'NUMERIC' } }),
      );
      expect(failure.kind).toBe('Conflict');
    });

    it('when it names a different run', async () => {
      const { candidate } = await storedWithVerdicts();
      const other = await savedRun();
      const failure = expectError(await candidates.save({ ...candidate, pin: other.pin }));
      expect(failure.kind).toBe('Conflict');
    });

    it('when it names a different model version or prompt version', async () => {
      const { candidate } = await storedWithVerdicts();
      expect(expectError(await candidates.save({ ...candidate, pin: { ...candidate.pin, modelVersionId: '00000000-0000-4000-8000-0000000a0009' } })).kind).toBe('Conflict');
      expect(expectError(await candidates.save({ ...candidate, pin: { ...candidate.pin, promptVersionId: '00000000-0000-4000-8000-0000000b0009' } })).kind).toBe('Conflict');
    });

    it('when it has lost a verdict the store holds', async () => {
      const { candidate } = await storedWithVerdicts();
      const failure = expectError(await candidates.save({ ...candidate, verdicts: candidate.verdicts.slice(0, 1) }));
      expect(failure.kind).toBe('Conflict');
      expect(failure.location).toBe('verdicts');
      expect(failure.message).toContain('renderability');
    });

    it('when a verdict has changed outcome, detail or place', async () => {
      const { candidate } = await storedWithVerdicts();
      const [first, second] = candidate.verdicts as [PrecheckVerdict, PrecheckVerdict];
      const variants: readonly (readonly PrecheckVerdict[])[] = [
        [first, { ...second, outcome: 'pass' }],
        [first, { ...second, detail: 'fine on mobile' }],
        [first, { check: second.check, outcome: second.outcome }],
        [second, first],
      ];
      for (const verdicts of variants) {
        expect(expectError(await candidates.save({ ...candidate, verdicts })).kind).toBe('Conflict');
      }
    });

    it('when it was already decided the other way, or has lost its decision', async () => {
      const run = await savedRun();
      const accepted = expectValue(acceptCandidate(withVerdicts(aCandidate(run), ALL_BLOCKING_PASS)));
      expectValue(await candidates.save(accepted));

      const flipped = { ...accepted, state: 'rejected' as const };
      const reversed = expectError(await candidates.save(flipped));
      expect(reversed.kind).toBe('Conflict');
      expect(reversed.message).toContain('already accepted');

      const undone = { ...accepted, state: 'proposed' as const };
      expect(expectError(await candidates.save(undone)).kind).toBe('Conflict');

      expect(expectValue(await candidates.findById(accepted.candidateId)).state).toBe('accepted');
      expect(await count('candidate_decision', accepted.candidateId)).toBe(1);
    });

    it('and a refused save writes none of its new verdicts', async () => {
      const { candidate } = await storedWithVerdicts();
      const grown = withVerdicts({ ...candidate, content: { ...candidate.content, body: { stem: 'rewritten' } } }, [
        { check: 'syllabus_scope', outcome: 'pass' },
      ]);
      expectError(await candidates.save(grown));
      expect(await count('candidate_verdict', candidate.candidateId)).toBe(2);
    });
  });

  it('reports two concurrent decisions as a Conflict: one wins, the other is told', async () => {
    const run = await savedRun();
    const checked = withVerdicts(aCandidate(run), ALL_BLOCKING_PASS);
    expectValue(await candidates.save(checked));

    const accepted = expectValue(acceptCandidate(checked));
    const rejected = expectValue(rejectCandidate(checked));
    const results = await Promise.all([candidates.save(accepted), candidates.save(rejected)]);

    const failures = results.filter((result) => !result.ok);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const failure = expectError(failures[0]!);
    expect(failure.kind).toBe('Conflict');
    expect(await count('candidate_decision', checked.candidateId)).toBe(1);
  });
});

describe('what the store refuses', () => {
  it('refuses a candidate whose run was never saved, writing nothing', async () => {
    const orphan = aCandidate(aRun());
    const failure = expectError(await candidates.save(orphan));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('generation_candidate_pin_matches_run');
    expect(await count('generation_candidate', orphan.candidateId)).toBe(0);
  });

  it('refuses a candidate whose pin differs from the run it names', async () => {
    const run = await savedRun();
    const candidate = aCandidate(run);
    const failure = expectError(await candidates.save({ ...candidate, pin: { ...candidate.pin, promptVersionId: '00000000-0000-4000-8000-0000000b0008' } }));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(await count('generation_candidate', candidate.candidateId)).toBe(0);
  });

  it('refuses a confidence the domain would also refuse, writing nothing', async () => {
    const run = await savedRun();
    const candidate = aCandidate(run);
    const failure = expectError(await candidates.save({ ...candidate, confidence: 1.5 }));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('generation_candidate_confidence_in_unit_interval');
    expect(await count('generation_candidate', candidate.candidateId)).toBe(0);
  });

  it('refuses an identifier that is not a UUID', async () => {
    const run = await savedRun();
    const failure = expectError(await candidates.save({ ...aCandidate(run), candidateId: 'cand-1' }));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('events share the candidate’s transaction (§9 rule 4)', () => {
  async function outboxFor(candidateId: string) {
    const { rows } = await database.pool.query(
      `SELECT event_type, aggregate_type, payload, principal_kind, principal_id, correlation_id, schema_version
         FROM platform.outbox_message WHERE aggregate_id = $1 ORDER BY occurred_at, event_type`,
      [candidateId],
    );
    return rows as {
      event_type: string;
      aggregate_type: string;
      payload: { candidateId: string; pin: Record<string, string> };
      principal_kind: string;
      principal_id: string;
      correlation_id: string;
      schema_version: number;
    }[];
  }

  it('writes the event with the decision, carrying identifiers and the pin and nothing of the proposal', async () => {
    const run = await savedRun();
    const accepted = expectValue(acceptCandidate(withVerdicts(aCandidate(run), ALL_BLOCKING_PASS)));
    expectValue(await candidates.save(accepted, [acceptedEvent(accepted)]));

    const [row, ...rest] = await outboxFor(accepted.candidateId);
    expect(rest).toHaveLength(0);
    expect(row?.event_type).toBe('CandidateAccepted');
    expect(row?.aggregate_type).toBe('GenerationCandidate');
    expect(row?.principal_kind).toBe('human');
    expect(row?.principal_id).toBe(PRINCIPAL.id);
    expect(row?.correlation_id).toBe('corr-1');
    expect(row?.schema_version).toBe(1);
    expect(row?.payload.candidateId).toBe(accepted.candidateId);
    expect(row?.payload.pin['runId']).toBe(run.pin.runId);
    expect(row?.payload.pin['modelVersionId']).toBe('00000000-0000-4000-8000-0000000a0003');
    expect(row?.payload.pin['promptVersionId']).toBe('00000000-0000-4000-8000-0000000b0007');
    expect(Object.keys(row!.payload).sort()).toEqual(['candidateId', 'contentItemId', 'pin']);
    expect((row!.payload as { contentItemId?: string }).contentItemId).toBeTypeOf('string');
  });

  it('writes a rejection’s event too', async () => {
    const run = await savedRun();
    const rejected = expectValue(rejectCandidate(aCandidate(run)));
    expectValue(await candidates.save(rejected, [rejectedEvent(rejected)]));
    const rows = await outboxFor(rejected.candidateId);
    expect(rows.map((row) => row.event_type)).toEqual(['CandidateRejected']);
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(['candidateId', 'pin']);
  });

  it('writes no event when the save is refused', async () => {
    const run = await savedRun();
    const stored = aCandidate(run);
    expectValue(await candidates.save(stored));
    const changed = { ...stored, content: { ...stored.content, body: { stem: 'rewritten' } } };
    expectError(await candidates.save(changed, [acceptedEvent(stored)]));
    expect(await outboxFor(stored.candidateId)).toEqual([]);
  });

  it('rolls the candidate back when its event cannot be written', async () => {
    const run = await savedRun();
    const candidate = aCandidate(run);
    const failure = expectError(
      await candidates.save(candidate, [acceptedEvent(candidate, { principal: { kind: 'human', id: 'not-a-uuid' } })]),
    );
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(await count('generation_candidate', candidate.candidateId)).toBe(0);
    expect(await outboxFor(candidate.candidateId)).toEqual([]);
  });
});

describe('finding', () => {
  it('reports a candidate that was never saved as NotFound', async () => {
    const id = randomUUID();
    const failure = expectError(await candidates.findById(id));
    expect(failure.kind).toBe('NotFound');
    expect(failure.message).toContain(id);
  });

  it('reports an identifier the store refuses as PERSISTENCE_REJECTED', async () => {
    expect(expectError(await candidates.findById('not-a-uuid')).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await candidates.findByRun('not-a-uuid')).code).toBe('PERSISTENCE_REJECTED');
  });

  it('finds every candidate one run produced, oldest first, in every state', async () => {
    const run = await savedRun();
    const first = aCandidate(run);
    const second = expectValue(rejectCandidate(aCandidate(run)));
    const third = expectValue(acceptCandidate(withVerdicts(aCandidate(run), ALL_BLOCKING_PASS)));
    for (const candidate of [first, second, third]) expectValue(await candidates.save(candidate));
    expectValue(await candidates.save(aCandidate(await savedRun())));

    const found = expectValue(await candidates.findByRun(run.pin.runId));
    expect(found.map((candidate) => candidate.candidateId)).toEqual([first, second, third].map((c) => c.candidateId));
    expect(found.map((candidate) => candidate.state)).toEqual(['proposed', 'rejected', 'accepted']);
    expect(found[2]?.verdicts).toHaveLength(BLOCKING_PRECHECKS.length);
    expect(found[0]?.verdicts).toHaveLength(0);
  });

  it('finds nothing for a run that produced nothing', async () => {
    expect(expectValue(await candidates.findByRun((await savedRun()).pin.runId))).toEqual([]);
    expect(expectValue(await candidates.findByRun(randomUUID()))).toEqual([]);
  });

  // The question F28 exists to answer.
  it('answers “which candidates did prompt v7 produce?” across runs and states', async () => {
    const tag = randomUUID();
    const early = aCandidate(await savedRun({ promptVersionId: tag }));
    const later = expectValue(rejectCandidate(aCandidate(await savedRun({ promptVersionId: tag, modelVersionId: '00000000-0000-4000-8000-0000000a0004' }))));
    const unrelated = aCandidate(await savedRun({ promptVersionId: randomUUID() }));
    for (const candidate of [early, later, unrelated]) expectValue(await candidates.save(candidate));

    const affected = expectValue(await candidates.findByPromptVersion(tag));
    expect(affected.map((candidate) => candidate.candidateId)).toEqual([early.candidateId, later.candidateId]);
    expect(affected.map((candidate) => candidate.pin.modelVersionId)).toEqual(['00000000-0000-4000-8000-0000000a0003', '00000000-0000-4000-8000-0000000a0004']);
    expect(affected.map((candidate) => candidate.state)).toEqual(['proposed', 'rejected']);
    expect(expectValue(await candidates.findByPromptVersion(randomUUID()))).toEqual([]);
  });
});
