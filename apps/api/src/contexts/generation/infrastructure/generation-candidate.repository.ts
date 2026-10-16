import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import {
  restoreGenerationCandidate,
  type CandidateState,
  type GenerationCandidate,
  type PrecheckVerdict,
} from '../domain/generation-candidate.js';
import type { GenerationEvent } from '../domain/events/generation-events.js';
import type { GenerationCandidateRepository, RepositoryError } from '../domain/repository-ports.js';
import { GenerationOutboxEmitter } from './outbox-emitter.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface CandidateRow {
  readonly candidate_id: string;
  readonly run_id: string;
  readonly model_version_id: string;
  readonly prompt_version_id: string;
  readonly item_type: string;
  readonly body: Record<string, unknown>;
  readonly confidence: number;
}

interface VerdictRow {
  readonly candidate_id: string;
  readonly check_id: PrecheckVerdict['check'];
  readonly outcome: PrecheckVerdict['outcome'];
  readonly detail: string | null;
  readonly ordinal: number;
}

interface DecisionRow {
  readonly candidate_id: string;
  readonly decision: Exclude<CandidateState, 'proposed'>;
}

const CANDIDATE_COLUMNS = 'candidate_id, run_id, model_version_id, prompt_version_id, item_type, body, confidence';

/**
 * A candidate is stored as four append-only tables: the proposal with its pin,
 * one row per verdict, and one row for the decision. Nothing is ever updated,
 * so saving is **reconciliation**, not overwrite:
 *
 * - the proposal and the pin, once stored, must match what is being saved;
 * - every stored verdict must still be present, unchanged, at its position —
 *   a candidate that has lost or altered one is a `CONFLICT`, not a rewrite;
 * - only the verdicts and the decision the candidate has *gained* are written.
 *
 * The state is not a column. A candidate with no decision row is proposed.
 */
