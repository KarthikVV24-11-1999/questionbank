import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  AUTHOR,
  AUTHORED_AT,
  itemVersionProps,
  mathBody,
  PROVENANCE_CONTEXT,
  textBody,
} from '../../../testing/content-fixtures.js';
import { createContentBody } from '../domain/content-body.js';
import { createItemVersion } from '../domain/item-version.js';
import { createItem, publishVersion, transitionItem, type Item } from '../domain/item.js';
import {
  addSolutionVersion,
  createSolution,
  createSolutionVersion,
  transitionSolution,
  type CreateSolutionVersionProps,
  type FinalAnswerAssertion,
  type Solution,
  type SolutionVersion,
} from '../domain/solution.js';
import { PostgresItemRepository } from './item.repository.js';
import { PostgresSolutionRepository } from './solution.repository.js';

let database: TestDatabase;
let repository: PostgresSolutionRepository;
let items: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresSolutionRepository(database.pool);
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-a000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();
const DB_AUTHOR = { ...AUTHOR, id: AUTHOR_ID };

/** A saved item whose version a solution can target. */
async function seedItem(): Promise<Item> {
  const itemVersion = expectValue(
    createItemVersion(
      itemVersionProps({
        versionId: freshUuid(),
        authoredBy: DB_AUTHOR,
        taxonomyTags: [
          { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
        ],
      }),
      PROVENANCE_CONTEXT,
    ),
  );
  const item = expectValue(
    createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: itemVersion }),
  );
  expectValue(await items.save(item));
  return item;
}

function versionProps(overrides: Partial<CreateSolutionVersionProps> = {}): CreateSolutionVersionProps {
  return {
    versionId: freshUuid(),
    versionNo: 1,
    finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
    steps: [
      { ordinal: 1, body: textBody('Resolve the forces along the ramp.'), conceptRefs: [CONCEPT_ID] },
      { ordinal: 2, body: mathBody('a = g\\sin\\theta', 'a equals g sine theta'), conceptRefs: [] },
    ],
    authoredBy: DB_AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}

function version(overrides: Partial<CreateSolutionVersionProps> = {}): SolutionVersion {
  return expectValue(createSolutionVersion(versionProps(overrides)));
}

async function draftSolution(overrides: Partial<CreateSolutionVersionProps> = {}): Promise<Solution> {
  const item = await seedItem();
  return expectValue(
    createSolution({
      solutionId: freshUuid(),
      itemId: item.itemId,
      targetItemVersionId: item.versions[0]!.versionId,
      initialVersion: version(overrides),
    }),
  );
}

async function publishSolution(solution: Solution): Promise<Solution> {
  const approved = expectValue(
    transitionSolution(
      expectValue(transitionSolution(solution, { transition: 'submit_for_review' })),
      { transition: 'approve' },
    ),
  );
  const published = expectValue(
    transitionSolution(approved, { transition: 'publish', versionId: solution.versions[0]!.versionId }),
  );
  expectValue(await repository.save(published));
  return published;
}

describe('save and load round trip', () => {
  it('reconstitutes an identical aggregate', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded).toMatchObject({
      solutionId: solution.solutionId,
      itemId: solution.itemId,
      targetItemVersionId: solution.targetItemVersionId,
      lifecycleState: 'draft',
    });
    expect(loaded.versions).toHaveLength(1);
  });

  it('round trips the steps in order, with their concept references', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    const steps = loaded.versions[0]!.steps;
    expect(steps.map((step) => step.ordinal)).toEqual([1, 2]);
    expect(steps[0]!.conceptRefs).toEqual([CONCEPT_ID]);
    expect(steps[1]!.body.blocks[0]).toMatchObject({ kind: 'MATH_BLOCK' });
  });

  // Never insertion order, never whatever the database returns.
  it('returns the steps in ordinal order even when stored out of order', async () => {
    const solution = await draftSolution({
      steps: [
        { ordinal: 2, body: textBody('second'), conceptRefs: [] },
        { ordinal: 1, body: textBody('first'), conceptRefs: [] },
      ],
    });
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded.versions[0]!.steps.map((step) => step.ordinal)).toEqual([1, 2]);
  });

  it('round trips distractor analyses', async () => {
    const solution = await draftSolution({
      distractorAnalyses: [
        { optionId: 'a', misconception: textBody('confuses mass with weight') },
        { optionId: 'c', misconception: textBody('drops the factor of two') },
      ],
    });
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded.versions[0]!.distractorAnalyses.map((entry) => entry.optionId)).toEqual(['a', 'c']);
  });

  it('round trips alternate approaches, with and without an applicability note', async () => {
    const solution = await draftSolution({
      alternateApproaches: [
        {
          label: 'by energy conservation',
          steps: [{ ordinal: 1, body: textBody('equate the energies'), conceptRefs: [CONCEPT_ID] }],
          applicabilityNote: 'when friction is absent',
        },
        {
          label: 'by symmetry',
          steps: [{ ordinal: 1, body: textBody('note the symmetry'), conceptRefs: [] }],
        },
      ],
    });
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    const approaches = loaded.versions[0]!.alternateApproaches;
    expect(approaches.map((entry) => entry.label)).toEqual(['by energy conservation', 'by symmetry']);
    expect(approaches[0]!.applicabilityNote).toBe('when friction is absent');
    expect(Object.hasOwn(approaches[1]!, 'applicabilityNote')).toBe(false);
    expect(approaches[0]!.steps[0]!.conceptRefs).toEqual([CONCEPT_ID]);
  });

  it('defaults to no analyses and no approaches', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded.versions[0]!.distractorAnalyses).toEqual([]);
    expect(loaded.versions[0]!.alternateApproaches).toEqual([]);
  });

  it('reports NotFound for a solution that does not exist', async () => {
    expect(expectError(await repository.findById(freshUuid())).code).toBe('NOT_FOUND');
  });
});

