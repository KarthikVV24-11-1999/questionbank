import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../../testing/database.js';
import { expectError, expectValue } from '../../../../../testing/expect-result.js';
import { aiProvenance, itemOption, singleCorrectSpec, tags, textBody } from '../../../../../testing/content-fixtures.js';
import type { FingerprintRepository } from '../../../domain/repository-ports.js';
import { transitionItem } from '../../../domain/item.js';
import { PostgresItemRepository } from '../../../infrastructure/item.repository.js';
import { PostgresFingerprintRepository } from '../../../infrastructure/review/fingerprint.repository.js';
import type { AuthoredItemContent } from '../../commands/authoring-commands.js';
import { CreateItemDraftHandler } from '../../handlers/authoring-handlers.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore, type ApplicationContext } from '../../ports.js';
import { RefreshFingerprintsHandler } from '../handlers/fingerprint-handlers.js';
import { GetDuplicateCandidatesForProposalHandler, GetDuplicateCandidatesHandler } from './duplicate-queries.js';

/**
 * **M5-33 — duplicates of content that has not been stored.**
 *
 * The stored side here is real: items made through the draft handler, submitted,
 * and fingerprinted by the real `RefreshFingerprints`. The proposal is compared
 * against what that wrote, so "the same fingerprint functions as the stored
 * path" is a thing the results show and not a thing the code claims.
 */
let database: TestDatabase;
let items: PostgresItemRepository;
let fingerprints: PostgresFingerprintRepository;

const NOW = new Date('2026-10-16T09:30:00.000Z');
const clock = { now: () => NOW };
let uuidSeed = 0;
const identifiers = { next: () => `00000000-0000-4000-9000-${(++uuidSeed).toString(16).padStart(12, '0')}` };

const author: PrincipalRef = { kind: 'human', id: '00000000-0000-4000-9000-0000000000a1', roleContext: ['author', 'subject:physics'] };
const ops: PrincipalRef = { kind: 'human', id: '00000000-0000-4000-9000-0000000000b1', roleContext: ['content_ops'] };
const pipeline: PrincipalRef = { kind: 'system', id: '00000000-0000-4000-9000-0000000000c1', roleContext: ['generation_pipeline'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-proposal-dup' });

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  fingerprints = new PostgresFingerprintRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

/**
 * Options belong to a question's family, not to its exact wording: a retype of a
 * question keeps its options, and two unrelated questions do not share them.
 * (Four identical "option a … option d" lists would make every item look
 * similar to every other.)
 */
const FAMILY_OPTIONS = {
  ramp: ['g sin theta', 'g cos theta', 'g tan theta', 'zero'],
  gas: ['neon', 'argon', 'helium', 'krypton'],
  capital: ['tallinn', 'warsaw', 'oslo', 'prague'],
  pendulum: ['one second', 'two seconds', 'four seconds', 'eight seconds'],
} as const;
type Family = keyof typeof FAMILY_OPTIONS;
const optionsFor = (family: Family) => FAMILY_OPTIONS[family].map((text, index) => itemOption('abcd'[index]!, index + 1, text));

function content(stem: string, family: Family = 'ramp', overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody(stem),
    responseSpec: singleCorrectSpec({ correctOptionId: 'a', options: optionsFor(family) }),
    taxonomyTags: tags({ conceptIdentityId: '00000000-0000-4000-8000-0000000d0001', taxonomyVersionId: '00000000-0000-4000-8000-0000000e0001' }),
    difficultyEstimate: 'moderate',
    provenance: aiProvenance({ modelVersionId: '00000000-0000-4000-8000-0000000a0001', promptVersionId: '00000000-0000-4000-8000-0000000b0001', generationRunId: '00000000-0000-4000-8000-0000000c0001' }),
    licensing: { status: 'owned' },
    ...overrides,
  };
}

/** A real stored item: created by the real handler, submitted for review, and left for `RefreshFingerprints`. */
async function stored(stem: string, family: Family = 'ramp'): Promise<{ itemId: string; itemVersionId: string }> {
  const created = expectValue(
    await new CreateItemDraftHandler({ items, clock, identifiers, audit: new InMemoryAuditRecorder(), idempotency: new InMemoryIdempotencyStore() }).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: content(stem, family), subject: 'physics' },
      as(author),
    ),
  );
  expectValue(await items.save(expectValue(transitionItem(created, { transition: 'submit_for_review' }))));
  return { itemId: created.itemId, itemVersionId: created.versions[0]!.versionId };
}

async function fingerprintTheQueue(): Promise<void> {
  expectValue(await new RefreshFingerprintsHandler({ items, fingerprints }).handle({ since: '2000-01-01T00:00:00.000Z', now: NOW.toISOString() }, as(ops)));
}

