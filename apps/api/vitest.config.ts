import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration specs share one database and reshape its schema, so no two
    // spec files may run at the same time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/testing/**', 'src/fitness-fixtures/**'],
      // ENGINEERING-HANDBOOK §5: ≥80% line and ≥70% branch overall, and 100%
      // branch on marking. A drop below these fails the build.
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
        'src/contexts/curriculum/domain/value-objects/marking-rule-set.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/curriculum/domain/value-objects/marking-rule-set-hash.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/curriculum/domain/value-objects/marking-rule.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/curriculum/domain/value-objects/award.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/curriculum/domain/value-objects/condition.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        // The 100% rule follows correctness-bearing-ness, not layer
        // (ADR-0008). It covers every module that determines *what* gets
        // scored or *how*: the scoring domain, both repositories, and the
        // application code that resolves which rule set version, item
        // versions and profile version get pinned, plus the authorization
        // that decides whether a re-score runs at all.
        //
        // A bug in any of those yields a correct score computed over the wrong
        // inputs — which looks right, passes review, and is worse than a crash.
        //
        // Excluded: modules that only move a finished result around, and
        // type-only modules, where a threshold would be theatre because there
        // is no runtime code to cover. `scoring-rules.spec.ts` sweeps for any
        // in-scope module missing a threshold.
        'src/contexts/scoring/domain/result.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/scoring-error.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/scoring-input.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/answer-key.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/numeric/normalize.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/numeric/decimal.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/numeric/compare.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/numeric/unit.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/numeric/answer-form.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/marking-rule-data.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/conditions/evaluate-condition.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/awards/apply-award.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/overrides/apply-overrides.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/rule-selection.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/item-outcome.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/curriculum/domain/value-objects/aggregation-spec.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/aggregation-data.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/aggregate-scores.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/score-record.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/score-attempt.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/schema-version-registry.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/rescoring-operation.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/domain/rescoring-dry-run.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/infrastructure/score-record.repository.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/infrastructure/rescoring-operation.repository.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/application/authorization.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/application/handler-registry.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/application/handlers/scoring-handlers.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/application/handlers/rescoring-handlers.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/scoring/application/queries/scoring-queries.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        // Content, under the same ADR-0008 rule. "Correctness-bearing" reads
        // here as *determines what gets published* — a body that validates is
        // a body that can reach a student, and a defect in this validator is
        // an unrenderable item on one of four surfaces, or an equation with no
        // reading order. Thresholds land with the module, never after it.
        'src/contexts/content/application/answer-key-projection.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/application/final-answer-agreement.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/events/content-events.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/infrastructure/media-asset.repository.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/infrastructure/solution.repository.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/infrastructure/stimulus.repository.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/infrastructure/item.repository.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/content-error.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/content-body.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/content-body-projections.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/item.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/item-lifecycle.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/item-version.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/licensing-status.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/locale-variant.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/media-asset.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/pre-submission-validation.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/provenance.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/publication-preconditions.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/response-specification.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/solution.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/stimulus.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
        'src/contexts/content/domain/taxonomy-tag.ts': {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.integration.spec.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          include: ['src/**/*.integration.spec.ts'],
          // Integration specs share one database and reshape its schema, so
          // they run one file at a time, in one worker.
          sequence: { concurrent: false },
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
