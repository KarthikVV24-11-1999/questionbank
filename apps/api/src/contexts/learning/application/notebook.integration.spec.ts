import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import type { GaveUpSlot } from '../domain/error-entry.js';
import type { EvidenceOutcome, MasteryEvidence } from '../domain/mastery-evidence.js';
import { PostgresLearningLedger } from '../infrastructure/learning-ledger.js';
import { PostgresMasteryRuleSetRepository } from '../infrastructure/mastery-rule-set.repository.js';
import { PostgresBookmarkStore, PostgresErrorEntryStore } from '../infrastructure/notebook.repository.js';
import { CreateBookmarkHandler, ListBookmarksHandler, SetErrorCauseHandler } from './handlers/notebook-handlers.js';
import { RecordMasteryEvidenceHandler } from './handlers/record-evidence-handler.js';
import type { ItemStanding } from '../domain/bookmark.js';
import type { ItemStandingSource } from './ports.js';
import { ok } from '../domain/result.js';

/**
 * The error notebook and bookmarks against the real store (M7-38): an entry for every wrong response and every give-up, cleared by a verified mastery transition and by
 * nothing else — a correct re-attempt, even a run of them, leaves it open — and a bookmark that follows its item and survives the item's retirement.
 */
let database: TestDatabase;
const system = { principal: { kind: 'system' as const, id: randomUUID(), roleContext: ['system'] }, correlationId: 'c' };
const learnerContext = (id: string) => ({ principal: { kind: 'human' as const, id, roleContext: ['learner'] }, correlationId: 'c' });
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (days: number, minutes = 0) => new Date(t0 + days * DAY + minutes * 60_000).toISOString();
const TAXONOMY = randomUUID();

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});
beforeEach(async () => {
  await database.pool.query('TRUNCATE learning.transition_revocation, learning.evidence_correction, learning.error_entry, learning.bookmark, learning.mastery_transition_evidence, learning.mastery_transition, learning.concept_state, learning.study_session, learning.mastery_evidence');
});

const recorder = (now = at(5)) =>
  new RecordMasteryEvidenceHandler({ ledger: new PostgresLearningLedger(database.pool), ruleSets: new PostgresMasteryRuleSetRepository(database.pool), clock: { now: () => new Date(now) }, identifiers: { next: () => randomUUID() } });

const response = (concept: string, attempt: string, slot: string, outcome: EvidenceOutcome, occurredAt: string): MasteryEvidence => ({
  attemptRef: attempt,
  slotRef: slot,
  itemVersionRef: randomUUID(),
  conceptIdentityId: concept,
  taxonomyVersionId: TAXONOMY,
  outcome,
  difficultyEstimate: 'moderate',
  occurredAt,
  scoredAt: new Date(Date.parse(occurredAt) + 60_000).toISOString(),
});
const gaveUp = (concept: string, attempt: string, slot: string, occurredAt: string): GaveUpSlot => ({ attemptRef: attempt, slotRef: slot, itemVersionRef: randomUUID(), conceptIdentityId: concept, taxonomyVersionId: TAXONOMY, occurredAt });

const history = {
  weak: (concept: string, attempt = randomUUID()) => Array.from({ length: 4 }, (_, i) => response(concept, attempt, `w${i}`, 'incorrect', at(0, i * 5))),
  qualifying: (concept: string) => Array.from({ length: 8 }, (_, i) => response(concept, randomUUID(), `q${i}`, 'correct', i < 4 ? at(1, i * 5) : at(2, i * 5))),
  later: (concept: string, items: number, atHours: number) => Array.from({ length: items }, (_, i) => response(concept, randomUUID(), `v${i}`, 'correct', at(0, atHours * 60 + i * 5))),
};

const entries = async (learner: string) =>
  (await database.pool.query(`SELECT kind, error_cause, resolved_by_transition_id FROM learning.error_entry WHERE learner_ref = $1 ORDER BY occurred_at, slot_ref`, [learner])).rows;
const open = async (learner: string) => (await entries(learner)).filter((row) => row.resolved_by_transition_id === null).length;

