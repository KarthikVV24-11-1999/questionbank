import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as contentComposition from '../../contexts/content/public/composition.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore } from '../../contexts/content/application/ports.js';
import type { Item } from '../../contexts/content/domain/item.js';
import { addAnchorPoolMember } from '../../contexts/assessment/domain/anchor-pool.js';
import { assembleForm, violatedConstraints } from '../../contexts/assessment/domain/assembly.js';
import { createBlueprint } from '../../contexts/assessment/domain/blueprint.js';
import { PostgresAnchorPoolRepository } from '../../contexts/assessment/infrastructure/anchor-pool.repository.js';
import { ContentCorpus } from '../../contexts/assessment/infrastructure/content-corpus.js';
import { PostgresExposureLedger } from '../../contexts/assessment/infrastructure/exposure-ledger.repository.js';
import { PUBLISH_NOW, itemContent, publishItem, uuid } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { createMediaStore } from '../persistence/filesystem-media-store.js';

/**
 * Assembly meets content — end to end, against real Postgres and **content's
 * real handlers**, through the seam content offers assessment. Lives in the
 * composition tree because it is the one place both contexts may be named
 * together.
 *
 * What it proves that the unit specs cannot: that the near-duplicates assembly
 * refuses are the ones *content's own detection* finds, with no second
 * definition of "near-duplicate" anywhere in assessment, and that nothing of
 * the answer key travels in what assessment gathers.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const system = { kind: 'system' as const, id: uuid(), roleContext: ['system'] };
const publish = (stem: string): Promise<Item> => publishItem(database.pool, itemContent(stem));

const STEM_A = 'A block slides down a frictionless ramp. What is its acceleration?';

function seam() {
  return contentComposition.contentForAssessment({
    pool: database.pool,
    clock: { now: () => PUBLISH_NOW },
    identifiers: { next: uuid },
    audit: new InMemoryAuditRecorder(),
    principals: { resolve: () => null },
    mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
    idempotency: new InMemoryIdempotencyStore(),
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
  });
}

describe('assembly over content\'s real catalogue and content\'s own duplicate detection', () => {
  it('refuses to put an item and its retyped duplicate in one form, and builds the form that avoids the pair', async () => {
    const a = await publish(STEM_A);
    const b = await publish(STEM_A); // the same item retyped: content calls it an exact match
    const c = await publish('What is the SI unit of capacitance?');
    const d = await publish('State Kirchhoff\'s current law for a junction.');

    const anchors = new PostgresAnchorPoolRepository(database.pool);
    expectValue(await anchors.add(expectValue(addAnchorPoolMember({ itemVersionId: a.versions[0]!.versionId, exposureCap: 10, addedAt: '2026-10-01T00:00:00.000Z' }))));

    const offered = seam();
    const corpus = new ContentCorpus({
      catalogue: offered.listCatalogue as never,
      duplicates: offered.duplicates as never,
      anchors,
      exposure: new PostgresExposureLedger(database.pool),
    });
    const loaded = expectValue(await corpus.load({}, { principal: system, correlationId: 'c' }));

    expect(loaded.unevaluated).toEqual([]);
    expect(loaded.candidates.map((candidate) => candidate.itemId).sort()).toEqual([a, b, c, d].map((item) => item.itemId).sort());
    // content's detection found the pair, from both sides
    const versionOf = (item: Item) => item.versions[0]!.versionId;
    expect(loaded.nearDuplicates.get(versionOf(a))?.has(versionOf(b))).toBe(true);
    expect(loaded.nearDuplicates.get(versionOf(b))?.has(versionOf(a))).toBe(true);
    expect(loaded.nearDuplicates.get(versionOf(c))?.has(versionOf(a))).toBe(false);
    // the anchor is marked from the pool, with its cap
    expect(loaded.candidates.find((candidate) => candidate.itemId === a.itemId)).toMatchObject({ isAnchor: true, anchorExposureCap: 10 });

    // nothing of the key or the solution travelled
    const serialized = JSON.stringify(loaded.candidates);
    for (const leaked of ['correctOptionId', 'isCorrect', 'finalAnswer', 'Resolve the weight', 'Forgot to resolve', 'A block slides']) {
      expect(serialized, leaked).not.toContain(leaked);
    }

    const blueprint = expectValue(
      createBlueprint({
        examProfileVersionId: uuid(),
        formType: 'mock',
        totalMarks: 8,
        difficultyTolerance: 0,
        sections: [{ ordinal: 1, sectionSpecRef: 'physics', itemCount: 2, typeMix: { SINGLE_CORRECT_MCQ: 2 }, marksPerItem: 4, difficultyTarget: { moderate: 2 } }],
      }),
    );
    const request = {
      blueprint,
      candidates: loaded.candidates,
      exposure: loaded.exposure,
      nearDuplicates: loaded.nearDuplicates,
      newSlotId: (section: number, slot: number) => `00000000-0000-4000-b300-${(section * 100 + slot).toString(16).padStart(12, '0')}`,
    };
    const assembled = expectValue(assembleForm(request));
    const picked = assembled.sections[0]!.slots.map((slot) => slot.itemId);
    expect(picked.includes(a.itemId) && picked.includes(b.itemId)).toBe(false);
    expect(violatedConstraints(request, assembled.sections)).toEqual([]);

    // and when the pool has nothing but the pair, it is refused by name
    const onlyThePair = { ...request, candidates: loaded.candidates.filter((candidate) => candidate.itemId === a.itemId || candidate.itemId === b.itemId) };
    expect(expectError(assembleForm(onlyThePair)).constraint).toBe('NEAR_DUPLICATE');
  });

  it('is refused a catalogue to a principal content does not admit', async () => {
    const offered = seam();
    const refused = await offered.listCatalogue.handle({}, { principal: { kind: 'human', id: uuid(), roleContext: ['learner'] }, correlationId: 'c' });
    expect(expectError(refused).kind).toBe('Authorization');
  });
});
