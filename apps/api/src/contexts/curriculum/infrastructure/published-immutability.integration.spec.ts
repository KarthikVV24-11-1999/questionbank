import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { conceptNode, examProfileVersion, taxonomyVersion } from './schema.js';

let database: TestDatabase;

async function insertVersion(state: 'draft' | 'published'): Promise<string> {
  const published = state === 'published';
  const result = await database.pool.query<{ taxonomy_version_id: string }>(
    `INSERT INTO curriculum.taxonomy_version
       (exam_family, academic_year, state, published_at, published_by_kind, published_by_id)
     VALUES ('JEE', '2026', $1, $2, $3, $4) RETURNING taxonomy_version_id`,
    published
      ? [state, new Date(), 'human', '00000000-0000-0000-0000-00000000000a']
      : [state, null, null, null],
  );
  return result.rows[0]?.taxonomy_version_id as string;
}

async function insertConcept(versionId: string): Promise<string> {
  const result = await database.pool.query<{ concept_identity_id: string }>(
    `INSERT INTO curriculum.concept_identity (canonical_name, subject_domain, created_in_version)
     VALUES ('Mechanics', 'physics', $1) RETURNING concept_identity_id`,
    [versionId],
  );
  return result.rows[0]?.concept_identity_id as string;
}

async function insertNode(versionId: string, conceptId: string): Promise<string> {
  const result = await database.pool.query<{ concept_node_id: string }>(
    `INSERT INTO curriculum.concept_node
       (taxonomy_version_id, concept_identity_id, display_name, exam_weight, depth, estimated_teaching_hours)
     VALUES ($1, $2, 'Mechanics', 0.2, 0, 10) RETURNING concept_node_id`,
    [versionId, conceptId],
  );
  return result.rows[0]?.concept_node_id as string;
}

async function insertProfile(state: 'draft' | 'published', versionId: string): Promise<string> {
  const examRow = await database.pool.query<{ exam_id: string }>(
    `INSERT INTO curriculum.exam (code, display_name, jurisdiction, conducting_body)
     VALUES ('JEE_MAIN', 'JEE Main', 'IN', 'NTA') RETURNING exam_id`,
  );
  const published = state === 'published';
  const result = await database.pool.query<{ profile_version_id: string }>(
    `INSERT INTO curriculum.exam_profile_version
       (exam_id, academic_year, state, taxonomy_version_id, total_marks, timing_policy, navigation_policy,
        marking_rule_set, marking_rule_set_hash, item_type_allowances, published_at, published_by_kind, published_by_id)
     VALUES ($1, '2026', $2, $3, 300, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, '[]'::jsonb, $5, $6, $7)
     RETURNING profile_version_id`,
    published
      ? [examRow.rows[0]?.exam_id, state, versionId, 'hash', new Date(), 'human', '00000000-0000-0000-0000-00000000000a']
      : [examRow.rows[0]?.exam_id, state, versionId, null, null, null, null],
  );
  return result.rows[0]?.profile_version_id as string;
}

async function rejection(text: string, params: readonly unknown[] = []): Promise<string> {
  try {
    await database.pool.query(text, [...params]);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
});

afterAll(async () => {
  await database.close();
});