describe('an entry for every wrong response and every give-up', () => {
  it('makes one for each incorrect response and none for a correct one, and a replay makes none more', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const attempt = randomUUID();
    const mixed = [response(concept, attempt, 'a', 'incorrect', at(0)), response(concept, attempt, 'b', 'correct', at(0, 5)), response(concept, attempt, 'c', 'incorrect', at(0, 10))];
    expectValue(await recorder().handle({ learnerRef: learner, evidence: mixed }, system));
    expect(await entries(learner)).toEqual([
      { kind: 'incorrect', error_cause: null, resolved_by_transition_id: null },
      { kind: 'incorrect', error_cause: null, resolved_by_transition_id: null },
    ]);
    expectValue(await recorder().handle({ learnerRef: learner, evidence: mixed }, system));
    expect(await entries(learner)).toHaveLength(2);
  });

  it('makes one of its own kind and cause for a give-up, even when the delivery holds nothing else, and moves no mastery state', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const slots = [gaveUp(concept, randomUUID(), 'x', at(0)), gaveUp(concept, randomUUID(), 'y', at(0, 5))];
    const done = expectValue(await recorder().handle({ learnerRef: learner, evidence: [], gaveUp: slots }, system));
    expect(done).toMatchObject({ recorded: 0, maps: [], transitions: [] });
    expect(await entries(learner)).toEqual([
      { kind: 'gave_up', error_cause: 'gave_up', resolved_by_transition_id: null },
      { kind: 'gave_up', error_cause: 'gave_up', resolved_by_transition_id: null },
    ]);
    expectValue(await recorder().handle({ learnerRef: learner, evidence: [], gaveUp: slots }, system));
    expect(await entries(learner)).toHaveLength(2);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM learning.mastery_evidence')).rows[0].n).toBe(0);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM learning.concept_state')).rows[0].n).toBe(0);
  });
});

