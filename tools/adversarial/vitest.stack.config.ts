import { defineConfig } from 'vitest/config';

/** The one run that needs a booted stack (M8-44): `src/stack-journey.ts`, which the default configuration does not pick up because its name is not a spec's. `infra/compose/boot.mjs` runs it. */
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['src/stack-journey.ts'], fileParallelism: false, testTimeout: 180_000, hookTimeout: 60_000 },
});
