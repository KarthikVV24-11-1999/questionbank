import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/testing/setup.ts'],
    include: ['src/**/*.spec.tsx', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'src/testing/**'],
      /**
       * ENGINEERING-HANDBOOK §5's overall floor.
       *
       * **No 100% module here, and that is the ADR-0008 rule rather than an
       * omission.** The threshold follows correctness-bearing-ness, and this
       * app decides nothing: the answer key is *edited* in the Studio and
       * *judged* in the domain, which is why the item editor reads
       * `maySubmit` instead of recomputing it. A 100% gate on a surface that
       * settles no question buys coverage theatre, and the checks that matter
       * here are the ones a percentage cannot express — the key-boundary scan,
       * the render parity assertion, and the axe scan on every surface.
       */
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
  },
});
