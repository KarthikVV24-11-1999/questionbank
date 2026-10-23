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
      exclude: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'src/testing/**', 'src/main.tsx'],
      /**
       * The overall floor (ENGINEERING-HANDBOOK §5), and 100% on the modules that decide what an attempt is: the session that owns
       * the engine's state, the signature check that stands between a package and the screen, and the cache policy that keeps an
       * event out of any cache. A bug in any of them loses an answer, shows an item nobody vouched for, or serves a stale event.
       * The components decide nothing and are held by their behaviour and an axe scan, not by a percentage.
       */
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
        'src/session/attempt-session.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/session/persistence.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/package/verify.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/package/load.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
      },
    },
  },
});
