import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import * as contentComposition from '../../contexts/content/public/composition.js';
import * as curriculumComposition from '../../contexts/curriculum/public/composition.js';
import * as generationComposition from '../../contexts/generation/public/composition.js';
import { InMemoryIdempotencyStore } from '../../contexts/content/application/ports.js';
import { createMediaStore } from '../persistence/filesystem-media-store.js';

/**
 * What a context's composition seam offers generation is the whole of what generation
 * may do to it (M5-37, ADR-0027). Asserted as sets against literals, so adding a
 * fourth content handler — a deliberate change to what generation may do to content —
 * is a failing test and a reviewed edit, and not a line in a diff.
 */
const pool = {} as Pool;
const clock = { now: () => new Date('2026-10-16T00:00:00.000Z') };
const identifiers = { next: () => 'id-1' };
const audit = { record: async () => undefined };
const principals = { resolve: () => null };

describe('what content offers generation', () => {
  const offered = contentComposition.contentForGeneration({
    pool,
    clock,
    identifiers,
    audit,
    principals,
    mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
    idempotency: new InMemoryIdempotencyStore(),
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
  });

  it('is exactly three handlers and a pure validator', () => {
    expect(Object.keys(offered).sort()).toEqual(['createDraft', 'duplicatesForProposal', 'submitForReview', 'validateProposal']);
  });

  it('the handlers are the ones named, each with its own authorization policy', () => {
    expect([offered.createDraft.name, offered.submitForReview.name, offered.duplicatesForProposal.name]).toEqual([
      'CreateItemDraft',
      'SubmitItemForReview',
      'GetDuplicateCandidatesForProposal',
    ]);
    for (const handler of [offered.createDraft, offered.submitForReview, offered.duplicatesForProposal]) {
      expect(handler.policy.allowedRoles.length, handler.name).toBeGreaterThan(0);
    }
  });

  it('a composition module exports its register, its seam for generation, and nothing else at runtime', () => {
    expect(Object.keys(contentComposition).sort()).toEqual(['contentForGeneration', 'register']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => contentComposition.contentForGeneration({ pool } as never)).toThrow(/missing required dependency/u);
  });
});

describe('what curriculum offers generation', () => {
  const offered = curriculumComposition.curriculumForGeneration({ pool, clock, identifiers, audit, principals });

  it('is exactly one query', () => {
    expect(Object.keys(offered)).toEqual(['taxonomyVersion']);
    expect(offered.taxonomyVersion.name).toBe('GetTaxonomyVersion');
    expect(offered.taxonomyVersion.policy.allowedRoles).toContain('generation_pipeline');
  });

  it('a composition module exports its register, its seam for generation, its in-memory executor, and nothing else at runtime', () => {
    expect(Object.keys(curriculumComposition).sort()).toEqual(['InMemoryMigrationExecutor', 'curriculumForGeneration', 'register']);
  });
});

describe('generation’s own composition', () => {
  it('exports its register and nothing else at runtime', () => {
    expect(Object.keys(generationComposition)).toEqual(['register']);
  });
});
