import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../database.js';
import { PostgresFingerprintRepository } from '../../contexts/content/infrastructure/review/fingerprint.repository.js';
import { PostgresReviewAssignmentRepository } from '../../contexts/content/infrastructure/review/review-assignment.repository.js';
import {
  exactHash,
  normalizedText,
  skeletonHash,
  type ItemFingerprintFacts,
} from '../../contexts/content/domain/review/fingerprint.js';
import {
  CLAIMING_REVIEWER_ID,
  CORPUS_NOW,
  CORPUS_REVIEW_POLICY,
  CORPUS_SIZE,
  CORPUS_TAXONOMY_VERSION_ID,
  buildReviewCorpus,
  corpusInstants,
  type CorpusItem,
} from './corpus-40.js';

/**
 * **Tier 1 — machine time per decision, measured against real Postgres over
 * the seeded corpus (M4-44).**
 *
 * ## What is measured
 *
 * `claim → read the payload → decide`, the three round trips a reviewer
 * waits on between one decision and the next. The p95 is asserted at
 * **≤ 300 ms** and the measured number is **written to a file**
 * (`machine-time.json`), not estimated — M0's bundle-size method, so the
 * close-out quotes a real figure rather than one from memory.
 *
 * ## What is not measured
 *
 * A reviewer. This is the software's latency, over the same 40-item corpus
 * (M4-43) the other two Tier-1 numbers use, so the three describe one
 * population. **They are never summed, averaged, or presented under the
 * gate's name** — see `throughput.spec.ts`'s header for why, and
 * `timing-criterion.spec.ts` for the guard on the wording. The gate itself,
 * `≥ 40 items/hour sustained by a reviewer`, is **`Fail — blocked`**: no
 * reviewer pool exists (DEC-M4-5).
 *
 * ## Why a p95 and not a mean
 *
 * A mean hides the tail, and the tail is what a reviewer actually notices —
 * one 2-second claim in twenty is the thing that breaks a rhythm, and it
 * disappears into an average that still reads comfortably.
 */

const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'machine-time.json');

/** The budget, from the plan: two orders of magnitude inside the 90 s/item the gate would imply. */
const P95_BUDGET_MS = 300;

let database: TestDatabase;
let fingerprints: PostgresFingerprintRepository;
let assignments: PostgresReviewAssignmentRepository;

const corpus = buildReviewCorpus();
const factsOf = (item: CorpusItem): ItemFingerprintFacts => ({ stem: item.stem, options: item.options });

/**
 * The measurement runs over one subject, because `claimNext` is
 * subject-scoped — a run that spanned subjects would be measuring "how many
 * subjects are there" as much as latency. Physics is the deepest, and the
 * self-authored planted item is in chemistry, so nothing here is skewed by
 * INV-12 rejecting a candidate.
 */
const MEASURED_SUBJECT = 'physics';

async function seed(item: CorpusItem): Promise<void> {
  await database.pool.query(
    `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject, state_entered_at)
     VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', $2, $3)`,
    [item.itemId, item.subject, item.stateEnteredAt],
  );
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', $3::jsonb, $4, 'moderate', 'human', $5)`,
    [
      item.itemVersionId,
      item.itemId,
      JSON.stringify(item.stem),
      normalizedText(factsOf(item)).slice(0, 200),
      item.authorId,
    ],
  );
  await database.pool.query(
    `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
     VALUES ($1, $2, $3, 1, true)`,
    [item.itemVersionId, item.conceptId, CORPUS_TAXONOMY_VERSION_ID],
  );
  const saved = await fingerprints.save({
    itemId: item.itemId,
    itemVersionId: item.itemVersionId,
    subject: item.subject,
    exactHash: exactHash(factsOf(item)),
    skeletonHash: skeletonHash(factsOf(item)),
    normalizedText: normalizedText(factsOf(item)),
    computedAt: CORPUS_NOW,
  });
  if (!saved.ok) throw new Error(`seeding a fingerprint failed: ${saved.error.code}`);
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  fingerprints = new PostgresFingerprintRepository(database.pool);
  assignments = new PostgresReviewAssignmentRepository(database.pool);
  for (const item of corpus.items) await seed(item);
}, 60_000);

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

/** The p95 by nearest-rank — no interpolation, so the reported figure is a sample that actually occurred. */
function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

describe('Tier 1 — machine time for claim → payload → decide (M4-44)', () => {
  it(`keeps the p95 within ${P95_BUDGET_MS} ms and writes the measurement to a file`, async () => {
    const reviewer = { kind: 'human' as const, id: CLAIMING_REVIEWER_ID, roleContext: ['reviewer'] };
    const samples: number[] = [];

    for (let cycle = 0; cycle < CORPUS_SIZE; cycle += 1) {
      const startedAt = performance.now();

      const claimed = await assignments.claimNext({
        subject: MEASURED_SUBJECT,
        reviewer,
        ordering: 'escalated_first',
        now: CORPUS_NOW,
        leaseExpiresAt: corpusInstants.hoursAhead(4),
        escalateAfterHours: CORPUS_REVIEW_POLICY.escalateAfterHours,
      });
      if (!claimed.ok) break;

      // The payload read a reviewer waits on: the version's own row, and the
      // duplicate signal the workspace shows beside it.
      await database.pool.query(
        `SELECT item_version_id, stem_body FROM content.item_version WHERE item_version_id = $1`,
        [claimed.value.itemVersionId],
      );
      await fingerprints.findByItemVersionId(claimed.value.itemVersionId);

      // The decision: the assignment's own transition, which is the write the
      // reviewer's keystroke actually triggers.
      const released = await assignments.release(
        claimed.value.assignmentId,
        CORPUS_NOW,
        claimed.value.aggregateVersion,
      );
      if (!released.ok) break;

      samples.push(performance.now() - startedAt);
    }

    // Non-vacuous: a p95 over three samples is not a p95.
    expect(samples.length).toBeGreaterThanOrEqual(8);

    const measurement = {
      measuredAt: new Date().toISOString(),
      cycles: samples.length,
      subject: MEASURED_SUBJECT,
      corpusSize: CORPUS_SIZE,
      p50Ms: Number(percentile(samples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2)),
      budgetMs: P95_BUDGET_MS,
      measures: 'claim -> payload read -> decide, against real Postgres',
      doesNotMeasure: 'human review throughput; that gate is Fail - blocked, no reviewer pool exists',
    };

    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, `${JSON.stringify(measurement, null, 2)}\n`);

    expect(measurement.p95Ms).toBeLessThanOrEqual(P95_BUDGET_MS);
  }, 120_000);

  it('the file it wrote is readable, and carries a real number', () => {
    const written = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as {
      p95Ms: number;
      cycles: number;
      budgetMs: number;
    };
    expect(written.cycles).toBeGreaterThanOrEqual(8);
    expect(written.p95Ms).toBeGreaterThan(0);
    expect(written.budgetMs).toBe(P95_BUDGET_MS);
  });
});
