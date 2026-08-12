import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError, validationError } from '../domain/content-error.js';
import type { RepositoryError, SolutionRepository } from '../domain/repository-ports.js';
import {
  reconstituteSolution,
  type AlternateApproach,
  type DistractorAnalysis,
  type FinalAnswerAssertion,
  type Solution,
  type SolutionStep,
  type SolutionVersion,
} from '../domain/solution.js';
import type { LifecycleState } from '../domain/item-lifecycle.js';
import type { ContentBody } from '../domain/content-body.js';
import { projectContentBody } from '../domain/content-body-projections.js';

/**
 * The casing boundary for `Solution` (§2).
 *
 * **The final answer is stored as the authored assertion**, JSONB with a
 * schema version, not decomposed into columns. It is polymorphic by item type
 * and only ever read whole — which is exactly DATA-ARCHITECTURE §2's rule for
 * what belongs in a document rather than in columns. Crucially the numeric
 * variant keeps its **decimal literal as text inside the document**, because
 * M3-14 compares it through the item's own `NumericAnswerSpec` and a float
 * would decide agreement on a value nobody wrote.
 *
 * **Nothing here reaches a delivery payload.** A solution is the product's
 * value and is entitlement-gated above basic correctness (INV-08); the
 * delivery query in M3-29 is the only reader that serves one, and it does so
 * under its own gate.
 */

interface SolutionRow {
  readonly solution_id: string;
  readonly item_id: string;
  readonly target_item_version_id: string;
  readonly lifecycle_state: LifecycleState;
  readonly current_published_version_id: string | null;
  readonly aggregate_version: number;
}

interface VersionRow {
  readonly solution_version_id: string;
  readonly version_no: number;
  readonly final_answer: FinalAnswerAssertion;
  readonly authored_by_kind: 'human' | 'ai_agent' | 'system';
  readonly authored_by_id: string;
  readonly created_at: Date;
}

interface StepRow {
  readonly solution_version_id: string;
  readonly ordinal: number;
  readonly body: ContentBody;
  readonly concept_refs: readonly string[];
}

interface AnalysisRow {
  readonly solution_version_id: string;
  readonly option_id: string;
  readonly misconception_body: ContentBody;
}

interface ApproachRow {
  readonly solution_version_id: string;
  readonly label: string;
  readonly steps: readonly { readonly ordinal: number; readonly body: ContentBody; readonly conceptRefs: readonly string[] }[];
  readonly applicability_note: string | null;
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'solution');
}