const proposalQuery = (stem: string, subject = 'physics', family: Family = 'ramp') => ({ subject, content: content(stem, family) });
const handler = () => new GetDuplicateCandidatesForProposalHandler({ fingerprints, clock });
const ids = (group: readonly { itemVersionId: string }[]) => group.map((candidate) => candidate.itemVersionId).sort();

const ORIGINAL = 'A block of mass 2 kg slides down a frictionless ramp inclined at 30 degrees. Find its acceleration.';

describe('GetDuplicateCandidatesForProposalHandler (M5-33)', () => {
  let original: { itemId: string; itemVersionId: string };
  let unrelated: { itemId: string; itemVersionId: string };

  beforeAll(async () => {
    original = await stored(ORIGINAL);
    unrelated = await stored('Which of the following elements is a noble gas found in the atmosphere in trace amounts?', 'gas');
    await fingerprintTheQueue();
  });

  it('puts a retype of a stored item in the exact group, and nowhere else', async () => {
    const result = expectValue(
      await handler().handle(proposalQuery('a BLOCK of mass 2 kg slides down a frictionless ramp, inclined at 30 degrees: find its acceleration!'), as(pipeline)),
    );
    expect(result.state).toBe('evaluated');
    expect(ids(result.exactMatches)).toEqual([original.itemVersionId]);
    expect(ids(result.skeletonMatches)).toEqual([original.itemVersionId]); // an exact retype shares the skeleton too, as it does on the stored path
    expect(ids(result.trigramMatches)).not.toContain(original.itemVersionId); // already labelled, so not repeated as merely similar
    expect(result.computedAt).toBe(NOW.toISOString());
    expect(result.asOf).toBe(NOW.toISOString());
  });

  it('puts the same question with different constants in the skeleton group, not the exact one', async () => {
    const result = expectValue(
      await handler().handle(proposalQuery('A block of mass 5 kg slides down a frictionless ramp inclined at 45 degrees. Find its acceleration.'), as(pipeline)),
    );
    expect(ids(result.exactMatches)).toEqual([]);
    expect(ids(result.skeletonMatches)).toEqual([original.itemVersionId]);
  });

  it('puts a merely similar item only in the ranked trigram group, with its similarity', async () => {
    const result = expectValue(
      await handler().handle(
        proposalQuery('A block of mass 2 kg slides down a frictionless ramp inclined at 30 degrees. Find the time it takes to reach the bottom.'),
        as(pipeline),
      ),
    );
    expect(ids(result.exactMatches)).toEqual([]);
    expect(ids(result.skeletonMatches)).toEqual([]);
    expect(ids(result.trigramMatches)).toEqual([original.itemVersionId]);
    expect(result.trigramMatches[0]?.similarity).toBeGreaterThan(0.4);
    expect(result.trigramMatches[0]?.similarity).toBeLessThan(1);
  });

  it('finds nothing for a proposal unlike anything stored', async () => {
    const result = expectValue(await handler().handle(proposalQuery('Name the capital city of a country that borders the Baltic Sea.', 'physics', 'capital'), as(pipeline)));
    expect([result.exactMatches, result.skeletonMatches, result.trigramMatches]).toEqual([[], [], []]);
    expect(result.state).toBe('evaluated');
  });

  it('is scoped to a subject, as the stored path is: the same text under another subject matches nothing', async () => {
    const result = expectValue(await handler().handle(proposalQuery(ORIGINAL, 'chemistry'), as(pipeline)));
    expect([result.exactMatches, result.skeletonMatches, result.trigramMatches]).toEqual([[], [], []]);
  });

  // The trigram group is a ranked neighbourhood, retrieval and never a verdict
  // (DEC-M4-2): an unrelated item can appear in it, and what marks it unrelated is
  // how low it ranks. Exact and skeleton membership are the binary claims.
  it('never calls the unrelated item a retype or a constants-swap, and ranks it far below a real neighbour', async () => {
    const result = expectValue(await handler().handle(proposalQuery(ORIGINAL), as(pipeline)));
    expect(ids(result.exactMatches)).not.toContain(unrelated.itemVersionId);
    expect(ids(result.skeletonMatches)).not.toContain(unrelated.itemVersionId);
    const nearest = result.trigramMatches.find((candidate) => candidate.itemVersionId === unrelated.itemVersionId);
    if (nearest !== undefined) expect(nearest.similarity).toBeLessThan(0.3);
  });

  it('writes nothing: a proposal’s fingerprint is computed, compared and discarded', async () => {
    const count = async () => (await database.pool.query('SELECT count(*)::int AS n FROM content.item_fingerprint')).rows[0].n as number;
    const before = await count();
    expectValue(await handler().handle(proposalQuery('A brand new question about pendulums swinging in a vacuum chamber.', 'physics', 'pendulum'), as(pipeline)));
    expect(await count()).toBe(before);
  });

  it('never calls the store’s save, which a proposal has no item to attach to', async () => {
    const saves: unknown[] = [];
    // The real store, answering every read, wrapped only to remember a save.
    const watching: FingerprintRepository = {
      save: async (record) => (saves.push(record), { ok: true, value: true }),
      findByItemVersionId: (id) => fingerprints.findByItemVersionId(id),
      findByExactHash: (subject, hash) => fingerprints.findByExactHash(subject, hash),
      findBySkeletonHash: (subject, hash) => fingerprints.findBySkeletonHash(subject, hash),
      findSimilarCandidates: (subject, text, limit) => fingerprints.findSimilarCandidates(subject, text, limit),
    };
    const observed = new GetDuplicateCandidatesForProposalHandler({ fingerprints: watching, clock });
    expectValue(await observed.handle(proposalQuery(ORIGINAL), as(pipeline)));
    expect(saves).toEqual([]);
  });

  describe('who may ask, and what it refuses', () => {
    it('admits Content Ops and the generation pipeline, and no one else — a reviewer sees the claimed item’s own', async () => {
      expectValue(await handler().handle(proposalQuery(ORIGINAL), as(ops)));
      expectValue(await handler().handle(proposalQuery(ORIGINAL), as(pipeline)));
      for (const roles of [['reviewer'], ['author'], ['learner'], []]) {
        const stranger: PrincipalRef = { kind: 'human', id: identifiers.next(), roleContext: roles };
        expect(expectError(await handler().handle(proposalQuery(ORIGINAL), as(stranger))).code).toBe('NOT_PERMITTED');
      }
    });

    it('refuses a blank or missing subject', async () => {
      for (const subject of ['', '   ', undefined, null, 7]) {
        const failure = expectError(await handler().handle({ subject: subject as never, content: content(ORIGINAL) }, as(pipeline)));
        expect(failure.code).toBe('SUBJECT_REQUIRED');
        expect(failure.location).toBe('subject');
      }
    });

    it('answers a proposal that is not a well-formed item with a value that says where, and never raises', async () => {
      for (const malformed of [
        { ...content(ORIGINAL), responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' } as never },
        { ...content(ORIGINAL), stem: undefined as never },
        null as never,
      ]) {
        const failure = expectError(await handler().handle({ subject: 'physics', content: malformed }, as(pipeline)));
        expect(failure.kind).toBe('Validation');
        expect(failure.code).toBe('PROPOSAL_STRUCTURE_INVALID');
        expect(failure.location).toBeDefined();
      }
    });

    it('returns the store’s own failure when the comparison cannot be made', async () => {
      const broken = new GetDuplicateCandidatesForProposalHandler({
        fingerprints: { ...fingerprints, findByExactHash: async () => ({ ok: false, error: { kind: 'Validation', code: 'PERSISTENCE_REJECTED', message: 'down' } }) } as never,
        clock,
      });
      expect(expectError(await broken.handle(proposalQuery(ORIGINAL), as(pipeline))).code).toBe('PERSISTENCE_REJECTED');
    });
  });
});

// Last, because it stores one more item and the groups above are asserted exactly.
describe('the same fingerprint functions as the stored path (M5-33)', () => {
  it('a stored item’s own content, proposed, finds exactly what its stored query finds — plus itself', async () => {
    const original = await stored('Two blocks of mass 3 kg and 4 kg are joined by a light string over a smooth pulley. Find the tension.', 'pendulum');
    const twin = await stored('TWO BLOCKS OF MASS 3 KG AND 4 KG ARE JOINED BY A LIGHT STRING OVER A SMOOTH PULLEY. FIND THE TENSION.', 'pendulum');
    await fingerprintTheQueue();

    const storedResult = expectValue(await new GetDuplicateCandidatesHandler({ fingerprints, clock }).handle({ itemVersionId: twin.itemVersionId }, as(ops)));
    const proposed = expectValue(
      await handler().handle(proposalQuery('TWO BLOCKS OF MASS 3 KG AND 4 KG ARE JOINED BY A LIGHT STRING OVER A SMOOTH PULLEY. FIND THE TENSION.', 'physics', 'pendulum'), as(pipeline)),
    );

    expect(storedResult.state).toBe('evaluated');
    expect(ids(storedResult.exactMatches)).toEqual([original.itemVersionId]);
    const withoutItself = (group: readonly { itemVersionId: string }[]) => ids(group).filter((id) => id !== twin.itemVersionId);
    expect(withoutItself(proposed.exactMatches)).toEqual(ids(storedResult.exactMatches));
    expect(withoutItself(proposed.skeletonMatches)).toEqual(ids(storedResult.skeletonMatches));
    expect(withoutItself(proposed.trigramMatches)).toEqual(ids(storedResult.trigramMatches));
    expect(ids(proposed.exactMatches)).toContain(twin.itemVersionId);
  });
});