describe('taxonomy_version publication immutability', () => {
  it('rejects an update to a published version via raw SQL', async () => {
    const versionId = await insertVersion('published');

    const message = await rejection(
      `UPDATE curriculum.taxonomy_version SET exam_family = 'TAMPERED' WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    expect(message).toMatch(/published_row_is_immutable/u);
  });

  it('rejects an update to a published version via the ORM', async () => {
    const versionId = await insertVersion('published');

    await expect(
      database.db
        .update(taxonomyVersion)
        .set({ examFamily: 'TAMPERED' })
        .where(eq(taxonomyVersion.taxonomyVersionId, versionId)),
    ).rejects.toThrow();

    const after = await database.pool.query<{ exam_family: string }>(
      `SELECT exam_family FROM curriculum.taxonomy_version WHERE taxonomy_version_id = $1`,
      [versionId],
    );
    expect(after.rows[0]?.exam_family).toBe('JEE');
  });

  it('rejects deletion of a published version', async () => {
    const versionId = await insertVersion('published');

    expect(
      await rejection(`DELETE FROM curriculum.taxonomy_version WHERE taxonomy_version_id = $1`, [versionId]),
    ).toMatch(/published_row_is_immutable/u);
  });

  it('permits the published → superseded transition', async () => {
    const versionId = await insertVersion('published');

    await database.pool.query(
      `UPDATE curriculum.taxonomy_version SET state = 'superseded', aggregate_version = aggregate_version + 1
       WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    const after = await database.pool.query<{ state: string }>(
      `SELECT state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = $1`,
      [versionId],
    );
    expect(after.rows[0]?.state).toBe('superseded');
  });

  it('rejects any other transition out of published', async () => {
    const versionId = await insertVersion('published');

    expect(
      await rejection(
        `UPDATE curriculum.taxonomy_version SET state = 'draft' WHERE taxonomy_version_id = $1`,
        [versionId],
      ),
    ).toMatch(/published_row_is_immutable/u);
  });

  it('rejects a superseded → anything transition', async () => {
    const versionId = await insertVersion('published');
    await database.pool.query(
      `UPDATE curriculum.taxonomy_version SET state = 'superseded' WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    expect(
      await rejection(
        `UPDATE curriculum.taxonomy_version SET state = 'published' WHERE taxonomy_version_id = $1`,
        [versionId],
      ),
    ).toMatch(/published_row_is_immutable/u);
  });

  it('rejects supersession that also changes another column', async () => {
    const versionId = await insertVersion('published');

    expect(
      await rejection(
        `UPDATE curriculum.taxonomy_version SET state = 'superseded', academic_year = '2027'
         WHERE taxonomy_version_id = $1`,
        [versionId],
      ),
    ).toMatch(/published_row_is_immutable/u);
  });

  it('leaves draft updates untouched', async () => {
    const versionId = await insertVersion('draft');

    await database.db
      .update(taxonomyVersion)
      .set({ examFamily: 'NEET' })
      .where(eq(taxonomyVersion.taxonomyVersionId, versionId));

    const after = await database.pool.query<{ exam_family: string }>(
      `SELECT exam_family FROM curriculum.taxonomy_version WHERE taxonomy_version_id = $1`,
      [versionId],
    );
    expect(after.rows[0]?.exam_family).toBe('NEET');
  });

  it('permits the draft → published transition', async () => {
    const versionId = await insertVersion('draft');

    await database.pool.query(
      `UPDATE curriculum.taxonomy_version
       SET state = 'published', published_at = now(), published_by_kind = 'human',
           published_by_id = '00000000-0000-0000-0000-00000000000a'
       WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    const after = await database.pool.query<{ state: string }>(
      `SELECT state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = $1`,
      [versionId],
    );
    expect(after.rows[0]?.state).toBe('published');
  });
});

describe('exam_profile_version publication immutability', () => {
  it('rejects an update to a published profile via raw SQL and via the ORM', async () => {
    const versionId = await insertVersion('draft');
    const profileId = await insertProfile('published', versionId);

    expect(
      await rejection(
        `UPDATE curriculum.exam_profile_version SET total_marks = 999 WHERE profile_version_id = $1`,
        [profileId],
      ),
    ).toMatch(/published_row_is_immutable/u);

    await expect(
      database.db
        .update(examProfileVersion)
        .set({ totalMarks: '999' })
        .where(eq(examProfileVersion.profileVersionId, profileId)),
    ).rejects.toThrow();
  });

  it('permits published → superseded, including clearing the active flag', async () => {
    const versionId = await insertVersion('draft');
    const profileId = await insertProfile('published', versionId);
    await database.pool.query(
      `UPDATE curriculum.exam_profile_version SET is_active = true WHERE profile_version_id = $1`,
      [profileId],
    );

    await database.pool.query(
      `UPDATE curriculum.exam_profile_version SET state = 'superseded', is_active = false,
              aggregate_version = aggregate_version + 1
       WHERE profile_version_id = $1`,
      [profileId],
    );

    const after = await database.pool.query<{ state: string }>(
      `SELECT state FROM curriculum.exam_profile_version WHERE profile_version_id = $1`,
      [profileId],
    );
    expect(after.rows[0]?.state).toBe('superseded');
  });

  it('leaves draft profiles editable', async () => {
    const versionId = await insertVersion('draft');
    const profileId = await insertProfile('draft', versionId);

    await database.pool.query(
      `UPDATE curriculum.exam_profile_version SET total_marks = 720 WHERE profile_version_id = $1`,
      [profileId],
    );

    const after = await database.pool.query<{ total_marks: string }>(
      `SELECT total_marks FROM curriculum.exam_profile_version WHERE profile_version_id = $1`,
      [profileId],
    );
    expect(Number(after.rows[0]?.total_marks)).toBe(720);
  });
});

describe('child tables under a published parent', () => {
  it('rejects an update to a concept node of a published version', async () => {
    const versionId = await insertVersion('draft');
    const conceptId = await insertConcept(versionId);
    const nodeId = await insertNode(versionId, conceptId);
    await database.pool.query(
      `UPDATE curriculum.taxonomy_version SET state = 'published', published_at = now(),
              published_by_kind = 'human', published_by_id = '00000000-0000-0000-0000-00000000000a'
       WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    expect(
      await rejection(`UPDATE curriculum.concept_node SET depth = 5 WHERE concept_node_id = $1`, [nodeId]),
    ).toMatch(/published_parent_is_immutable/u);

    await expect(
      database.db.update(conceptNode).set({ depth: 5 }).where(eq(conceptNode.conceptNodeId, nodeId)),
    ).rejects.toThrow();
  });

  it('rejects inserting or deleting a concept node under a published version', async () => {
    const versionId = await insertVersion('draft');
    const conceptId = await insertConcept(versionId);
    const nodeId = await insertNode(versionId, conceptId);
    await database.pool.query(
      `UPDATE curriculum.taxonomy_version SET state = 'published', published_at = now(),
              published_by_kind = 'human', published_by_id = '00000000-0000-0000-0000-00000000000a'
       WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    expect(
      await rejection(
        `INSERT INTO curriculum.concept_node
           (taxonomy_version_id, concept_identity_id, display_name, exam_weight, depth, estimated_teaching_hours)
         VALUES ($1, $2, 'Sneaked in', 0.1, 1, 5)`,
        [versionId, conceptId],
      ),
    ).toMatch(/published_parent_is_immutable/u);

    expect(
      await rejection(`DELETE FROM curriculum.concept_node WHERE concept_node_id = $1`, [nodeId]),
    ).toMatch(/published_parent_is_immutable/u);
  });

  it('rejects a prerequisite edge change under a published version', async () => {
    const versionId = await insertVersion('draft');
    const first = await insertConcept(versionId);
    const second = await database.pool.query<{ concept_identity_id: string }>(
      `INSERT INTO curriculum.concept_identity (canonical_name, subject_domain, created_in_version)
       VALUES ('Kinematics', 'physics', $1) RETURNING concept_identity_id`,
      [versionId],
    );
    await database.pool.query(
      `INSERT INTO curriculum.prerequisite_edge
         (taxonomy_version_id, from_concept_identity_id, to_concept_identity_id, strength)
       VALUES ($1, $2, $3, 0.5)`,
      [versionId, first, second.rows[0]?.concept_identity_id],
    );
    await database.pool.query(
      `UPDATE curriculum.taxonomy_version SET state = 'published', published_at = now(),
              published_by_kind = 'human', published_by_id = '00000000-0000-0000-0000-00000000000a'
       WHERE taxonomy_version_id = $1`,
      [versionId],
    );

    expect(
      await rejection(
        `UPDATE curriculum.prerequisite_edge SET strength = 0.9 WHERE taxonomy_version_id = $1`,
        [versionId],
      ),
    ).toMatch(/published_parent_is_immutable/u);
  });

  it('rejects a section spec change under a published profile', async () => {
    const versionId = await insertVersion('draft');
    const profileId = await insertProfile('draft', versionId);
    await database.pool.query(
      `INSERT INTO curriculum.exam_section_spec
         (profile_version_id, ordinal, name, subject, item_count, item_type_mix, max_marks)
       VALUES ($1, 1, 'Physics', 'physics', 25, '{"MCQ":25}'::jsonb, 100)`,
      [profileId],
    );
    await database.pool.query(
      `UPDATE curriculum.exam_profile_version SET state = 'published', marking_rule_set_hash = 'hash',
              published_at = now(), published_by_kind = 'human',
              published_by_id = '00000000-0000-0000-0000-00000000000a'
       WHERE profile_version_id = $1`,
      [profileId],
    );

    expect(
      await rejection(
        `UPDATE curriculum.exam_section_spec SET max_marks = 1 WHERE profile_version_id = $1`,
        [profileId],
      ),
    ).toMatch(/published_parent_is_immutable/u);
  });

  it('leaves children of a draft parent editable', async () => {
    const versionId = await insertVersion('draft');
    const conceptId = await insertConcept(versionId);
    const nodeId = await insertNode(versionId, conceptId);

    await database.db.update(conceptNode).set({ depth: 3 }).where(eq(conceptNode.conceptNodeId, nodeId));

    const after = await database.db.execute<{ depth: number }>(
      sql`SELECT depth FROM curriculum.concept_node WHERE concept_node_id = ${nodeId}`,
    );
    expect(after.rows[0]?.depth).toBe(3);
  });
});

describe('trigger coverage', () => {
  it('installs a trigger on both version tables and all three child tables', async () => {
    const result = await database.db.execute<{ event_object_table: string }>(sql`
      SELECT DISTINCT event_object_table FROM information_schema.triggers
      WHERE trigger_schema = 'curriculum' ORDER BY event_object_table
    `);

    expect(result.rows.map((row) => row.event_object_table)).toEqual([
      'concept_node',
      'exam_profile_version',
      'exam_section_spec',
      'prerequisite_edge',
      'taxonomy_version',
    ]);
  });

  it('reverses with the down migration and re-applies', async () => {
    await database.revertMigrations();
    await database.applyMigrations();

    const result = await database.db.execute<{ count: string }>(sql`
      SELECT count(DISTINCT event_object_table)::text AS count FROM information_schema.triggers
      WHERE trigger_schema = 'curriculum'
    `);

    expect(result.rows[0]?.count).toBe('5');
  });
});