export class PostgresSolutionRepository implements SolutionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(solution: Solution): Promise<Result<Solution, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<Solution, RepositoryError>;

    // No `finally` — see the note in `item.repository.ts`.
    try {
      await client.query('BEGIN');
      outcome = await this.#saveWithin(client, solution);
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #saveWithin(client: PoolClient, solution: Solution): Promise<Result<Solution, RepositoryError>> {
    const existing = await client.query<{ aggregate_version: number }>(
      `SELECT aggregate_version FROM content.solution WHERE solution_id = $1 FOR UPDATE`,
      [solution.solutionId],
    );

    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO content.solution
           (solution_id, item_id, target_item_version_id, lifecycle_state, aggregate_version)
         VALUES ($1, $2, $3, 'draft', $4)`,
        [solution.solutionId, solution.itemId, solution.targetItemVersionId, solution.aggregateVersion],
      );
    } else {
      const stored = existing.rows[0]!.aggregate_version;
      if (stored >= solution.aggregateVersion) {
        return err(
          conflictError(
            'CONFLICT',
            `solution ${solution.solutionId} moved on: stored aggregate version ${stored}, attempted ${solution.aggregateVersion}`,
            'aggregateVersion',
          ),
        );
      }
    }

    for (const version of solution.versions) {
      await this.#saveVersion(client, solution.solutionId, version);
    }

    if (solution.currentPublishedVersionId !== undefined) {
      await client.query(
        `UPDATE content.solution_version SET published_at = now()
          WHERE solution_version_id = $1 AND published_at IS NULL`,
        [solution.currentPublishedVersionId],
      );
    }

    await client.query(
      `UPDATE content.solution
          SET lifecycle_state = $2,
              current_published_version_id = $3,
              aggregate_version = $4
        WHERE solution_id = $1`,
      [
        solution.solutionId,
        solution.lifecycleState,
        solution.currentPublishedVersionId ?? null,
        solution.aggregateVersion,
      ],
    );

    return ok(solution);
  }

  async #saveVersion(client: PoolClient, solutionId: string, version: SolutionVersion): Promise<void> {
    const known = await client.query(
      `SELECT 1 FROM content.solution_version WHERE solution_version_id = $1`,
      [version.versionId],
    );
    if (known.rowCount !== 0) return;

    await client.query(
      `INSERT INTO content.solution_version
         (solution_version_id, solution_id, version_no, final_answer_kind, final_answer,
          authored_by_kind, authored_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        version.versionId,
        solutionId,
        version.versionNo,
        version.finalAnswerAssertion.kind,
        JSON.stringify(version.finalAnswerAssertion),
        version.authoredBy.kind,
        version.authoredBy.id,
        version.createdAt,
      ],
    );

    for (const step of version.steps) {
      const projections = projectContentBody(step.body);
      await client.query(
        `INSERT INTO content.solution_step
           (solution_version_id, ordinal, body, body_plain_text, concept_refs)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [version.versionId, step.ordinal, JSON.stringify(step.body), projections.plainText, [...step.conceptRefs]],
      );
      await this.#saveMediaRefs(client, version.versionId, projections.referencedMediaIds);
    }

    for (const analysis of version.distractorAnalyses) {
      const projections = projectContentBody(analysis.misconception);
      await client.query(
        `INSERT INTO content.distractor_analysis
           (solution_version_id, option_id, misconception_body, misconception_plain_text)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [version.versionId, analysis.optionId, JSON.stringify(analysis.misconception), projections.plainText],
      );
      await this.#saveMediaRefs(client, version.versionId, projections.referencedMediaIds);
    }

    for (const approach of version.alternateApproaches) {
      await client.query(
        `INSERT INTO content.alternate_approach
           (solution_version_id, label, steps, applicability_note)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [
          version.versionId,
          approach.label,
          JSON.stringify(
            approach.steps.map((step) => ({
              ordinal: step.ordinal,
              body: step.body,
              conceptRefs: [...step.conceptRefs],
            })),
          ),
          approach.applicabilityNote ?? null,
        ],
      );
    }
  }

  async #saveMediaRefs(
    client: PoolClient,
    versionId: string,
    assetVersionIds: readonly string[],
  ): Promise<void> {
    for (const assetVersionId of assetVersionIds) {
      await client.query(
        `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
         VALUES ('solution_version', $1, $2)
         ON CONFLICT DO NOTHING`,
        [versionId, assetVersionId],
      );
    }
  }

  async findById(solutionId: string): Promise<Result<Solution, RepositoryError>> {
    const found = await this.#pool.query<SolutionRow>(
      `SELECT solution_id, item_id, target_item_version_id, lifecycle_state,
              current_published_version_id, aggregate_version
         FROM content.solution WHERE solution_id = $1`,
      [solutionId],
    );
    if (found.rowCount === 0) {
      return err(notFoundError('NOT_FOUND', `no solution ${solutionId}`, 'solutionId'));
    }
    return this.#hydrate(found.rows[0]!);
  }

  async findPublishedForItemVersion(
    itemVersionId: string,
  ): Promise<Result<SolutionVersion, RepositoryError>> {
    const found = await this.#pool.query<SolutionRow>(
      `SELECT solution_id, item_id, target_item_version_id, lifecycle_state,
              current_published_version_id, aggregate_version
         FROM content.solution
        WHERE target_item_version_id = $1
          AND lifecycle_state = 'published'
          AND current_published_version_id IS NOT NULL`,
      [itemVersionId],
    );
    if (found.rowCount === 0) {
      return err(
        notFoundError('NOT_FOUND', `no published solution targets item version ${itemVersionId}`, 'itemVersionId'),
      );
    }

    const solution = await this.#hydrate(found.rows[0]!);
    if (!solution.ok) return err(solution.error);

    // The query already excluded solutions publishing nothing, and
    // `reconstituteSolution` refuses a published reference the aggregate does
    // not hold — so a hydrated solution always finds one here. A second guard
    // would be a branch nothing can reach; the corruption it would have caught
    // is reported by reconstitution instead, and the spec asserts that.
    const published = solution.value.versions.find(
      (version) => version.versionId === solution.value.currentPublishedVersionId,
    );
    return ok(published as SolutionVersion);
  }

  async #hydrate(row: SolutionRow): Promise<Result<Solution, RepositoryError>> {
    const versions = await this.#pool.query<VersionRow>(
      `SELECT solution_version_id, version_no, final_answer, authored_by_kind, authored_by_id, created_at
         FROM content.solution_version WHERE solution_id = $1 ORDER BY version_no`,
      [row.solution_id],
    );

    const versionIds = versions.rows.map((version) => version.solution_version_id);
    const [steps, analyses, approaches] = await Promise.all([
      this.#pool.query<StepRow>(
        `SELECT solution_version_id, ordinal, body, concept_refs
           FROM content.solution_step WHERE solution_version_id = ANY($1::uuid[]) ORDER BY ordinal`,
        [versionIds],
      ),
      this.#pool.query<AnalysisRow>(
        `SELECT solution_version_id, option_id, misconception_body
           FROM content.distractor_analysis WHERE solution_version_id = ANY($1::uuid[]) ORDER BY option_id`,
        [versionIds],
      ),
      this.#pool.query<ApproachRow>(
        `SELECT solution_version_id, label, steps, applicability_note
           FROM content.alternate_approach WHERE solution_version_id = ANY($1::uuid[]) ORDER BY label`,
        [versionIds],
      ),
    ]);

    const hydratedVersions: SolutionVersion[] = versions.rows.map((version) => {
      const versionSteps: readonly SolutionStep[] = Object.freeze(
        steps.rows
          .filter((step) => step.solution_version_id === version.solution_version_id)
          .map((step) =>
            Object.freeze({
              ordinal: step.ordinal,
              body: step.body,
              conceptRefs: Object.freeze([...step.concept_refs]),
            }),
          ),
      );

      const versionAnalyses: readonly DistractorAnalysis[] = Object.freeze(
        analyses.rows
          .filter((analysis) => analysis.solution_version_id === version.solution_version_id)
          .map((analysis) =>
            Object.freeze({ optionId: analysis.option_id, misconception: analysis.misconception_body }),
          ),
      );

      const versionApproaches: readonly AlternateApproach[] = Object.freeze(
        approaches.rows
          .filter((approach) => approach.solution_version_id === version.solution_version_id)
          .map((approach) =>
            Object.freeze({
              label: approach.label,
              steps: Object.freeze(
                approach.steps.map((step) =>
                  Object.freeze({
                    ordinal: step.ordinal,
                    body: step.body,
                    conceptRefs: Object.freeze([...step.conceptRefs]),
                  }),
                ),
              ),
              ...(approach.applicability_note === null
                ? {}
                : { applicabilityNote: approach.applicability_note }),
            }),
          ),
      );

      return Object.freeze({
        versionId: version.solution_version_id,
        versionNo: version.version_no,
        finalAnswerAssertion: Object.freeze({ ...version.final_answer }),
        steps: versionSteps,
        distractorAnalyses: versionAnalyses,
        alternateApproaches: versionApproaches,
        authoredBy: Object.freeze({
          kind: version.authored_by_kind,
          id: version.authored_by_id,
          roleContext: Object.freeze([]),
        }),
        createdAt: toIsoInstant(version.created_at),
      });
    });

    const solution = reconstituteSolution({
      solutionId: row.solution_id,
      itemId: row.item_id,
      targetItemVersionId: row.target_item_version_id,
      lifecycleState: row.lifecycle_state,
      versions: hydratedVersions,
      aggregateVersion: row.aggregate_version,
      ...(row.current_published_version_id === null
        ? {}
        : { currentPublishedVersionId: row.current_published_version_id }),
    });

    return solution.ok
      ? ok(solution.value)
      : err(
          persistenceRejected(
            `stored solution ${row.solution_id} does not reconstitute: ${solution.error.message}`,
          ),
        );
  }
}
