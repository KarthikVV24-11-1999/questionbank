import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../domain/result.js';
import type { RepositoryError, RescoringOperationRepository, ScoreRecordRepository } from '../domain/repository-ports.js';
import type { ScoreRecord } from '../domain/score-record.js';
import type { RescoringOperation } from '../domain/rescoring-operation.js';
import { createAnswerKey } from '../domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../domain/aggregation-data.js';
import { createScoringInput, type CreateScoredSlot } from '../domain/scoring-input.js';
import { parseRational } from '../domain/numeric/decimal.js';
import { buildDryRunResult } from '../domain/rescoring-dry-run.js';
import { scoreAttempt } from '../domain/score-attempt.js';
import { authorize, policy } from './authorization.js';
import { DuplicateHandlerError, HandlerRegistry, MissingAuthorizationPolicyError, type Handler } from './handler-registry.js';
import { InMemoryAuditRecorder, type Clock, type IdentifierFactory } from './ports.js';
import { ScoreAttemptHandler, type EventPublisher } from './handlers/scoring-handlers.js';
import {
  ApproveRescoringHandler,
  DraftRescoringHandler,
  ExecuteRescoringHandler,
  RunRescoringDryRunHandler,
  type RescoringEventPublisher,
} from './handlers/rescoring-handlers.js';
import { GetRescoringDryRunHandler, GetScoreRecordHandler, ListScoreRecordGenerationsHandler, toScoreRecordView } from './queries/scoring-queries.js';
import { JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

/**
 * The correctness-bearing application surface (ADR-0008): code that determines
 * *what* gets scored or *how*, as opposed to code that merely moves a result
 * around. These are the failure paths that a happy-path integration test never
 * reaches, and where a bug produces a correct score over wrong inputs — which
 * looks right and is therefore worse than a visible crash.
 */

const HASH = 'pinned-hash';
const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const principal = (roles: readonly string[]): PrincipalRef => ({ kind: 'human', id: randomUUID(), roleContext: [...roles] });
const ops = { principal: principal(['ops']), correlationId: 'c' };
const admin = { principal: principal(['admin']), correlationId: 'c', stepUpSatisfied: true };

const slot = (): CreateScoredSlot => ({
  slotId: 'a',
  ordinal: 1,
  itemType: 'SINGLE_CORRECT_MCQ',
  itemVersionId: randomUUID(),
  marksAvailable: 4,
  answerKey: key,
  response: { kind: 'OPTION_SELECTION', optionIds: ['B'] },
});

function input(attemptId: string = randomUUID()) {
  return expectValue(
    createScoringInput({
      attemptId,
      pin: {
        examProfileVersionId: randomUUID(),
        markingRuleSetHash: HASH,
        ruleSchemaVersion: 1,
        taxonomyVersionId: randomUUID(),
        itemVersionIds: [randomUUID()],
      },
      sections: [{ ordinal: 1, slots: [slot()] }],
      overrides: [],
    }),
  );
}

const command = (attemptId?: string) => ({
  input: input(attemptId),
  ruleSet: JEE_MAIN_RULE_SET,
  ruleSetHash: HASH,
  aggregation: DEFAULT_AGGREGATION,
  idempotencyKey: 'k',
});

function record(attemptId: string = randomUUID()): ScoreRecord {
  return expectValue(
    scoreAttempt({
      input: input(attemptId),
      ruleSet: JEE_MAIN_RULE_SET,
      ruleSetHash: HASH,
      aggregation: DEFAULT_AGGREGATION,
      computedAt: '2026-08-07T00:00:00.000Z',
      scoreRecordId: randomUUID(),
    }),
  );
}

const notFound: RepositoryError = { kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' };
const conflict: RepositoryError = { kind: 'Conflict', code: 'CONFLICT', message: 'taken' };

class StubRecords implements ScoreRecordRepository {
  constructor(
    private readonly onFindCurrent: () => Result<ScoreRecord, RepositoryError>,
    private readonly onSave: () => Result<ScoreRecord, RepositoryError> = () => ok(record(randomUUID())),
    private readonly onSupersede: () => Result<ScoreRecord, RepositoryError> = () => ok(record(randomUUID())),
  ) {}
  async save() { return this.onSave(); }
  async supersede() { return this.onSupersede(); }
  async findById() { return this.onFindCurrent(); }
  async findCurrentByAttemptId() { return this.onFindCurrent(); }
  async findAllGenerationsByAttemptId(): Promise<Result<readonly ScoreRecord[], RepositoryError>> {
    const found = this.onFindCurrent();
    return found.ok ? ok([found.value]) : err(found.error);
  }
}

class StubOperations implements RescoringOperationRepository {
  constructor(
    private readonly onFind: () => Result<RescoringOperation, RepositoryError>,
    private readonly onSave: (o: RescoringOperation) => Result<RescoringOperation, RepositoryError> = ok,
  ) {}
  async save(operation: RescoringOperation) { return this.onSave(operation); }
  async findById() { return this.onFind(); }
  async findByState(): Promise<Result<readonly RescoringOperation[], RepositoryError>> { return ok([]); }
}

const clock: Clock = { now: () => new Date('2026-08-07T00:00:00.000Z') };
const identifiers: IdentifierFactory = { next: () => randomUUID() };
const publisher: EventPublisher & RescoringEventPublisher = { async publish() {} };

const deps = (records: ScoreRecordRepository, operations: RescoringOperationRepository) => ({
  records,
  operations,
  clock,
  identifiers,
  audit: new InMemoryAuditRecorder(),
  events: publisher,
});

const drafted = (over: Partial<RescoringOperation> = {}): RescoringOperation => ({
  operationId: randomUUID(),
  trigger: 'CHALLENGE_UPHELD',
  scope: 'ITEM_VERSION',
  scopeRef: 'iv-1',
  reason: 'upheld',
  state: 'drafted',
  ...over,
});

describe('ScoreAttempt fails closed rather than returning a half-result', () => {
  it('surfaces a save rejection instead of reporting success', async () => {
    const handler = new ScoreAttemptHandler(
      deps(new StubRecords(() => err(notFound), () => err(conflict)), new StubOperations(() => err(notFound))),
    );
    expect(expectError(await handler.handle(command(), ops)).code).toBe('CONFLICT');
  });

  it('refuses a rule set the attempt was not pinned to, before touching persistence', async () => {
    const handler = new ScoreAttemptHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => err(notFound))),
    );
    const wrong = { ...command(), ruleSetHash: 'another-hash' };
    expect(expectError(await handler.handle(wrong, ops)).code).toBe('RULE_SET_NOT_PINNED');
  });
});

