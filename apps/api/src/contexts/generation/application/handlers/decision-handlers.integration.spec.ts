import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateItemDraft, SubmitItemForReview } from '../../../content/public/index.js';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { aCandidate, aRun, registering } from '../../../../testing/generation-fixtures.js';
import { FIXED_NOW, RecordingAudit, contextFor, fixedClock, principalWith } from '../../../../testing/generation-context.js';
import { PostgresGenerationCandidateRepository } from '../../infrastructure/generation-candidate.repository.js';
import { dispositionOf, recordVerdict, type GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository, GenerationRunRepository } from '../../domain/repository-ports.js';
import { BLOCKING_PRECHECKS } from '../../domain/precheck-vocabulary.js';
import { err, ok } from '../../domain/result.js';
import { applicationError, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, ContentAuthoring } from '../ports.js';
import { AcceptCandidateHandler, DisposeCandidateHandler, RejectCandidateHandler } from './decision-handlers.js';

/**
 * Generation's side of acceptance, against real Postgres. Content is a port:
 * the real content handlers are exercised end to end in the composition spec,
 * and here a scripted implementation lets each failure on that side be forced.
 */
let database: TestDatabase;
let runs: GenerationRunRepository;
let candidates: PostgresGenerationCandidateRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  runs = registering(database.pool);
  candidates = new PostgresGenerationCandidateRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const ops = principalWith(['content_ops']);
const machine = principalWith(['generation_pipeline'], 'system');

const PROPOSAL = {
  stem: { blocks: [] },
  responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' },
  taxonomyTags: [],
  difficultyEstimate: 'moderate',
  subject: 'physics',
};

async function stored(options: { checked?: boolean; body?: Record<string, unknown> } = {}): Promise<GenerationCandidate> {
  const run = aRun({ modelVersionId: randomUUID(), promptVersionId: randomUUID() });
  expectValue(await runs.save(run));
  let candidate = aCandidate(run, { body: options.body ?? PROPOSAL, confidence: 0.77 });
  if (options.checked !== false) {
    for (const check of BLOCKING_PRECHECKS) candidate = expectValue(recordVerdict(candidate, { check, outcome: 'pass' }));
  }
  expectValue(await candidates.save(candidate));
  return candidate;
}

interface ScriptedContent extends ContentAuthoring {
  readonly calls: { readonly name: string; readonly command: unknown; readonly context: ApplicationContext }[];
}

function content(script: { create?: ApplicationError; submit?: ApplicationError; itemId?: string } = {}): ScriptedContent {
  const calls: ScriptedContent['calls'] = [];
  const itemId = script.itemId ?? randomUUID();
  return {
    calls,
    async createDraft(command: CreateItemDraft, context) {
      calls.push({ name: 'createDraft', command, context });
      return script.create === undefined ? ok({ itemId }) : err(script.create);
    },
    async submitForReview(command: SubmitItemForReview, context) {
      calls.push({ name: 'submitForReview', command, context });
      return script.submit === undefined ? ok(true as const) : err(script.submit);
    },
  };
}

function accept(authoring: ContentAuthoring, repository: GenerationCandidateRepository = candidates) {
  const audit = new RecordingAudit();
  return { audit, handler: new AcceptCandidateHandler({ candidates: repository, content: authoring, clock: fixedClock, audit }) };
}

async function outbox(candidateId: string) {
  const { rows } = await database.pool.query(
    `SELECT event_type, aggregate_type, payload, principal_kind, principal_id, correlation_id, occurred_at
       FROM platform.outbox_message WHERE aggregate_id = $1 ORDER BY occurred_at`,
    [candidateId],
  );
  return rows as {
    event_type: string;
    aggregate_type: string;
    payload: Record<string, unknown>;
    principal_kind: string;
    principal_id: string;
    correlation_id: string;
    occurred_at: Date;
  }[];
}