describe('the final answer survives storage', () => {
  it.each([
    ['an option', { kind: 'OPTION', optionId: 'b' }],
    ['an option set', { kind: 'OPTION_SET', optionIds: ['a', 'c'] }],
    ['a pairing', { kind: 'PAIRS', pairs: [{ left: 'l1', right: 'r2' }] }],
    ['a numeric value with a unit', { kind: 'NUMERIC', value: '9.81', unit: 'm/s^2' }],
  ] as const)('round trips %s', async (_label, finalAnswerAssertion) => {
    const solution = await draftSolution({ finalAnswerAssertion });
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded.versions[0]!.finalAnswerAssertion).toEqual(finalAnswerAssertion);
  });

  // M3-14 compares this through the item's own NumericAnswerSpec, so a float
  // would decide agreement on a value nobody wrote.
  it('keeps a numeric assertion as the authored literal, trailing zeros and all', async () => {
    const solution = await draftSolution({
      finalAnswerAssertion: { kind: 'NUMERIC', value: '9.8100' },
    });
    expectValue(await repository.save(solution));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    const assertion = loaded.versions[0]!.finalAnswerAssertion;
    expect(assertion.kind === 'NUMERIC' ? assertion.value : null).toBe('9.8100');
  });

  it('records the assertion kind alongside the document, for querying', async () => {
    const solution = await draftSolution({ finalAnswerAssertion: { kind: 'NUMERIC', value: '4' } });
    expectValue(await repository.save(solution));

    const stored = await database.pool.query<{ final_answer_kind: string }>(
      `SELECT final_answer_kind FROM content.solution_version WHERE solution_id = $1`,
      [solution.solutionId],
    );
    expect(stored.rows[0]!.final_answer_kind).toBe('NUMERIC');
  });
});