export class PostgresGenerationCandidateRepository implements GenerationCandidateRepository {
  readonly #pool: Pool;
  readonly #outbox = new GenerationOutboxEmitter();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(
    candidate: GenerationCandidate,
    events: readonly GenerationEvent[] = [],
  ): Promise<Result<GenerationCandidate, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<GenerationCandidate, RepositoryError>;

    // No `finally`: the catch never rethrows, so the release below runs on both
    // paths, and a `finally` would carry an abrupt-completion path nothing can
    // reach — untestable code in a module the 100% rule covers. Same shape as
    // the content repositories, for the same reason.
    try {
      await client.query('BEGIN');
      outcome = await this.#saveWithin(client, candidate);
      // §9 rule 4: the events go in with the candidate, so a rolled-back change
      // leaves nothing behind claiming it happened.
      if (outcome.ok) {
        for (const event of events) await this.#outbox.emit(client, event);
      }
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(fromDatabaseError(error));
    }

    client.release();
    return outcome;
  }

  async #saveWithin(client: PoolClient, candidate: GenerationCandidate): Promise<Result<GenerationCandidate, RepositoryError>> {
    const { candidateId, pin, content } = candidate;

    const stored = (
      await client.query<CandidateRow>(`SELECT ${CANDIDATE_COLUMNS} FROM ai.generation_candidate WHERE candidate_id = $1`, [
        candidateId,
      ])
    ).rows[0];

    if (stored === undefined) {
      await client.query(
        `INSERT INTO ai.generation_candidate
           (candidate_id, run_id, model_version_id, prompt_version_id, item_type, body, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          candidateId,
          pin.runId,
          pin.modelVersionId,
          pin.promptVersionId,
          content.itemType,
          JSON.stringify(content.body),
          candidate.confidence,
        ],
      );
    } else if (
      stored.run_id !== pin.runId ||
      stored.model_version_id !== pin.modelVersionId ||
      stored.prompt_version_id !== pin.promptVersionId ||
      stored.item_type !== content.itemType ||
      stored.confidence !== candidate.confidence ||
      canonicalJson(stored.body) !== canonicalJson(content.body)
    ) {
      return err(conflict(`candidate ${candidateId} is stored with a different pin or proposal`, 'candidate'));
    }

    const storedVerdicts = (
      await client.query<VerdictRow>(
        `SELECT candidate_id, check_id, outcome, detail, ordinal FROM ai.candidate_verdict
          WHERE candidate_id = $1 ORDER BY ordinal`,
        [candidateId],
      )
    ).rows;
    for (const row of storedVerdicts) {
      const held = candidate.verdicts[row.ordinal];
      if (held?.check !== row.check_id || held.outcome !== row.outcome || held.detail !== (row.detail ?? undefined)) {
        return err(conflict(`candidate ${candidateId} has lost or changed the verdict for ${row.check_id}`, 'verdicts'));
      }
    }
    for (const [ordinal, verdict] of candidate.verdicts.entries()) {
      if (ordinal < storedVerdicts.length) continue;
      await client.query(
        `INSERT INTO ai.candidate_verdict (candidate_id, check_id, outcome, detail, ordinal) VALUES ($1, $2, $3, $4, $5)`,
        [candidateId, verdict.check, verdict.outcome, verdict.detail ?? null, ordinal],
      );
    }

    const storedDecision = (
      await client.query<DecisionRow>(`SELECT candidate_id, decision FROM ai.candidate_decision WHERE candidate_id = $1`, [
        candidateId,
      ])
    ).rows[0]?.decision;
    const decision = candidate.state === 'proposed' ? undefined : candidate.state;
    if (storedDecision !== undefined && storedDecision !== decision) {
      return err(conflict(`candidate ${candidateId} was already ${storedDecision}`, 'state'));
    }
    if (storedDecision === undefined && decision !== undefined) {
      await client.query(`INSERT INTO ai.candidate_decision (candidate_id, decision) VALUES ($1, $2)`, [candidateId, decision]);
    }

    return ok(candidate);
  }

  async findById(candidateId: string): Promise<Result<GenerationCandidate, RepositoryError>> {
    const found = await this.#read(`WHERE candidate_id = $1`, [candidateId]);
    if (!found.ok) return found;
    const candidate = found.value[0];
    return candidate === undefined ? err(notFound('candidate', candidateId)) : ok(candidate);
  }

  findByRun(runId: string): Promise<Result<readonly GenerationCandidate[], RepositoryError>> {
    return this.#read(`WHERE run_id = $1`, [runId]);
  }

  findByPromptVersion(promptVersionId: string): Promise<Result<readonly GenerationCandidate[], RepositoryError>> {
    return this.#read(`WHERE prompt_version_id = $1`, [promptVersionId]);
  }

  /** Three queries however many candidates match, oldest first. */
  async #read(where: string, params: readonly unknown[]): Promise<Result<readonly GenerationCandidate[], RepositoryError>> {
    try {
      const candidates = (
        await this.#pool.query<CandidateRow>(
          `SELECT ${CANDIDATE_COLUMNS} FROM ai.generation_candidate ${where} ORDER BY created_at, candidate_id`,
          [...params],
        )
      ).rows;
      const ids = candidates.map((row) => row.candidate_id);

      const verdicts = (
        await this.#pool.query<VerdictRow>(
          `SELECT candidate_id, check_id, outcome, detail, ordinal FROM ai.candidate_verdict
            WHERE candidate_id = ANY($1::uuid[]) ORDER BY candidate_id, ordinal`,
          [ids],
        )
      ).rows;
      const decisions = new Map(
        (
          await this.#pool.query<DecisionRow>(
            `SELECT candidate_id, decision FROM ai.candidate_decision WHERE candidate_id = ANY($1::uuid[])`,
            [ids],
          )
        ).rows.map((row) => [row.candidate_id, row.decision] as const),
      );

      const restored: GenerationCandidate[] = [];
      for (const row of candidates) {
        const candidate = restoreGenerationCandidate({
          candidateId: row.candidate_id,
          pin: { modelVersionId: row.model_version_id, promptVersionId: row.prompt_version_id, runId: row.run_id },
          content: { itemType: row.item_type, body: row.body },
          confidence: row.confidence,
          verdicts: verdicts
            .filter((verdict) => verdict.candidate_id === row.candidate_id)
            .map((verdict) =>
              verdict.detail === null
                ? { check: verdict.check_id, outcome: verdict.outcome }
                : { check: verdict.check_id, outcome: verdict.outcome, detail: verdict.detail },
            ),
          state: decisions.get(row.candidate_id) ?? 'proposed',
        });
        if (!candidate.ok) {
          return err(
            persistenceRejected(
              `stored candidate ${row.candidate_id} no longer satisfies the domain: ${candidate.error.code}`,
              candidate.error.location,
            ),
          );
        }
        restored.push(candidate.value);
      }
      return ok(restored);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
