import { Pool } from 'pg';
import { itemContent, publishItem } from '../../apps/api/src/testing/content-publishing.js';

/**
 * Demo questions for a staging stack (M8-40): a handful of published items on topics of the seeded JEE syllabus, so that a learner who has chosen JEE Main and said which chapters they have studied can be given a diagnostic.
 * `pnpm seed` loads the syllabus and the exam profiles and no questions at all; the content blocker (B1) is about licensed papers and does not apply to questions written for a demonstration, which are nonsense on purpose and say so.
 *
 * They go through content's own handlers (draft, solution, review, publish), by the helper the API's specs publish through, so what is in the catalogue is what an author would have made. Every item is a single-choice question whose
 * right answer is option b. Safe to run twice: it does nothing where the syllabus already has items on the topics it picks.
 */
const TOPICS_PER_RUN = 6;
const ITEMS_PER_TOPIC = 3;

export async function seedDemoItems(pool: Pool): Promise<{ readonly topics: number; readonly items: number; readonly unchanged: boolean }> {
  const version = await pool.query<{ taxonomy_version_id: string }>(
    `SELECT taxonomy_version_id FROM curriculum.taxonomy_version WHERE exam_family = 'JEE' AND state = 'published' ORDER BY academic_year DESC LIMIT 1`,
  );
  const taxonomyVersionId = version.rows[0]?.taxonomy_version_id;
  if (taxonomyVersionId === undefined) throw new Error('there is no published JEE syllabus: run `pnpm seed` first');

  // one topic from each of six physics chapters, so a diagnostic has several to spread across
  const topics = await pool.query<{ concept_identity_id: string; display_name: string }>(
    `SELECT DISTINCT ON (c.concept_node_id) n.concept_identity_id, n.display_name
       FROM curriculum.concept_node n
       JOIN curriculum.concept_node c ON c.concept_node_id = n.parent_node_id
       JOIN curriculum.concept_node r ON r.concept_node_id = c.parent_node_id
      WHERE n.taxonomy_version_id = $1 AND r.display_name = 'Physics' AND n.depth = 2
      ORDER BY c.concept_node_id, n.display_name`,
    [taxonomyVersionId],
  );
  const chosen = [...topics.rows].sort((a, b) => (a.display_name < b.display_name ? -1 : 1)).slice(0, TOPICS_PER_RUN);
  const existing = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM content.item_taxonomy_tag WHERE taxonomy_version_id = $1 AND concept_identity_id = ANY($2::uuid[])', [
    taxonomyVersionId,
    chosen.map((topic) => topic.concept_identity_id),
  ]);
  if (Number(existing.rows[0]?.n ?? 0) > 0) return { topics: chosen.length, items: 0, unchanged: true };

  let items = 0;
  for (const topic of chosen) {
    for (let n = 1; n <= ITEMS_PER_TOPIC; n += 1) {
      const content = itemContent(`Demonstration question ${n} on ${topic.display_name}. This question is made up for a demonstration; choose option b.`);
      await publishItem(pool, { ...content, taxonomyTags: [{ conceptIdentityId: topic.concept_identity_id, taxonomyVersionId, weight: 1, isPrimary: true }] });
      items += 1;
    }
  }
  return { topics: chosen.length, items, unchanged: false };
}

export async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/questionbank' });
  try {
    const done = await seedDemoItems(pool);
    process.stdout.write(done.unchanged ? `unchanged: the syllabus already has questions on ${done.topics} topics\n` : `published ${done.items} demonstration questions on ${done.topics} topics\n`);
  } finally {
    await pool.end();
  }
}
