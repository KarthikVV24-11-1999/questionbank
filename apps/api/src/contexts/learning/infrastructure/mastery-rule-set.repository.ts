import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { MasteryRuleSetRepository } from '../application/ports.js';
import { createMasteryRuleSet, type MasteryRuleSet } from '../domain/mastery-rule-set.js';
import { err, ok, type Result } from '../domain/result.js';

interface Row {
  readonly rule_set_id: string;
  readonly taxonomy_version_id: string | null;
  readonly version_no: number;
  readonly thresholds: unknown;
}

const COLUMNS = 'rule_set_id, taxonomy_version_id, version_no, thresholds';

/**
 * A stored version, read back through the same constructor that validates a new one. A row that no longer satisfies the domain is a fault in the
 * store and is reported as one, never repaired into a rule set that looks fine.
 */
function toRuleSet(row: Row): Result<MasteryRuleSet, ApplicationError> {
  const built = createMasteryRuleSet({ ruleSetId: row.rule_set_id, taxonomyVersionId: row.taxonomy_version_id, versionNo: row.version_no, thresholds: row.thresholds });
  return built.ok ? ok(built.value) : err(applicationError('Unavailable', 'PERSISTENCE_REJECTED', `a stored rule set is invalid: ${built.error.code}`));
}

const unavailable = () => err(applicationError('Unavailable', 'STORE_UNAVAILABLE', 'the rule sets could not be read or written'));

export class PostgresMasteryRuleSetRepository implements MasteryRuleSetRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async append(draft: Parameters<MasteryRuleSetRepository['append']>[0]): Promise<Result<MasteryRuleSet, ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<Row>(
        `INSERT INTO learning.mastery_rule_set
           (rule_set_id, taxonomy_version_id, version_no, thresholds, thresholds_hash, authored_by_kind, authored_by_id, created_at)
         SELECT $1::uuid, $2::uuid, COALESCE(max(version_no), 0) + 1, $3::jsonb, $4, $5, $6::uuid, $7::timestamptz
           FROM learning.mastery_rule_set
          WHERE COALESCE(taxonomy_version_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         RETURNING ${COLUMNS}`,
        [draft.ruleSetId, draft.taxonomyVersionId, JSON.stringify(draft.thresholds), draft.thresholdsHash, draft.principal.kind, draft.principal.id, draft.createdAt],
      );
      return toRuleSet(rows[0] as Row);
    } catch (error) {
      // 23505: another publication took the number between the read and the write. The caller may publish again.
      if ((error as { code?: string } | null)?.code === '23505') {
        return err(applicationError('Conflict', 'RULE_SET_VERSION_TAKEN', 'another version was published for this scope at the same moment'));
      }
      return unavailable();
    }
  }

  async currentFor(taxonomyVersionId: string): Promise<Result<MasteryRuleSet, ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<Row>(
        `SELECT ${COLUMNS} FROM learning.mastery_rule_set
          WHERE taxonomy_version_id = $1 OR taxonomy_version_id IS NULL
          ORDER BY (taxonomy_version_id IS NULL), version_no DESC
          LIMIT 1`,
        [taxonomyVersionId],
      );
      return rows[0] === undefined ? err(applicationError('NotFound', 'NO_RULE_SET', 'no mastery rule set, not even the platform default')) : toRuleSet(rows[0]);
    } catch {
      return unavailable();
    }
  }

  async byId(ruleSetId: string): Promise<Result<MasteryRuleSet, ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<Row>(`SELECT ${COLUMNS} FROM learning.mastery_rule_set WHERE rule_set_id = $1`, [ruleSetId]);
      return rows[0] === undefined ? err(applicationError('NotFound', 'NO_RULE_SET', `no mastery rule set ${ruleSetId}`)) : toRuleSet(rows[0]);
    } catch {
      return unavailable();
    }
  }
}
