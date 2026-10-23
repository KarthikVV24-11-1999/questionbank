import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build. `sourcemap: false` in production is deliberate, as in Studio: nothing here holds an answer key (that is
 * the point of the app), but a map makes the bundle easier to read for no benefit to a learner.
 *
 * `public/sw.js` is copied as it stands: the service worker is plain JavaScript on purpose, so that the file the
 * browser runs is the file the spec runs (see `src/sw/service-worker.spec.ts`), not a build's rendering of it.
 */
export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false },
});
