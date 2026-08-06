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
