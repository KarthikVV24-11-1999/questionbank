import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../testing/database.js';
import {
  checkJsonbVersionSiblings,
  checkNoTruncateGrant,
  checkNoWriteGrantOnAppendOnlyTable,
  type ColumnRow,
  type GrantRow,
} from './content-rules.js';

/**
 * The two M3 gates that can only be answered by the database (§5: real
 * Postgres, never a mock).
 *
 *   F5     — every content JSONB column has a sibling `*_schema_version`
 *   F7/F40 — no TRUNCATE grant on a published-version table
 *
 * The SQL lives here and the judgment lives in `content-rules.ts`, so the same
 * rule that runs against the real catalogue is the one the unit spec runs
 * against a planted violation.
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

const PUBLISHED_VERSION_TABLES = [
  'item_version',
  'item_option',
  'item_numeric_spec',
  'item_taxonomy_tag',
  'item_provenance',
  'stimulus_version',
  'solution_version',
  'solution_step',
  'media_asset_version',
];

// M4-21's extension of M0-24's closed table list — not a second one.
const APPEND_ONLY_CONTENT_TABLES = [
  'content.review_decision',
  'content.review_candidate_shown',
  'content.review_escalation',
];
const UPDATE_ONLY_CONTENT_TABLES = ['content.review_assignment'];

describe('F5 — every content JSONB column has a version sibling', () => {
  it('holds across the whole content schema, over a catalogue that is not empty', async () => {
    const { rows } = await database.pool.query<ColumnRow>(
      `SELECT table_name AS "table", column_name AS "column", data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'content'`,
    );

    expect(rows.filter((row) => row.dataType === 'jsonb').length).toBeGreaterThanOrEqual(9);
    expect(checkJsonbVersionSiblings(rows)).toEqual([]);
  });

  // The instrument, on the same shape of data: dropping a real sibling from the
  // catalogue rows makes the check fire, so a green result is a fact about the
  // schema rather than about the query returning nothing.
  it('fires when a real sibling is taken away', async () => {
    const { rows } = await database.pool.query<ColumnRow>(
      `SELECT table_name AS "table", column_name AS "column", data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = 'content'`,
    );
    const weakened = rows.filter((row) => row.column !== 'stem_body_schema_version');

    expect(checkJsonbVersionSiblings(weakened).map((violation) => violation.subject)).toContain(
      'item_version.stem_body',
    );
  });
});

describe('F7/F40 — no TRUNCATE grant on a published-version table', () => {
  /**
   * The role the deployed application connects as. **It now exists on a
   * local instance** (M0-24, closes D9) — the migration creates it — so this
   * test is rewritten to assert the real thing rather than left recording an
   * absence that stopped being true. Leaving it asserting a falsehood would
   * be worse than having no test (DEC-M0-14 rule 3).
   */
  const APP_ROLE = 'questionbank_app';

  it('exists, locally, as the migration creates it', async () => {
    const { rows } = await database.pool.query<{ exists: boolean; canLogin: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists,
              (SELECT rolcanlogin FROM pg_roles WHERE rolname = $1) AS "canLogin"`,
      [APP_ROLE],
    );
    expect(rows[0]?.exists).toBe(true);
    // NOLOGIN locally — no password in source (F39); the deployed credential
    // is set out of band, from Secrets Manager, never by this migration.
    expect(rows[0]?.canLogin).toBe(false);
  });

  it('holds exactly the expected privilege set — SELECT/INSERT/UPDATE/DELETE on content/curriculum/scoring, SELECT/INSERT only on platform', async () => {
    const { rows } = await database.pool.query<GrantRow & { schema: string }>(
      `SELECT table_schema AS "schema", table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema IN ('content', 'curriculum', 'scoring', 'platform')`,
      [APP_ROLE],
    );

    expect(rows.length).toBeGreaterThan(0);

    const byTable = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = `${row.schema}.${row.table}`;
      const set = byTable.get(key) ?? new Set<string>();
      set.add(row.privilege);
      byTable.set(key, set);
    }

    for (const [table, privileges] of byTable) {
      expect(privileges.has('TRUNCATE'), table).toBe(false);
      if (table.startsWith('platform.') || APPEND_ONLY_CONTENT_TABLES.includes(table)) {
        expect([...privileges].sort(), table).toEqual(['INSERT', 'SELECT']);
      } else if (UPDATE_ONLY_CONTENT_TABLES.includes(table)) {
        // review_assignment (M4-21): claimed, released, reassigned and
        // escalated by design — UPDATE stays, but nothing legitimately
        // deletes one, so DELETE does not.
        expect([...privileges].sort(), table).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      } else {
        expect(privileges.has('SELECT'), table).toBe(true);
        expect(privileges.has('INSERT'), table).toBe(true);
        expect(privileges.has('UPDATE'), table).toBe(true);
        expect(privileges.has('DELETE'), table).toBe(true);
      }
    }
  });

  it('finds no TRUNCATE held by the application role', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'content' AND table_name = ANY($1)`,
      [PUBLISHED_VERSION_TABLES],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.table)).size).toBe(PUBLISHED_VERSION_TABLES.length);
    expect(checkNoTruncateGrant(rows, [APP_ROLE])).toEqual([]);
  });

  // A real result about a role that now really exists (M0-24) — so the check
  // is also shown to fire on the same catalogue shape with the grant present,
  // the first time F7/F40 has ever fired against a real role rather than a
  // planted row alone.
  it('fires when the application role does hold TRUNCATE', () => {
    const violations = checkNoTruncateGrant(
      [
        { table: 'item_version', privilege: 'TRUNCATE', grantee: APP_ROLE },
        { table: 'item_version', privilege: 'UPDATE', grantee: APP_ROLE },
      ],
      [APP_ROLE],
    );
    expect(violations).toEqual([
      {
        rule: 'F7_WRITE_GRANT_ON_A_PUBLISHED_VERSION_TABLE',
        subject: 'item_version',
        detail: `${APP_ROLE} holds TRUNCATE`,
      },
    ]);
  });

  // UPDATE and DELETE are deliberately *kept*: a content version is editable
  // while a draft and frozen from publication, which is what the draft state is
  // for. The trigger holds INV-03 for rows; the grant is the control only for
  // TRUNCATE, which a row trigger cannot see (M3-20).
  it('does not object to the row privileges drafts need', () => {
    expect(
      checkNoTruncateGrant(
        [
          { table: 'item_version', privilege: 'UPDATE', grantee: APP_ROLE },
          { table: 'item_version', privilege: 'DELETE', grantee: APP_ROLE },
        ],
        [APP_ROLE],
      ),
    ).toEqual([]);
  });
});

