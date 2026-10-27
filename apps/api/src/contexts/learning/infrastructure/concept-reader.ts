import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { ConceptReader } from '../application/ports.js';
import { err, ok, type Result } from '../domain/result.js';

/**
 * The learner's concept states, read for the one question remediation asks (M7-28). The stored state is read as it is: decay is computed at read
 * (DEC-M7-8) and this read does not apply it (D76).
 */
export class PostgresConceptReader implements ConceptReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async weakest(learnerRef: string, taxonomyVersionId: string, limit: number): Promise<Result<readonly string[], ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<{ concept_identity_id: string }>(
        `SELECT concept_identity_id
           FROM learning.concept_state
          WHERE learner_ref = $1 AND taxonomy_version_id = $2 AND state IN ('weak', 'developing')
          ORDER BY (state = 'weak') DESC, confidence ASC, concept_identity_id
          LIMIT $3`,
        [learnerRef, taxonomyVersionId, limit],
      );
      return ok(Object.freeze(rows.map((row) => row.concept_identity_id)));
    } catch {
      return err(applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', 'the learner\'s concept states could not be read'));
    }
  }
}
