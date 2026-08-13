import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build (M0-15, closes D3). No dev-server proxy, no env injection beyond
 * Vite's own defaults — the walking skeleton needs a build, not a bundler
 * feature list. `sourcemap: false` in production is deliberate: an authoring
 * DTO with the answer key on it (ADR-0009) has no business shipping a map
 * that makes the bundle easier to read.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
  },
});
