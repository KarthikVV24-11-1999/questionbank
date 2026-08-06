import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Seed specs share the same database as the API integration suite.
    fileParallelism: false,
    include: ['**/*.spec.ts'],
  },
});
