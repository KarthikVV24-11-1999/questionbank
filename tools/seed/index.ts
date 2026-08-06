import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PrincipalRef } from '@questionbank/domain-types';
import { DrizzleConceptIdentityRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/taxonomy-version.repository.js';
import { DrizzleExamRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/exam-profile-version.repository.js';
import { loadTaxonomyFile } from './taxonomy-loader.js';
import { loadProfileFile } from './profile-loader.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'data');

/** The machine principal every seeded publication is attributed to (D10). */
export const SEED_PRINCIPAL: PrincipalRef = {
  kind: 'system',
  id: '00000000-0000-0000-0000-0000000000se'.replace('se', '01'),
  roleContext: ['content_ops', 'exam_owner', 'curriculum_curator'],
};

const SEED_INSTANT = new Date('2026-08-05T00:00:00.000Z');

/**
 * Ids are derived from stable keys, so seeding twice produces the same rows
 * and the second run is a no-op.
 */
export function derivedIdentifier(kind: string, key: string): string {
  const digest = createHash('sha256').update(`${kind}:${key}`).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `7${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export interface SeedSummary {
  readonly taxonomies: ReadonlyArray<{ readonly file: string; readonly concepts: number; readonly unchanged: boolean }>;
  readonly profiles: ReadonlyArray<{ readonly file: string; readonly code: string; readonly unchanged: boolean }>;
  readonly durationMs: number;
}

const TAXONOMIES = ['jee-main-2026.taxonomy.yaml', 'neet-ug-2026.taxonomy.yaml'] as const;
const PROFILES = ['jee-main-2026.profile.yaml', 'neet-ug-2026.profile.yaml'] as const;

/**
 * Loads every taxonomy, publishes it, then loads and publishes every profile.
 * Safe to re-run: each loader reports `unchanged` when the data is already there.
 */
export async function seed(db: NodePgDatabase): Promise<SeedSummary> {
  const startedAt = Date.now();
  const versions = new DrizzleTaxonomyVersionRepository(db);
  const identities = new DrizzleConceptIdentityRepository(db);
  const exams = new DrizzleExamRepository(db);
  const profiles = new DrizzleExamProfileVersionRepository(db);

  const taxonomySummaries: Array<{ file: string; concepts: number; unchanged: boolean }> = [];
  for (const file of TAXONOMIES) {
    const contents = readFileSync(join(DATA, file), 'utf8');
    const loaded = await loadTaxonomyFile(contents, { versions, identities, identifierFor: derivedIdentifier });
    if (!loaded.ok) {
      throw new Error(`seed failed on ${file}: ${JSON.stringify(loaded.issues.slice(0, 3))}`);
    }

    const stored = await versions.findById(loaded.report.taxonomyVersionId);
    if (!stored.ok) throw new Error(`seed failed: ${file} did not persist`);

    if (stored.value.aggregate.state === 'draft') {
      const published = stored.value.aggregate.publish(SEED_PRINCIPAL, SEED_INSTANT);
      if (!published.ok) throw new Error(`seed failed publishing ${file}: ${published.error.message}`);
      const saved = await versions.update(published.value, stored.value.aggregateVersion);
      if (!saved.ok) throw new Error(`seed failed saving ${file}: ${saved.error.message}`);
    }

    taxonomySummaries.push({
      file,
      concepts: loaded.report.conceptCount,
      unchanged: loaded.report.unchanged,
    });
  }

  const profileSummaries: Array<{ file: string; code: string; unchanged: boolean }> = [];
  for (const file of PROFILES) {
    const contents = readFileSync(join(DATA, file), 'utf8');
    const loaded = await loadProfileFile(contents, {
      exams,
      profiles,
      versions,
      identifierFor: derivedIdentifier,
      publishedBy: SEED_PRINCIPAL,
      publishedAt: SEED_INSTANT,
    });
    if (!loaded.ok) {
      throw new Error(`seed failed on ${file}: ${JSON.stringify(loaded.issues.slice(0, 3))}`);
    }

    profileSummaries.push({
      file,
      code: file.split('.')[0] ?? file,
      unchanged: loaded.report.unchanged,
    });
  }

  return {
    taxonomies: taxonomySummaries,
    profiles: profileSummaries,
    durationMs: Date.now() - startedAt,
  };
}

/** Defaults to the port the Compose stack publishes; override with DATABASE_URL. */
export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/questionbank';

/** `pnpm seed` entry point. */
export async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const summary = await seed(drizzle(pool));
    for (const taxonomy of summary.taxonomies) {
      process.stdout.write(
        `${taxonomy.unchanged ? 'unchanged' : 'loaded   '} ${taxonomy.file} (${taxonomy.concepts} concepts)\n`,
      );
    }
    for (const profile of summary.profiles) {
      process.stdout.write(`${profile.unchanged ? 'unchanged' : 'published'} ${profile.file}\n`);
    }
    process.stdout.write(`seed completed in ${(summary.durationMs / 1000).toFixed(1)}s\n`);
  } finally {
    await pool.end();
  }
}
