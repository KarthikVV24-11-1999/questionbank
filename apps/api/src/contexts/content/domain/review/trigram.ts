import { normalize } from './fingerprint.js';

/**
 * Trigram similarity — the recall widener (DEC-M4-2). **Retrieval and
 * ranking only, never a verdict.** `exactHash`/`skeletonHash`
 * (`fingerprint.ts`) are the two authoritative answers to "is this a
 * duplicate"; nothing here is one of those answers, and nothing here
 * *could* be mistaken for one — every export in this module returns a
 * `Set<string>`, a `number`, or an ordered list of `{ id, similarity }`
 * pairs. There is no boolean anywhere in this file's surface, checked
 * directly in `trigram.spec.ts`, because a `number` a reader skims as "the
 * score" is one misplaced `> 0.8` away from becoming a verdict nobody
 * decided to make — the type signature is what stops that, not a comment.
 *
 * **Scored in-repo, not in the database.** Postgres `pg_trgm` supplies a GIN
 * index for candidate narrowing only; if the extension is unavailable the
 * fallback is a full scan of the subject's fingerprint set — slower,
 * identically correct. A detector whose answer depends on whether an index
 * exists is one nobody can reason about, so the *answer* — this module —
 * never depends on one.
 *
 * **No dependency added.** `js-levenshtein` sits in the offline store as a
 * transitive package of something else and is deliberately not adopted here:
 * trigram similarity is small enough to read in one sitting, and a
 * similarity metric this repository cannot read the source of is one it
 * cannot debug when a reviewer disputes a candidate.
 */

/** Two leading and one trailing pad character, so a string shorter than three characters still yields a trigram. */
function padded(text: string): string {
  return `  ${text} `;
}

/** The set of three-character windows over the normalized, padded text. */
export function trigrams(text: string): ReadonlySet<string> {
  const source = padded(normalize(text));
  const grams = new Set<string>();
  for (let index = 0; index <= source.length - 3; index += 1) {
    grams.add(source.slice(index, index + 3));
  }
  return grams;
}

/**
 * The Dice coefficient over each string's trigram set — symmetric, `1`
 * exactly when the two sets are identical (identical normalized text, in
 * particular), `0` when they share nothing.
 */
export function trigramSimilarity(a: string, b: string): number {
  const gramsA = trigrams(a);
  const gramsB = trigrams(b);
  let sharedCount = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) sharedCount += 1;
  }
  return (2 * sharedCount) / (gramsA.size + gramsB.size);
}

export interface RankableCandidate {
  readonly id: string;
  readonly similarity: number;
}

/**
 * Orders precomputed `{ id, similarity }` pairs by similarity descending,
 * `id` ascending as the tiebreak, capped at `limit`. Takes the score rather
 * than the text: computing `trigramSimilarity` is this module's other job,
 * kept separate so ranking a candidate set that already has scores costs
 * nothing extra.
 */
export function rankCandidates(
  candidates: readonly RankableCandidate[],
  limit = 5,
): readonly RankableCandidate[] {
  return [...candidates]
    .sort((a, b) => {
      if (a.similarity !== b.similarity) return b.similarity - a.similarity;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
}