describe('a solution targets a version, and the lookup is keyed on one (D5)', () => {
  it('finds the published solution for its target item version', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));
    await publishSolution(solution);

    const found = expectValue(await repository.findPublishedForItemVersion(solution.targetItemVersionId));
    expect(found.versionId).toBe(solution.versions[0]!.versionId);
  });

  it('reports NotFound while the solution is only a draft', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));

    expect(expectError(await repository.findPublishedForItemVersion(solution.targetItemVersionId)).code).toBe(
      'NOT_FOUND',
    );
  });

  // A solution written for version 1 says nothing about version 2, whose key
  // may differ — which is why M3-11 keys the precondition on the version.
  it('does not answer for a different version of the same item', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));
    await publishSolution(solution);

    expect(expectError(await repository.findPublishedForItemVersion(freshUuid())).code).toBe('NOT_FOUND');
  });

  it('reports NotFound for an item version nothing targets', async () => {
    expect(expectError(await repository.findPublishedForItemVersion(freshUuid())).code).toBe('NOT_FOUND');
  });
});

describe('publication arms the immutability trigger', () => {
  it('stamps published_at and refuses a later edit to the explanation', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));
    await publishSolution(solution);

    const stored = await database.pool.query<{ published_at: Date | null }>(
      `SELECT published_at FROM content.solution_version WHERE solution_version_id = $1`,
      [solution.versions[0]!.versionId],
    );
    expect(stored.rows[0]!.published_at).not.toBeNull();

    await expect(
      database.pool.query(
        `UPDATE content.solution_step SET body_plain_text = 'tampered' WHERE solution_version_id = $1`,
        [solution.versions[0]!.versionId],
      ),
    ).rejects.toThrow(/content_published_version_is_immutable/u);
  });

  it('leaves a draft solution editable', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));

    await database.pool.query(
      `UPDATE content.solution_step SET body_plain_text = 'revised' WHERE solution_version_id = $1`,
      [solution.versions[0]!.versionId],
    );
    const stored = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.solution_step
        WHERE solution_version_id = $1 AND body_plain_text = 'revised'`,
      [solution.versions[0]!.versionId],
    );
    expect(Number(stored.rows[0]!.count)).toBe(2);
  });
});

describe('correcting an explanation is cheap (D5)', () => {
  it('adds a version and keeps the earlier one', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));
    const published = await publishSolution(solution);

    const second = version({
      versionId: freshUuid(),
      versionNo: 2,
      steps: [{ ordinal: 1, body: textBody('a clearer derivation'), conceptRefs: [] }],
    });
    expectValue(await repository.save(expectValue(addSolutionVersion(published, second))));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded.versions.map((entry) => entry.versionNo)).toEqual([1, 2]);
  });

  // The target never moves, which is what keeps historical attempts
  // interpretable while the prose improves.
  it('leaves the target item version unchanged across a correction', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));
    const published = await publishSolution(solution);

    const second = version({ versionId: freshUuid(), versionNo: 2 });
    expectValue(await repository.save(expectValue(addSolutionVersion(published, second))));

    const loaded = expectValue(await repository.findById(solution.solutionId));
    expect(loaded.targetItemVersionId).toBe(solution.targetItemVersionId);
  });
});

describe('media referenced by an explanation joins the usage graph', () => {
  it('writes an edge for an asset a step references', async () => {
    const assetId = freshUuid();
    const assetVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.media_asset (asset_id, asset_type) VALUES ($1, 'diagram')`,
      [assetId],
    );
    await database.pool.query(
      `INSERT INTO content.media_asset_version
         (asset_version_id, asset_id, version_no, storage_key, checksum, mime_type, width, height,
          alt_text, long_description, authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'k', 'c', 'image/png', 10, 10, 'a free-body diagram',
               'forces on the block', 'human', $3)`,
      [assetVersionId, assetId, AUTHOR_ID],
    );

    const body = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'HALF_WIDTH' }]),
    );
    const solution = await draftSolution({ steps: [{ ordinal: 1, body, conceptRefs: [] }] });
    expectValue(await repository.save(solution));

    const edges = await database.pool.query<{ media_asset_version_id: string }>(
      `SELECT media_asset_version_id FROM content.content_media_ref
        WHERE owner_type = 'solution_version' AND owner_version_id = $1`,
      [solution.versions[0]!.versionId],
    );
    expect(edges.rows.map((row) => row.media_asset_version_id)).toEqual([assetVersionId]);
  });
});