describe('AcceptCandidate', () => {
  it('hands content the mapped draft, then submits that draft, under the accepting human’s own context', async () => {
    const candidate = await stored();
    const authoring = content({ itemId: '00000000-0000-4000-8000-0000000000d1' });
    const { handler } = accept(authoring);
    const context = contextFor(ops, 'corr-accept-1');

    const accepted = expectValue(await handler.handle({ candidateId: candidate.candidateId }, context));

    expect(accepted.candidateId).toBe(candidate.candidateId);
    expect(accepted.contentItemId).toBe('00000000-0000-4000-8000-0000000000d1');
    expect(authoring.calls.map((call) => call.name)).toEqual(['createDraft', 'submitForReview']);
    const draft = authoring.calls[0]!.command as CreateItemDraft;
    expect(draft.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(draft.subject).toBe('physics');
    expect(draft.content.provenance.sourceType).toBe('ai_generated');
    expect(draft.content.provenance.modelVersionId).toBe(candidate.pin.modelVersionId);
    expect(draft.content.provenance.promptVersionId).toBe(candidate.pin.promptVersionId);
    expect(draft.content.provenance.generationRunId).toBe(candidate.pin.runId);
    expect(draft.content.provenance.confidence).toBe(0.77);
    expect((authoring.calls[1]!.command as SubmitItemForReview).itemId).toBe('00000000-0000-4000-8000-0000000000d1');
    for (const call of authoring.calls) expect(call.context).toBe(context);
  });

  it('records the decision, the event and the audit entry — and the candidate reads back accepted', async () => {
    const candidate = await stored();
    const itemId = randomUUID();
    const { handler, audit } = accept(content({ itemId }));
    const context = contextFor(ops, 'corr-accept-2');
    expectValue(await handler.handle({ candidateId: candidate.candidateId }, context));

    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('accepted');

    const [row, ...rest] = await outbox(candidate.candidateId);
    expect(rest).toEqual([]);
    expect(row?.event_type).toBe('CandidateAccepted');
    expect(row?.payload['contentItemId']).toBe(itemId);
    expect(row?.principal_id).toBe(ops.id);
    expect(row?.principal_kind).toBe('human');
    expect(row?.correlation_id).toBe('corr-accept-2');
    expect(row?.occurred_at.toISOString()).toBe(FIXED_NOW.toISOString());

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.action).toBe('AcceptCandidate');
    expect(audit.entries[0]?.targetId).toBe(candidate.candidateId);
    expect(audit.entries[0]?.correlationId).toBe('corr-accept-2');
  });

  describe('refuses before content is touched', () => {
    async function refused(candidateId: string, principal = ops, overrides: Partial<ReturnType<typeof accept>> = {}) {
      const authoring = content();
      const { handler, audit } = accept(authoring);
      const result = await (overrides.handler ?? handler).handle({ candidateId }, contextFor(principal));
      expect(authoring.calls).toEqual([]);
      expect(audit.entries).toEqual([]);
      expect(await outbox(candidateId)).toEqual([]);
      return expectError(result);
    }

    it('a principal who is not Content Ops — including the machine that proposed it', async () => {
      const candidate = await stored();
      for (const principal of [machine, principalWith(['author']), principalWith([])]) {
        expect((await refused(candidate.candidateId, principal)).code).toBe('NOT_PERMITTED');
      }
      expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
    });

    it('a candidate that does not exist', async () => {
      expect((await refused(randomUUID())).kind).toBe('NotFound');
    });

    it('a candidate nothing has pre-checked', async () => {
      const candidate = await stored({ checked: false });
      const failure = await refused(candidate.candidateId);
      expect(failure.kind).toBe('PreconditionFailed');
      expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
    });

    it('a candidate that failed a blocking check, naming it', async () => {
      const run = aRun({ modelVersionId: randomUUID(), promptVersionId: randomUUID() });
      expectValue(await runs.save(run));
      let failing = aCandidate(run, { body: PROPOSAL });
      for (const check of BLOCKING_PRECHECKS) {
        failing = expectValue(recordVerdict(failing, { check, outcome: check === 'answer_verification' ? 'fail' : 'pass' }));
      }
      expectValue(await candidates.save(failing));
      const failure = await refused(failing.candidateId);
      expect(failure.code).toBe('CANDIDATE_PRECHECK_FAILED');
      expect(failure.message).toContain('answer_verification');
    });

    it('a candidate whose proposal content cannot author an item, naming the field', async () => {
      const { subject: _subject, ...noSubject } = PROPOSAL;
      const candidate = await stored({ body: noSubject });
      const failure = await refused(candidate.candidateId);
      expect(failure.code).toBe('PROPOSAL_FIELD_MISSING');
      expect(failure.location).toBe('content.body.subject');
    });

    it('a candidate that has already been decided, either way', async () => {
      const candidate = await stored();
      const { handler } = accept(content());
      expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));

      const authoring = content();
      const again = accept(authoring);
      expect(expectError(await again.handler.handle({ candidateId: candidate.candidateId }, contextFor(ops))).code).toBe('TRANSITION_ILLEGAL');
      expect(authoring.calls).toEqual([]);
    });
  });

  describe('when content refuses, the candidate stays proposed and nothing is recorded', () => {
    it('at creating the draft: content’s own error comes back unchanged', async () => {
      const candidate = await stored();
      const contentError = applicationError('Validation', 'STEM_EMPTY', 'the stem is empty', 'stem');
      const authoring = content({ create: contentError });
      const { handler, audit } = accept(authoring);

      const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
      expect(failure).toBe(contentError);
      expect(authoring.calls.map((call) => call.name)).toEqual(['createDraft']);
      expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
      expect(audit.entries).toEqual([]);
      expect(await outbox(candidate.candidateId)).toEqual([]);
    });

    it('at submitting it: the error names the draft left behind (D40)', async () => {
      const candidate = await stored();
      const itemId = randomUUID();
      const authoring = content({ itemId, submit: applicationError('PreconditionFailed', 'NOT_SUBMITTABLE', 'cannot submit') });
      const { handler, audit } = accept(authoring);

      const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
      expect(failure.code).toBe('NOT_SUBMITTABLE');
      expect(failure.detail).toEqual({ contentItemId: itemId });
      expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
      expect(audit.entries).toEqual([]);
      expect(await outbox(candidate.candidateId)).toEqual([]);
    });

    it('when content raises instead of returning: contained, not thrown, and nothing recorded', async () => {
      for (const thrown of [new Error('boom in content'), 'a bare string']) {
        const candidate = await stored();
        const throwing: ContentAuthoring = {
          createDraft: async () => {
            throw thrown;
          },
          submitForReview: async () => ok(true as const),
        };
        const { handler, audit } = accept(throwing);
        const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
        expect(failure.kind).toBe('Unavailable');
        expect(failure.code).toBe('CONTENT_AUTHORING_FAILED');
        expect(failure.message).not.toContain('boom');
        expect((failure.detail as { cause: string }).cause).toBe(thrown instanceof Error ? 'boom in content' : 'a bare string');
        expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
        expect(audit.entries).toEqual([]);
      }
    });

    it('when content raises after the draft exists: contained, and the draft is named', async () => {
      const candidate = await stored();
      const itemId = randomUUID();
      const throwing: ContentAuthoring = {
        createDraft: async () => ok({ itemId }),
        submitForReview: async () => {
          throw new Error('lost the connection');
        },
      };
      const { handler } = accept(throwing);
      const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
      expect(failure.code).toBe('CONTENT_AUTHORING_FAILED');
      expect(failure.detail).toEqual({ contentItemId: itemId });
    });

    it('at recording the decision: the error names the draft left behind (D40)', async () => {
      const candidate = await stored();
      const itemId = randomUUID();
      const refusing: GenerationCandidateRepository = {
        save: () => candidates.save({ ...candidate, confidence: 0.1 }),
        findById: (id) => candidates.findById(id),
        findByRun: (id) => candidates.findByRun(id),
        findByPromptVersion: (id) => candidates.findByPromptVersion(id),
      };
      const { handler, audit } = accept(content({ itemId }), refusing);

      const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
      expect(failure.kind).toBe('Conflict');
      expect(failure.detail).toEqual({ contentItemId: itemId });
      expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
      expect(audit.entries).toEqual([]);
    });
  });
});

