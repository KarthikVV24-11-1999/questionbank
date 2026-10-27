import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import * as contentComposition from '../../contexts/content/public/composition.js';
import * as curriculumComposition from '../../contexts/curriculum/public/composition.js';
import * as assessmentComposition from '../../contexts/assessment/public/composition.js';
import * as learningComposition from '../../contexts/learning/public/composition.js';
import * as scoringComposition from '../../contexts/scoring/public/composition.js';
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

  it('a composition module exports its register, its seams for generation and assessment, its scheduled jobs, and nothing else at runtime', () => {
    expect(Object.keys(contentComposition).sort()).toEqual(['contentForAssessment', 'contentForGeneration', 'contentForLearning', 'contentJobs', 'register']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => contentComposition.contentForGeneration({ pool } as never)).toThrow(/missing required dependency/u);
  });
});

describe('what content offers assessment (M6-14, M6-17)', () => {
  const offered = contentComposition.contentForAssessment({
    pool,
    clock,
    identifiers,
    audit,
    principals,
    mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
    idempotency: new InMemoryIdempotencyStore(),
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
  });

  it('is exactly five handlers: the catalogue, the duplicate candidates, the two version reads and the answer keys for scoring', () => {
    expect(Object.keys(offered).sort()).toEqual(['answerKeys', 'duplicates', 'itemVersion', 'listCatalogue', 'stimulusVersion']);
    expect([offered.listCatalogue.name, offered.duplicates.name, offered.itemVersion.name, offered.stimulusVersion.name, offered.answerKeys.name]).toEqual([
      'ListPublishedCatalogue',
      'GetDuplicateCandidates',
      'GetPublishedItemVersion',
      'GetPublishedStimulusVersion',
      'GetAnswerKeysForScoring',
    ]);
  });

  it('admits the system to all five, a learner only to the two reads of a delivered version, and the answer keys to the system and no one else', () => {
    for (const handler of [offered.listCatalogue, offered.duplicates, offered.itemVersion, offered.stimulusVersion]) {
      expect(handler.policy.allowedRoles, handler.name).toContain('system');
    }
    expect(offered.listCatalogue.policy.allowedRoles).not.toContain('learner');
    expect(offered.duplicates.policy.allowedRoles).not.toContain('learner');
    expect(offered.itemVersion.policy.allowedRoles).toContain('learner');
    expect(offered.stimulusVersion.policy.allowedRoles).toContain('learner');
    expect(offered.answerKeys.policy.allowedRoles).toEqual(['system']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => contentComposition.contentForAssessment({ pool } as never)).toThrow(/missing required dependency/u);
  });
});

describe('what curriculum offers generation', () => {
  const offered = curriculumComposition.curriculumForGeneration({ pool, clock, identifiers, audit, principals });

  it('is exactly one query', () => {
    expect(Object.keys(offered)).toEqual(['taxonomyVersion']);
    expect(offered.taxonomyVersion.name).toBe('GetTaxonomyVersion');
    expect(offered.taxonomyVersion.policy.allowedRoles).toContain('generation_pipeline');
  });

  it('a composition module exports its register, its two seams, its in-memory executor, and nothing else at runtime', () => {
    expect(Object.keys(curriculumComposition).sort()).toEqual(['InMemoryMigrationExecutor', 'curriculumForAssessment', 'curriculumForGeneration', 'register']);
  });
});

describe('what curriculum offers assessment', () => {
  const offered = curriculumComposition.curriculumForAssessment({ pool, clock, identifiers, audit, principals });

  it('is exactly two reads — the pins an attempt copies, for learners among others, and the scoring rules, for the system — and no command', () => {
    expect(Object.keys(offered).sort()).toEqual(['examProfilePins', 'scoringSpec']);
    expect([offered.examProfilePins.name, offered.scoringSpec.name]).toEqual(['GetExamProfilePins', 'GetExamProfileScoringSpec']);
    expect(offered.examProfilePins.policy.allowedRoles).toContain('learner');
    expect(offered.examProfilePins.policy.allowedRoles).not.toContain('generation_pipeline');
    // the marking rules are for scoring's consumer: the system's alone
    expect(offered.scoringSpec.policy.allowedRoles).toEqual(['system']);
  });
});

describe('generation’s own composition', () => {
  it('exports its register and nothing else at runtime', () => {
    expect(Object.keys(generationComposition)).toEqual(['register']);
  });
});

describe('what content offers learning (M7-03)', () => {
  const offered = contentComposition.contentForLearning({
    pool,
    clock,
    identifiers,
    audit,
    principals,
    mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
    idempotency: new InMemoryIdempotencyStore(),
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
  });

  it('is exactly one read, the system\'s alone, and no command', () => {
    expect(Object.keys(offered)).toEqual(['taxonomyForItemVersions']);
    expect(offered.taxonomyForItemVersions.name).toBe('GetVersionTaxonomy');
    expect(offered.taxonomyForItemVersions.policy.allowedRoles).toEqual(['system']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => contentComposition.contentForLearning({ pool } as never)).toThrow(/missing required dependency/u);
  });
});

describe('what assessment offers learning (M7-11)', () => {
  const offered = assessmentComposition.assessmentForLearning({ pool });

  it('is exactly one read, the system\'s alone, and no command', () => {
    expect(Object.keys(offered)).toEqual(['responseTimings']);
    expect(offered.responseTimings.name).toBe('GetResponseTimings');
    expect(offered.responseTimings.policy.allowedRoles).toEqual(['system']);
  });

  it('a composition module exports its register, its consumers and jobs, and its one seam for learning', () => {
    expect(Object.keys(assessmentComposition).sort()).toEqual(['assessmentConsumers', 'assessmentForLearning', 'assessmentJobs', 'register']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => assessmentComposition.assessmentForLearning({} as never)).toThrow(/missing required dependency/u);
  });
});

describe('what scoring offers learning (M7-02)', () => {
  const offered = scoringComposition.scoringForLearning({ pool, clock, identifiers, audit, principals });

  it('is exactly one read, the system\'s alone, and no command', () => {
    expect(Object.keys(offered)).toEqual(['outcomesForAttempt']);
    expect(offered.outcomesForAttempt.name).toBe('GetAttemptOutcomes');
    expect(offered.outcomesForAttempt.policy.allowedRoles).toEqual(['system']);
  });

  it('a composition module exports its register and its two seams, and nothing else at runtime', () => {
    expect(Object.keys(scoringComposition).sort()).toEqual(['register', 'scoringForAssessment', 'scoringForLearning']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => scoringComposition.scoringForLearning({ pool } as never)).toThrow(/missing required dependency/u);
  });
});

describe('learning’s own composition (M7-04, M7-16)', () => {
  it('offers the one constructor and the vocabulary the root checks against, and the recorder the relay\'s consumer calls, and no route', () => {
    expect(Object.keys(learningComposition).sort()).toEqual(['EVIDENCE_OUTCOMES', 'createMasteryEvidence', 'learningForRelay']);
  });

  it('offers exactly one handler to the relay, the system\'s alone', () => {
    const offered = learningComposition.learningForRelay({ pool, clock, identifiers });
    expect(Object.keys(offered)).toEqual(['recordEvidence']);
    expect(offered.recordEvidence.name).toBe('RecordMasteryEvidence');
    expect(offered.recordEvidence.policy.allowedRoles).toEqual(['system']);
  });

  it('refuses a seam built without a dependency, as register does', () => {
    expect(() => learningComposition.learningForRelay({ pool } as never)).toThrow(/missing required dependency/u);
  });
});