describe('cleared only on verified mastery', () => {
  it('stays open through a correct re-attempt, through a run of them, and through a qualification that is not yet verified', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await recorder().handle({ learnerRef: learner, evidence: history.weak(concept) }, system));
    expect(await open(learner)).toBe(4);
    // the very question again, right
    expectValue(await recorder().handle({ learnerRef: learner, evidence: [response(concept, randomUUID(), 'again', 'correct', at(0, 60))] }, system));
    expect(await open(learner)).toBe(4);
    // the concept qualifies as strong: recorded at once, and unverified
    const done = expectValue(await recorder().handle({ learnerRef: learner, evidence: history.qualifying(concept) }, system));
    expect(done.transitions).toHaveLength(1);
    expect(done.transitions[0]!.verifiedAt).toBeNull();
    expect(await open(learner)).toBe(4);
  });

  it('clears the concept\'s earlier entries, naming the transition, when the gain is verified — and only that concept\'s', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    const other = randomUUID();
    expectValue(await recorder().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.weak(other)] }, system));
    expectValue(await recorder().handle({ learnerRef: learner, evidence: history.qualifying(concept) }, system));
    const verified = expectValue(await recorder(at(30)).handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 60) }, system));
    expect(verified.verified).toHaveLength(1);

    const rows = (await database.pool.query(`SELECT concept_identity_id, resolved_by_transition_id FROM learning.error_entry WHERE learner_ref = $1`, [learner])).rows;
    expect(rows.filter((r) => r.concept_identity_id === concept).every((r) => r.resolved_by_transition_id === verified.verified[0]!.transitionId)).toBe(true);
    expect(rows.filter((r) => r.concept_identity_id === concept)).toHaveLength(4);
    expect(rows.filter((r) => r.concept_identity_id === other).every((r) => r.resolved_by_transition_id === null)).toBe(true);
  });

  it('leaves a later mistake open: only entries from before the qualification are cleared', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await recorder().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
    // a wrong answer on day 5, after the qualification on day 2 and before the verification
    expectValue(await recorder(at(30)).handle({ learnerRef: learner, evidence: [response(concept, randomUUID(), 'late-miss', 'incorrect', at(5))] }, system));
    expectValue(await recorder(at(30)).handle({ learnerRef: learner, evidence: history.later(concept, 2, 2 * 24 + 60) }, system));
    const stillOpen = (await database.pool.query(`SELECT slot_ref FROM learning.error_entry WHERE learner_ref = $1 AND resolved_by_transition_id IS NULL`, [learner])).rows;
    expect(stillOpen).toEqual([{ slot_ref: 'late-miss' }]);
  });

  describe('is held by the table, so no application path clears an entry any other way', () => {
    const seedVerified = async () => {
      const learner = randomUUID();
      const concept = randomUUID();
      expectValue(await recorder().handle({ learnerRef: learner, evidence: [...history.weak(concept), ...history.qualifying(concept)] }, system));
      const { rows } = await database.pool.query(`SELECT transition_id FROM learning.mastery_transition WHERE learner_ref = $1`, [learner]);
      const entry = (await database.pool.query(`SELECT error_entry_id FROM learning.error_entry WHERE learner_ref = $1 LIMIT 1`, [learner])).rows[0].error_entry_id as string;
      return { learner, concept, transitionId: rows[0].transition_id as string, entry };
    };
    const refused = async (sql: string, params: unknown[]): Promise<string> => {
      try {
        await database.pool.query(sql, params);
      } catch (error) {
        return (error as Error).message;
      }
      return 'accepted';
    };

    it('refuses to clear an entry by a promotion that is not verified', async () => {
      const { transitionId, entry } = await seedVerified();
      expect(await refused('UPDATE learning.error_entry SET resolved_by_transition_id = $1 WHERE error_entry_id = $2', [transitionId, entry])).toMatch(/learning_error_entry_resolves_only_on_verified_mastery/u);
    });

    it('refuses to clear an entry by a transition that is for another learner or another concept', async () => {
      const a = await seedVerified();
      const b = await seedVerified();
      // b's transition is verified here by hand, so that the only thing wrong with it is whose it is
      await database.pool.query('UPDATE learning.mastery_transition SET verified_at = occurred_at WHERE transition_id = $1', [b.transitionId]);
      expect(await refused('UPDATE learning.error_entry SET resolved_by_transition_id = $1 WHERE error_entry_id = $2', [b.transitionId, a.entry])).toMatch(/resolves_only_on_verified_mastery/u);
    });

    it('refuses deletion, a change to anything but the cause and the resolution, and a give-up\'s cause being changed', async () => {
      const { entry, learner } = await seedVerified();
      expect(await refused('DELETE FROM learning.error_entry WHERE error_entry_id = $1', [entry])).toMatch(/learning_error_entry_is_retained/u);
      expect(await refused(`UPDATE learning.error_entry SET kind = 'gave_up' WHERE error_entry_id = $1`, [entry])).toMatch(/only the cause and the resolution may change|error_entry_give_up_has_its_own_cause/u);
      expectValue(await recorder().handle({ learnerRef: learner, evidence: [], gaveUp: [gaveUp(randomUUID(), randomUUID(), 'g', at(0))] }, system));
      const giveUp = (await database.pool.query(`SELECT error_entry_id FROM learning.error_entry WHERE kind = 'gave_up'`)).rows[0].error_entry_id as string;
      expect(await refused(`UPDATE learning.error_entry SET error_cause = 'guess' WHERE error_entry_id = $1`, [giveUp])).toMatch(/learning_error_entry_is_retained|give_up_has_its_own_cause/u);
    });
  });
});

