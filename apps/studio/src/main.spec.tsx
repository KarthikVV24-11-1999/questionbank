import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `main.tsx` runs its `createRoot(...).render(...)` call as a side effect of
 * being imported — the same thing `index.html`'s `<script type="module"
 * src="/src/main.tsx">` triggers. `vi.resetModules()` plus a dynamic
 * `import()` per test is what lets this spec import the real file twice
 * (missing-root, then present-root) rather than duplicating its JSX.
 */
describe('main.tsx — the mounted tree', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('throws with a clear message when #root is missing from the document', async () => {
    await expect(import('./main.js')).rejects.toThrow(/#root element is missing/u);
  });

  it('mounts cleanly into a real #root element', async () => {
    // jsdom's default `innerWidth` (1024) is below the 1280px gate
    // `ViewportGate` enforces (FRONTEND §2) — widened here so this test
    // exercises the mounted shell, not the gate's own alert.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });

    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await expect(import('./main.js')).resolves.toBeDefined();

    // `createRoot(...).render(...)` commits on a microtask, not
    // synchronously with import — the same reason `main.tsx` never awaits it
    // itself.
    await vi.waitFor(() => {
      expect(root.querySelector('.qb-studio-shell')).not.toBeNull();
    });
  });
});