describe('RejectCandidate', () => {
  function reject() {
    const audit = new RecordingAudit();
    return { audit, handler: new RejectCandidateHandler({ candidates, content: content(), clock: fixedClock, audit }) };
  }

  it('rejects a proposed candidate whatever its verdicts, recording the event and the audit entry', async () => {
    const candidate = await stored({ checked: false });
    const { handler, audit } = reject();
    const context = contextFor(ops, 'corr-reject-1');

    const rejected = expectValue(await handler.handle({ candidateId: candidate.candidateId }, context));
    expect(rejected.state).toBe('rejected');
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('rejected');

    const [row, ...rest] = await outbox(candidate.candidateId);
    expect(rest).toEqual([]);
    expect(row?.event_type).toBe('CandidateRejected');
    expect(Object.keys(row!.payload).sort()).toEqual(['candidateId', 'pin']);
    expect(row?.principal_id).toBe(ops.id);
    expect(row?.correlation_id).toBe('corr-reject-1');
    expect(audit.entries.map((entry) => entry.action)).toEqual(['RejectCandidate']);
  });

  it('never calls content: a rejected candidate becomes nothing', async () => {
    const candidate = await stored();
    const authoring = content();
    const handler = new RejectCandidateHandler({ candidates, content: authoring, clock: fixedClock, audit: new RecordingAudit() });
    expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    expect(authoring.calls).toEqual([]);
  });

  it('refuses everyone but Content Ops, a missing candidate, and one already decided', async () => {
    const candidate = await stored();
    const { handler, audit } = reject();
    for (const principal of [machine, principalWith(['reviewer'])]) {
      expect(expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(principal))).code).toBe('NOT_PERMITTED');
    }
    expect(expectError(await handler.handle({ candidateId: randomUUID() }, contextFor(ops))).kind).toBe('NotFound');
    expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    expect(expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops))).code).toBe('TRANSITION_ILLEGAL');
    expect(audit.entries).toHaveLength(1);
  });

  it('refuses to reject what was accepted', async () => {
    const candidate = await stored();
    expectValue(await accept(content()).handler.handle({ candidateId: candidate.candidateId }, contextFor(ops)));
    const { handler } = reject();
    expect(expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops))).code).toBe('TRANSITION_ILLEGAL');
    expect((await outbox(candidate.candidateId)).map((row) => row.event_type)).toEqual(['CandidateAccepted']);
  });

  it('surfaces a failed save without auditing it', async () => {
    const candidate = await stored();
    const refusing: GenerationCandidateRepository = {
      save: () => candidates.save({ ...candidate, confidence: 0.1 }),
      findById: (id) => candidates.findById(id),
      findByRun: (id) => candidates.findByRun(id),
      findByPromptVersion: (id) => candidates.findByPromptVersion(id),
    };
    const audit = new RecordingAudit();
    const handler = new RejectCandidateHandler({ candidates: refusing, content: content(), clock: fixedClock, audit });
    expect(expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(ops))).kind).toBe('Conflict');
    expect(audit.entries).toEqual([]);
  });
});

