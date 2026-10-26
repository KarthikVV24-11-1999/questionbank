import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['src/**/*.spec.ts'], fileParallelism: false, maxConcurrency: 8, globalSetup: ['src/global-setup.ts'], testTimeout: 90_000, hookTimeout: 120_000 },
});