describe('F40 — no UPDATE/DELETE/TRUNCATE on an append-only platform table', () => {
  const APP_ROLE = 'questionbank_app';

  it('finds none held on platform.audit_record, against the real catalogue', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'platform' AND table_name = 'audit_record'`,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(checkNoWriteGrantOnAppendOnlyTable(rows, [APP_ROLE])).toEqual([]);
  });

  it('fires when the application role holds UPDATE on platform.audit_record', () => {
    const violations = checkNoWriteGrantOnAppendOnlyTable(
      [{ table: 'audit_record', privilege: 'UPDATE', grantee: APP_ROLE }],
      [APP_ROLE],
    );
    expect(violations).toEqual([
      { rule: 'F40_WRITE_GRANT_ON_AN_APPEND_ONLY_TABLE', subject: 'audit_record', detail: `${APP_ROLE} holds UPDATE` },
    ]);
  });
});

describe('review-table immutability & grants (M4-21, F7/F40)', () => {
  async function rejects(query: string, params: readonly unknown[] = []): Promise<string> {
    try {
      await database.pool.query(query, [...params]);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`expected the database to refuse: ${query}`);
  }

  let uuidSeed = 0;
  function freshUuid(): string {
    uuidSeed += 1;
    return `00000000-0000-4000-d000-${uuidSeed.toString(16).padStart(12, '0')}`;
  }

  async function seedItemVersion(): Promise<{ itemId: string; itemVersionId: string }> {
    const itemId = freshUuid();
    const itemVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject) VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', 'physics')`,
      [itemId],
    );
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
      [itemVersionId, itemId, freshUuid()],
    );
    return { itemId, itemVersionId };
  }

  async function seedAssignment(): Promise<string> {
    const { itemId, itemVersionId } = await seedItemVersion();
    const assignmentId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_assignment
         (assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state,
          claimed_at, lease_expires_at)
       VALUES ($1, $2, $3, 'physics', 'human', $4, 'claimed', 'claimed', now(), now() + interval '1 hour')`,
      [assignmentId, itemId, itemVersionId, freshUuid()],
    );
    return assignmentId;
  }

  it('rejects UPDATE and DELETE on review_decision', async () => {
    const decisionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_decision (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', now())`,
      [decisionId, freshUuid(), freshUuid()],
    );
    expect(
      await rejects(`UPDATE content.review_decision SET outcome = 'reject' WHERE review_decision_id = $1`, [
        decisionId,
      ]),
    ).toContain('append_only');
    expect(
      await rejects(`DELETE FROM content.review_decision WHERE review_decision_id = $1`, [decisionId]),
    ).toContain('append_only');
  });

  it('rejects UPDATE and DELETE on review_candidate_shown', async () => {
    const decisionId = freshUuid();
    const candidateId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_decision (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', now())`,
      [decisionId, freshUuid(), freshUuid()],
    );
    await database.pool.query(
      `INSERT INTO content.review_candidate_shown (review_decision_id, candidate_item_id) VALUES ($1, $2)`,
      [decisionId, candidateId],
    );
    expect(
      await rejects(
        `UPDATE content.review_candidate_shown SET candidate_item_id = $1 WHERE review_decision_id = $2`,
        [freshUuid(), decisionId],
      ),
    ).toContain('append_only');
    expect(
      await rejects(`DELETE FROM content.review_candidate_shown WHERE review_decision_id = $1`, [decisionId]),
    ).toContain('append_only');
  });

  it('rejects UPDATE and DELETE on review_escalation', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    const escalationId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_escalation (escalation_id, item_id, item_version_id, reason, escalated_at)
       VALUES ($1, $2, $3, 'aged_out', now())`,
      [escalationId, itemId, itemVersionId],
    );
    expect(
      await rejects(`UPDATE content.review_escalation SET reason = 'other' WHERE escalation_id = $1`, [
        escalationId,
      ]),
    ).toContain('append_only');
    expect(
      await rejects(`DELETE FROM content.review_escalation WHERE escalation_id = $1`, [escalationId]),
    ).toContain('append_only');
  });

  it('permits the state changes review_assignment’s own machine names', async () => {
    const assignmentId = await seedAssignment();
    await database.pool.query(
      `UPDATE content.review_assignment
          SET state = 'released', released_at = now(), aggregate_version = aggregate_version + 1
        WHERE assignment_id = $1`,
      [assignmentId],
    );
    const found = await database.pool.query<{ state: string }>(
      `SELECT state FROM content.review_assignment WHERE assignment_id = $1`,
      [assignmentId],
    );
    expect(found.rows[0]!.state).toBe('released');
  });

  it('rejects a review_assignment transition its machine does not name', async () => {
    const assignmentId = await seedAssignment();
    expect(
      await rejects(
        `UPDATE content.review_assignment
            SET state = 'claimed', aggregate_version = aggregate_version + 1
          WHERE assignment_id = $1`,
        [assignmentId],
      ),
    ).toContain('transition_not_permitted');
  });

  it('rejects a review_assignment update that touches a column outside the state machine', async () => {
    const assignmentId = await seedAssignment();
    expect(
      await rejects(`UPDATE content.review_assignment SET subject = 'chemistry' WHERE assignment_id = $1`, [
        assignmentId,
      ]),
    ).toContain('only_the_state_machine_may_change');
  });

  it('never permits deleting a review_assignment', async () => {
    const assignmentId = await seedAssignment();
    expect(await rejects(`DELETE FROM content.review_assignment WHERE assignment_id = $1`, [assignmentId])).toContain(
      'is_never_deleted',
    );
  });

  it('a granted UPDATE inside a rolled-back transaction still makes the trigger fire', async () => {
    const decisionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_decision (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', now())`,
      [decisionId, freshUuid(), freshUuid()],
    );
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(`UPDATE content.review_decision SET outcome = 'reject' WHERE review_decision_id = $1`, [
          decisionId,
        ]),
      ).rejects.toThrow(/append_only/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('the privilege set extended in this file holds no UPDATE/DELETE/TRUNCATE on the three append-only review tables', async () => {
    const { rows } = await database.pool.query<GrantRow>(
      `SELECT table_name AS "table", privilege_type AS "privilege", grantee AS "grantee"
         FROM information_schema.role_table_grants
        WHERE table_schema = 'content' AND grantee = 'questionbank_app'
          AND table_name IN ('review_decision', 'review_candidate_shown', 'review_escalation')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(checkNoWriteGrantOnAppendOnlyTable(rows, ['questionbank_app'])).toEqual([]);
  });
});
