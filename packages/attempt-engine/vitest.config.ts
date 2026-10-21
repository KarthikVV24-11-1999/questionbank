import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The barrel re-exports and holds no logic of its own.
      exclude: ['src/**/*.spec.ts', 'src/index.ts', 'src/testing/**'],
      // Every module here decides what a learner's responses are, how long
      // they have left, or what still has to be sent — a bug in any of them
      // loses an answer silently. The 100% rule follows correctness-bearing
      // code (ADR-0008), and in this package that is all of it.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