describe('optimistic concurrency and failure reporting', () => {
  it('rejects a stale write as a Conflict', async () => {
    const solution = await draftSolution();
    expectValue(await repository.save(solution));
    expectValue(
      await repository.save(expectValue(transitionSolution(solution, { transition: 'submit_for_review' }))),
    );

    const failure = expectError(
      await repository.save(expectValue(transitionSolution(solution, { transition: 'submit_for_review' }))),
    );
    expect(failure.code).toBe('CONFLICT');
  });

  it('rolls back the whole save when the database refuses a part', async () => {
    const solution = await draftSolution();
    const broken = {
      ...solution,
      versions: [
        {
          ...solution.versions[0]!,
          finalAnswerAssertion: { kind: 'FREE_TEXT' } as unknown as FinalAnswerAssertion,
        },
      ],
    } as Solution;

    expect(expectError(await repository.save(broken)).code).toBe('PERSISTENCE_REJECTED');
    const rows = await database.pool.query(`SELECT 1 FROM content.solution WHERE solution_id = $1`, [
      solution.solutionId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('reports a stored solution that cannot reconstitute', async () => {
    const item = await seedItem();
    const solutionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.solution (solution_id, item_id, target_item_version_id)
       VALUES ($1, $2, $3)`,
      [solutionId, item.itemId, item.versions[0]!.versionId],
    );
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.solution_version
           (solution_version_id, solution_id, version_no, final_answer_kind, final_answer,
            authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, 'OPTION', '{"kind":"OPTION","optionId":"a"}'::jsonb, 'human', $4)`,
        [freshUuid(), solutionId, versionNo, AUTHOR_ID],
      );
    }

    const failure = expectError(await repository.findById(solutionId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('contiguously');
  });

  // Reported by reconstitution rather than by a second guard in the lookup:
  // the aggregate refuses a published reference it does not hold, so the
  // repository never has to re-ask.
  it('reports a solution naming a published version it does not hold', async () => {
    const item = await seedItem();
    const solutionId = freshUuid();
    const realVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.solution (solution_id, item_id, target_item_version_id)
       VALUES ($1, $2, $3)`,
      [solutionId, item.itemId, item.versions[0]!.versionId],
    );
    await database.pool.query(
      `INSERT INTO content.solution_version
         (solution_version_id, solution_id, version_no, final_answer_kind, final_answer,
          authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'OPTION', '{"kind":"OPTION","optionId":"a"}'::jsonb, 'human', $3)`,
      [realVersionId, solutionId, AUTHOR_ID],
    );
    // Points the solution at its own version, then publishes — and afterwards
    // rewrites the pointer to a version of a *different* solution, which is
    // the shape of the corruption being reported.
    await database.pool.query(
      `UPDATE content.solution
          SET lifecycle_state = 'published', current_published_version_id = $2
        WHERE solution_id = $1`,
      [solutionId, realVersionId],
    );

    const otherSolutionId = freshUuid();
    const otherVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.solution (solution_id, item_id, target_item_version_id)
       VALUES ($1, $2, $3)`,
      [otherSolutionId, item.itemId, item.versions[0]!.versionId],
    );
    await database.pool.query(
      `INSERT INTO content.solution_version
         (solution_version_id, solution_id, version_no, final_answer_kind, final_answer,
          authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'OPTION', '{"kind":"OPTION","optionId":"a"}'::jsonb, 'human', $3)`,
      [otherVersionId, otherSolutionId, AUTHOR_ID],
    );
    await database.pool.query(
      `UPDATE content.solution SET current_published_version_id = $2 WHERE solution_id = $1`,
      [solutionId, otherVersionId],
    );

    const failure = expectError(await repository.findPublishedForItemVersion(item.versions[0]!.versionId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
  });
});