/** Verdicts for every blocking check, with `failing` ones failed; `omitted` ones not recorded at all. */
async function checked(options: { failing?: readonly string[]; omitted?: readonly string[] } = {}): Promise<GenerationCandidate> {
  const run = aRun({ modelVersionId: randomUUID(), promptVersionId: randomUUID() });
  expectValue(await runs.save(run));
  let candidate = aCandidate(run, { body: PROPOSAL, confidence: 0.77 });
  for (const check of BLOCKING_PRECHECKS) {
    if (options.omitted?.includes(check)) continue;
    candidate = expectValue(recordVerdict(candidate, { check, outcome: options.failing?.includes(check) ? 'fail' : 'pass' }));
  }
  expectValue(await candidates.save(candidate));
  return candidate;
}

function dispose(authoring: ContentAuthoring) {
  const audit = new RecordingAudit();
  return { audit, handler: new DisposeCandidateHandler({ candidates, content: authoring, clock: fixedClock, audit }) };
}

describe('dispositionOf — the battery’s result, read once (ADR-0029)', () => {
  it('accepts when every blocking check passed, whatever an advisory check said', async () => {
    expect(dispositionOf(await checked())).toBe('accept');
  });

  it('rejects when any one blocking check failed, for every blocking check', async () => {
    for (const blocking of BLOCKING_PRECHECKS) expect(dispositionOf(await checked({ failing: [blocking] })), blocking).toBe('reject');
  });

  it('decides nothing while a blocking check has no verdict: a check that did not run is not a pass', async () => {
    for (const blocking of BLOCKING_PRECHECKS) expect(dispositionOf(await checked({ omitted: [blocking] })), blocking).toBe('undecided');
  });

  it('still rejects a candidate that failed one check while another has not run: the failure already settles it', async () => {
    const [first, second] = BLOCKING_PRECHECKS;
    expect(dispositionOf(await checked({ failing: [first!], omitted: [second!] }))).toBe('reject');
  });

  it('has nothing to decide for a candidate that is no longer proposed', async () => {
    const candidate = await checked();
    expect(dispositionOf({ ...candidate, state: 'accepted' })).toBe('undecided');
    expect(dispositionOf({ ...candidate, state: 'rejected' })).toBe('undecided');
  });
});