describe('re-scoring fails closed on every dependency', () => {
  it('refuses a draft the repository will not accept', async () => {
    const handler = new DraftRescoringHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => err(notFound), () => err(conflict))),
    );
    const result = await handler.handle({ trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'iv-1', reason: 'r' }, ops);
    expect(expectError(result).code).toBe('CONFLICT');
  });

  it('refuses a dry run for an operation that does not exist', async () => {
    const handler = new RunRescoringDryRunHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => err(notFound))),
    );
    expect(expectError(await handler.handle({ operationId: randomUUID(), attempts: [] }, ops)).kind).toBe('NotFound');
  });

  it('refuses a dry run over an attempt with no current score', async () => {
    const handler = new RunRescoringDryRunHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => ok(drafted()))),
    );
    const result = await handler.handle({ operationId: randomUUID(), attempts: [command()] }, ops);
    expect(expectError(result).kind).toBe('NotFound');
  });

  it('refuses a dry run whose re-score cannot be computed', async () => {
    const handler = new RunRescoringDryRunHandler(
      deps(new StubRecords(() => ok(record(randomUUID()))), new StubOperations(() => ok(drafted()))),
    );
    const wrong = { ...command(), ruleSetHash: 'another-hash' };
    expect(expectError(await handler.handle({ operationId: randomUUID(), attempts: [wrong] }, ops)).code).toBe(
      'RULE_SET_NOT_PINNED',
    );
  });

  it('refuses a preview the repository will not store', async () => {
    const handler = new RunRescoringDryRunHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => ok(drafted()), () => err(conflict))),
    );
    expect(expectError(await handler.handle({ operationId: randomUUID(), attempts: [] }, ops)).code).toBe('CONFLICT');
  });

  it('refuses approval of an operation that does not exist', async () => {
    const handler = new ApproveRescoringHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => err(notFound))),
    );
    expect(expectError(await handler.handle({ operationId: randomUUID() }, admin)).kind).toBe('NotFound');
  });

  it('refuses approval the repository will not store', async () => {
    const previewed = drafted({ state: 'previewed', dryRunResult: buildDryRunResult([]) });
    const handler = new ApproveRescoringHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => ok(previewed), () => err(conflict))),
    );
    expect(expectError(await handler.handle({ operationId: previewed.operationId }, admin)).code).toBe('CONFLICT');
  });

  it('refuses execution of an operation that does not exist', async () => {
    const handler = new ExecuteRescoringHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => err(notFound))),
    );
    expect(expectError(await handler.handle({ operationId: randomUUID(), attempts: [] }, admin)).kind).toBe('NotFound');
  });

  it('refuses execution the repository will not mark as executing', async () => {
    const approved = drafted({ state: 'approved', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' });
    const handler = new ExecuteRescoringHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => ok(approved), () => err(conflict))),
    );
    expect(expectError(await handler.handle({ operationId: approved.operationId, attempts: [] }, admin)).code).toBe(
      'CONFLICT',
    );
  });

  it('refuses execution whose re-score cannot be computed, before writing any successor', async () => {
    const approved = drafted({ state: 'approved', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' });
    const handler = new ExecuteRescoringHandler(
      deps(new StubRecords(() => ok(record(randomUUID()))), new StubOperations(() => ok(approved))),
    );
    const wrong = { ...command(), ruleSetHash: 'another-hash' };
    expect(expectError(await handler.handle({ operationId: approved.operationId, attempts: [wrong] }, admin)).code).toBe(
      'RULE_SET_NOT_PINNED',
    );
  });

  it('refuses execution when a successor cannot be written', async () => {
    const approved = drafted({ state: 'approved', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' });
    const handler = new ExecuteRescoringHandler(
      deps(
        new StubRecords(() => ok(record(randomUUID())), undefined, () => err(conflict)),
        new StubOperations(() => ok(approved)),
      ),
    );
    expect(expectError(await handler.handle({ operationId: approved.operationId, attempts: [command()] }, admin)).code).toBe(
      'CONFLICT',
    );
  });

  it('throws rather than inventing an operation that vanished mid-execution', async () => {
    const approved = drafted({ state: 'approved', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' });
    let calls = 0;
    const operations = new StubOperations(() => (calls++ === 0 ? ok(approved) : err(notFound)));
    const handler = new ExecuteRescoringHandler(deps(new StubRecords(() => err(notFound)), operations));
    await expect(handler.handle({ operationId: approved.operationId, attempts: [] }, admin)).rejects.toThrow(
      'vanished mid-execution',
    );
  });

  it('denies every rescoring command to a principal without the role', async () => {
    const bench = deps(new StubRecords(() => err(notFound)), new StubOperations(() => err(notFound)));
    const learner = { principal: principal(['learner']), correlationId: 'c' };
    expect(expectError(await new DraftRescoringHandler(bench).handle({ trigger: 'CHALLENGE_UPHELD', scope: 'ITEM_VERSION', scopeRef: 'i', reason: 'r' }, learner)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new RunRescoringDryRunHandler(bench).handle({ operationId: 'x', attempts: [] }, learner)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new ApproveRescoringHandler(bench).handle({ operationId: 'x' }, learner)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new ExecuteRescoringHandler(bench).handle({ operationId: 'x', attempts: [] }, learner)).code).toBe('NOT_PERMITTED');
  });
});

describe('queries fail closed', () => {
  const records = new StubRecords(() => err(notFound));

  it('reports a missing record rather than an empty one', async () => {
    expect(expectError(await new GetScoreRecordHandler(records).handle({ attemptId: 'a', ownerUserId: ops.principal.id }, ops)).kind).toBe('NotFound');
  });

  it('reports a missing generation list rather than an empty one', async () => {
    expect(expectError(await new ListScoreRecordGenerationsHandler(records).handle({ attemptId: 'a', ownerUserId: ops.principal.id }, ops)).kind).toBe('NotFound');
  });

  it('denies a learner without the role at all', async () => {
    const stranger = { principal: principal(['nobody']), correlationId: 'c' };
    expect(expectError(await new GetScoreRecordHandler(records).handle({ attemptId: 'a', ownerUserId: 'x' }, stranger)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new ListScoreRecordGenerationsHandler(records).handle({ attemptId: 'a', ownerUserId: 'x' }, stranger)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new GetRescoringDryRunHandler(new StubOperations(() => err(notFound))).handle({ operationId: 'x' }, stranger)).code).toBe('NOT_PERMITTED');
  });

  it('reports a missing operation rather than an empty preview', async () => {
    expect(expectError(await new GetRescoringDryRunHandler(new StubOperations(() => err(notFound))).handle({ operationId: 'x' }, ops)).kind).toBe('NotFound');
  });

  it('renders a re-scored record with its reason', () => {
    const view = toScoreRecordView({ ...record(randomUUID()), generation: 2, supersedesScoreRecordId: 'x', reasonForRescore: 'upheld' });
    expect(view.reasonForRescore).toBe('upheld');
    expect(view.generation).toBe(2);
  });

  it('omits the reason when there is none', () => {
    expect(toScoreRecordView(record(randomUUID())).reasonForRescore).toBeUndefined();
  });
});

describe('the registry is the F36 gate', () => {
  const stub = (name: string) => ({ name, policy: policy(name, ['ops']), async handle() { return ok(undefined); } });

  it('refuses a handler with an empty role list', () => {
    const roleless = { name: 'Roleless', policy: policy('Roleless', []), async handle() { return ok(undefined); } };
    expect(() => HandlerRegistry.of([roleless as unknown as Handler<never, unknown>])).toThrow(MissingAuthorizationPolicyError);
  });

  it('refuses the same handler twice', () => {
    const handlers = [stub('Twice'), stub('Twice')] as unknown as Handler<never, unknown>[];
    expect(() => HandlerRegistry.of(handlers)).toThrow(DuplicateHandlerError);
  });

  it('returns undefined for a handler nobody registered', () => {
    expect(HandlerRegistry.of([stub('Known') as unknown as Handler<never, unknown>]).get('Unknown')).toBeUndefined();
  });
});

describe('authorization denies by default', () => {
  it('refuses a principal holding no listed role', () => {
    expect(expectError(authorize(policy('P', ['ops']), { principal: principal(['learner']) })).code).toBe('NOT_PERMITTED');
  });

  it('refuses a step-up policy when step-up is absent or false', () => {
    const stepUp = policy('P', ['admin'], true);
    expect(expectError(authorize(stepUp, { principal: principal(['admin']) })).code).toBe('STEP_UP_REQUIRED');
    expect(expectError(authorize(stepUp, { principal: principal(['admin']), stepUpSatisfied: false })).code).toBe('STEP_UP_REQUIRED');
  });

  it('permits a principal holding the role with step-up satisfied', () => {
    expect(expectValue(authorize(policy('P', ['admin'], true), { principal: principal(['admin']), stepUpSatisfied: true }))).toBe(true);
  });
});

describe('the state machine is enforced at the handler too, not only in the domain', () => {
  it('refuses a dry run on an operation past the previewing stage', async () => {
    const completed = drafted({ state: 'completed', dryRunResult: buildDryRunResult([]), authorizedBy: 'p', executedAt: 'then' });
    const handler = new RunRescoringDryRunHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => ok(completed))),
    );
    expect(expectError(await handler.handle({ operationId: completed.operationId, attempts: [] }, ops)).code).toBe(
      'ILLEGAL_TRANSITION',
    );
  });

  it('refuses approval of an operation that was never previewed', async () => {
    const handler = new ApproveRescoringHandler(
      deps(new StubRecords(() => err(notFound)), new StubOperations(() => ok(drafted()))),
    );
    expect(expectError(await handler.handle({ operationId: 'x' }, admin)).code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses to complete an execution the domain will not close', async () => {
    // The operation is re-read before completion. If what comes back is no
    // longer executing, the run must stop rather than force a completion.
    const approved = drafted({ state: 'approved', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' });
    let calls = 0;
    const operations = new StubOperations(() => (calls++ === 0 ? ok(approved) : ok(drafted())));
    const handler = new ExecuteRescoringHandler(deps(new StubRecords(() => err(notFound)), operations));
    expect(expectError(await handler.handle({ operationId: approved.operationId, attempts: [] }, admin)).code).toBe(
      'ILLEGAL_TRANSITION',
    );
  });

  it('refuses a completion the repository will not store', async () => {
    const approved = drafted({ state: 'approved', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' });
    let finds = 0;
    let saves = 0;
    const operations = new StubOperations(
      () => (finds++ === 0 ? ok(approved) : ok(drafted({ state: 'executing', dryRunResult: buildDryRunResult([]), authorizedBy: 'p' }))),
      (o) => (saves++ === 1 ? err(conflict) : ok(o)),
    );
    const handler = new ExecuteRescoringHandler(deps(new StubRecords(() => err(notFound)), operations));
    expect(expectError(await handler.handle({ operationId: approved.operationId, attempts: [] }, admin)).code).toBe(
      'CONFLICT',
    );
  });
});
