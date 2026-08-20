import type { PoolClient } from 'pg';

/**
 * `ReviewDecision.candidatesShownIds` (M4-07), normalized to rows (M4-19).
 * "Was this candidate shown?" is a question with an index, which a JSON
 * array on `review_decision` cannot answer without loading and parsing every
 * row — a `WHERE candidate_item_id = $1` cannot reach into a blob.
 *
 * Plain functions, not a class: every call already runs inside
 * `PostgresReviewDecisionRepository.record`'s transaction, on a client that
 * transaction owns — there is nothing here for a class to hold as state.
 */

export async function insertCandidatesShown(
  client: PoolClient,
  decisionId: string,
  candidateItemIds: readonly string[],
): Promise<void> {
  if (candidateItemIds.length === 0) return;

  const values = candidateItemIds.map((_, index) => `($1, $${index + 2})`).join(', ');
  await client.query(
    `INSERT INTO content.review_candidate_shown (review_decision_id, candidate_item_id) VALUES ${values}`,
    [decisionId, ...candidateItemIds],
  );
}

export async function findCandidatesShown(client: PoolClient, decisionId: string): Promise<readonly string[]> {
  const found = await client.query<{ candidate_item_id: string }>(
    `SELECT candidate_item_id FROM content.review_candidate_shown
      WHERE review_decision_id = $1
      ORDER BY candidate_item_id`,
    [decisionId],
  );
  return found.rows.map((row) => row.candidate_item_id);
}