describe('the learner gives a wrong response its cause', () => {
  it('sets one of five on their own entry, refuses a sixth, refuses to relabel a give-up, and cannot see anyone else\'s', async () => {
    const learner = randomUUID();
    const concept = randomUUID();
    expectValue(await recorder().handle({ learnerRef: learner, evidence: [response(concept, randomUUID(), 'a', 'incorrect', at(0))], gaveUp: [gaveUp(concept, randomUUID(), 'g', at(0, 5))] }, system));
    const store = new PostgresErrorEntryStore(database.pool);
    const handler = new SetErrorCauseHandler({ entries: store });
    const wrong = expectValue(await store.list(learner, { openOnly: false })).find((e) => e.kind === 'incorrect')!;
    const gave = expectValue(await store.list(learner, { openOnly: false })).find((e) => e.kind === 'gave_up')!;

    expect(expectValue(await handler.handle({ errorEntryId: wrong.errorEntryId, cause: 'misread' }, learnerContext(learner))).errorCause).toBe('misread');
    expect(expectError(await handler.handle({ errorEntryId: wrong.errorEntryId, cause: 'laziness' }, learnerContext(learner))).code).toBe('ERROR_CAUSE_INVALID');
    expect(expectError(await handler.handle({ errorEntryId: wrong.errorEntryId, cause: 'gave_up' }, learnerContext(learner))).code).toBe('ERROR_CAUSE_INVALID');
    expect(expectError(await handler.handle({ errorEntryId: gave.errorEntryId, cause: 'guess' }, learnerContext(learner))).code).toBe('ERROR_CAUSE_NOT_THE_LEARNERS');
    expect(expectError(await handler.handle({ errorEntryId: wrong.errorEntryId, cause: 'guess' }, learnerContext(randomUUID()))).kind).toBe('NotFound');
    expect(expectError(await handler.handle({ errorEntryId: wrong.errorEntryId, cause: 'guess' }, system)).kind).toBe('Authorization');
  });
});

describe('a bookmark follows its item and survives its retirement', () => {
  const standingFrom = (table: Map<string, ItemStanding>): ItemStandingSource => ({
    standings: async (ids) => ok(ids.flatMap((id) => (table.has(id) ? [table.get(id)!] : []))),
  });

  it('shows the current published version, marks a retired item and keeps showing the last version, and keeps one for an item content does not know', async () => {
    const learner = randomUUID();
    const [published, retired, unknown] = [randomUUID(), randomUUID(), randomUUID()];
    const versions = { v1: randomUUID(), v2: randomUUID(), last: randomUUID() };
    const table = new Map<string, ItemStanding>([
      [published, { itemId: published, state: 'published', itemVersionId: versions.v1 }],
      [retired, { itemId: retired, state: 'retired', itemVersionId: versions.last }],
    ]);
    const bookmarks = new PostgresBookmarkStore(database.pool);
    let minute = 0;
    const create = new CreateBookmarkHandler({ bookmarks, clock: { now: () => new Date(at(0, (minute += 1))) }, identifiers: { next: () => randomUUID() } });
    const list = new ListBookmarksHandler({ bookmarks, standings: standingFrom(table) });
    for (const itemId of [published, retired, unknown]) expectValue(await create.handle({ itemId }, learnerContext(learner)));
    // the same item twice is one bookmark
    expectValue(await create.handle({ itemId: published }, learnerContext(learner)));

    const shown = expectValue(await list.handle({}, learnerContext(learner)));
    expect(shown.map((b) => [b.itemId === published ? 'published' : b.itemId === retired ? 'retired' : 'unknown', b.state, b.itemVersionId])).toEqual([
      ['published', 'published', versions.v1],
      ['retired', 'retired', versions.last],
      ['unknown', 'unknown', null],
    ]);

    // the item is revised: the bookmark shows the new version without being touched
    table.set(published, { itemId: published, state: 'published', itemVersionId: versions.v2 });
    expect(expectValue(await list.handle({}, learnerContext(learner))).find((b) => b.itemId === published)!.itemVersionId).toBe(versions.v2);
    // another learner has none of these
    expect(expectValue(await list.handle({}, learnerContext(randomUUID())))).toEqual([]);
  });

  it('refuses a bookmark that does not name an item, and an update to one', async () => {
    const bookmarks = new PostgresBookmarkStore(database.pool);
    const create = new CreateBookmarkHandler({ bookmarks, clock: { now: () => new Date(at(0)) }, identifiers: { next: () => randomUUID() } });
    expect(expectError(await create.handle({ itemId: 'not-an-id' }, learnerContext(randomUUID()))).code).toBe('BOOKMARK_ITEM_INVALID');
    const made = expectValue(await create.handle({ itemId: randomUUID() }, learnerContext(randomUUID())));
    await expect(database.pool.query('UPDATE learning.bookmark SET item_id = $1 WHERE bookmark_id = $2', [randomUUID(), made.bookmarkId])).rejects.toThrow(/learning_bookmark_is_retained/u);
  });
});
