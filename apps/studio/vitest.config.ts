import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/testing/setup.ts'],
    include: ['src/**/*.spec.tsx', 'src/**/*.spec.ts'],
  },
});