describe('DisposeCandidate', () => {
  it('accepts a candidate whose blocking checks all passed, creating and submitting a draft under the pipeline’s own context', async () => {
    const candidate = await checked();
    const authoring = content({ itemId: '00000000-0000-4000-8000-0000000000e1' });
    const { handler, audit } = dispose(authoring);
    const context = contextFor(machine, 'corr-dispose-1');

    const disposed = expectValue(await handler.handle({ candidateId: candidate.candidateId }, context));

    expect(disposed).toEqual({ candidateId: candidate.candidateId, disposition: 'accept', contentItemId: '00000000-0000-4000-8000-0000000000e1' });
    expect(authoring.calls.map((call) => call.name)).toEqual(['createDraft', 'submitForReview']);
    expect(authoring.calls.every((call) => call.context === context)).toBe(true);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('accepted');
    expect(audit.entries.map((entry) => entry.action)).toEqual(['DisposeCandidate']);
    expect((await outbox(candidate.candidateId)).map((row) => row.event_type)).toEqual(['CandidateAccepted']);
  });

  it('rejects a candidate that failed a blocking check, terminally, and never touches content', async () => {
    const candidate = await checked({ failing: [BLOCKING_PRECHECKS[2]!] });
    const authoring = content();
    const { handler } = dispose(authoring);

    const disposed = expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(disposed).toEqual({ candidateId: candidate.candidateId, disposition: 'reject' });
    expect(authoring.calls).toEqual([]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('rejected');
    expect((await outbox(candidate.candidateId)).map((row) => row.event_type)).toEqual(['CandidateRejected']);
  });

  it('does nothing for a candidate a blocking check has not run for: no draft, no rejection, still proposed', async () => {
    const candidate = await checked({ omitted: [BLOCKING_PRECHECKS[0]!] });
    const authoring = content();
    const { handler, audit } = dispose(authoring);

    const disposed = expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));

    expect(disposed).toEqual({ candidateId: candidate.candidateId, disposition: 'undecided' });
    expect(authoring.calls).toEqual([]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
    expect(audit.entries).toEqual([]);
    expect(await outbox(candidate.candidateId)).toEqual([]);
  });

  it('is the pipeline’s alone: Content Ops uses the override, and nobody else may dispose', async () => {
    const candidate = await checked();
    const authoring = content();
    for (const roles of [['content_ops'], ['author'], ['reviewer'], []]) {
      const refused = expectError(await dispose(authoring).handler.handle({ candidateId: candidate.candidateId }, contextFor(principalWith(roles))));
      expect(refused.code, roles.join()).toBe('NOT_PERMITTED');
    }
    expect(authoring.calls).toEqual([]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });

  it('cannot be turned into a way to dispose of a decided candidate: the second call is a no-op, not a second draft', async () => {
    const candidate = await checked();
    const authoring = content();
    const { handler } = dispose(authoring);
    expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    const again = expectValue(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(again.disposition).toBe('undecided');
    expect(authoring.calls.map((call) => call.name)).toEqual(['createDraft', 'submitForReview']);
  });

  it('names the draft it left behind when recording the acceptance fails after content took it (D40)', async () => {
    const candidate = await checked();
    const failingSave: GenerationCandidateRepository = {
      ...candidates,
      findById: (id: string) => candidates.findById(id),
      save: async () => err({ code: 'PERSISTENCE_REJECTED', message: 'store down' } as never),
    } as unknown as GenerationCandidateRepository;
    const authoring = content({ itemId: '00000000-0000-4000-8000-0000000000e2' });
    const audit = new RecordingAudit();
    const handler = new DisposeCandidateHandler({ candidates: failingSave, content: authoring, clock: fixedClock, audit });

    const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(failure.detail).toMatchObject({ contentItemId: '00000000-0000-4000-8000-0000000000e2' });
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });

  it('reports a candidate that does not exist as NotFound', async () => {
    const failure = expectError(await dispose(content()).handler.handle({ candidateId: randomUUID() }, contextFor(machine)));
    expect(failure.kind).toBe('NotFound');
  });

  it('surfaces content’s refusal as it is, leaving the candidate proposed', async () => {
    const candidate = await checked();
    const refusing = content({ create: applicationError('Authorization', 'OUT_OF_SUBJECT_SCOPE', 'not scoped to physics') });
    const failure = expectError(await dispose(refusing).handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(failure.code).toBe('OUT_OF_SUBJECT_SCOPE');
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });

  it('surfaces a failed rejection as it is: the candidate stays proposed, and nothing is recorded', async () => {
    const candidate = await checked({ failing: [BLOCKING_PRECHECKS[0]!] });
    const failingSave = {
      findById: (id: string) => candidates.findById(id),
      save: async () => err({ code: 'PERSISTENCE_REJECTED', message: 'store down' } as never),
    } as unknown as GenerationCandidateRepository;
    const audit = new RecordingAudit();
    const handler = new DisposeCandidateHandler({ candidates: failingSave, content: content(), clock: fixedClock, audit });

    const failure = expectError(await handler.handle({ candidateId: candidate.candidateId }, contextFor(machine)));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(audit.entries).toEqual([]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });
});
