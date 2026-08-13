import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { StudioShell } from './StudioShell.js';
import { useRoute } from './use-route.js';

/**
 * DEC-M0-13, M0-16. `useRoute` over the real `window.history` — jsdom
 * implements enough of the History API (`pushState`, `back`, `forward`,
 * `popstate`) that these run against the real thing, not a fake.
 */
beforeEach(() => {
  window.history.replaceState(null, '', '/authoring');
});

afterEach(() => {
  window.history.replaceState(null, '', '/authoring');
});

describe('useRoute', () => {
  it('reads the initial destination off the current path', () => {
    window.history.replaceState(null, '', '/taxonomy');
    const { result } = renderHook(() => useRoute());
    expect(result.current.activeDestinationId).toBe('taxonomy');
  });

  it('navigate pushes history and updates the active destination', () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      result.current.navigate('taxonomy');
    });

    expect(result.current.activeDestinationId).toBe('taxonomy');
    expect(window.location.pathname).toBe('/taxonomy');
  });

  it('navigate to a disabled destination is a no-op', () => {
    const { result } = renderHook(() => useRoute());
    const pathBefore = window.location.pathname;

    act(() => {
      // 'dashboard' exists in the table but is enabled: false.
      result.current.navigate('dashboard');
    });

    expect(window.location.pathname).toBe(pathBefore);
    expect(result.current.activeDestinationId).toBe('authoring');
  });

  it('navigate to a destination not in the table is a no-op', () => {
    const { result } = renderHook(() => useRoute());
    const pathBefore = window.location.pathname;

    act(() => {
      result.current.navigate('does-not-exist');
    });

    expect(window.location.pathname).toBe(pathBefore);
  });

  it('back and forward work over real history, via popstate', async () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      result.current.navigate('taxonomy');
    });
    act(() => {
      result.current.navigate('exams');
    });
    expect(result.current.activeDestinationId).toBe('exams');

    // jsdom fires `popstate` asynchronously after `back()`/`forward()` — not
    // within the same task, so this waits for the real event rather than a
    // fixed delay, with the resulting state update wrapped in `act`.
    await act(
      () =>
        new Promise<void>((resolvePromise) => {
          window.addEventListener('popstate', () => resolvePromise(), { once: true });
          window.history.back();
        }),
    );
    expect(result.current.activeDestinationId).toBe('taxonomy');

    await act(
      () =>
        new Promise<void>((resolvePromise) => {
          window.addEventListener('popstate', () => resolvePromise(), { once: true });
          window.history.forward();
        }),
    );
    expect(result.current.activeDestinationId).toBe('exams');
  });

  it('an unknown path is reported as no active destination, not a fallback guess', () => {
    window.history.replaceState(null, '', '/this-path-matches-nothing');
    const { result } = renderHook(() => useRoute());
    expect(result.current.activeDestinationId).toBeNull();
  });

  // Not the hook's own file, but the pattern every real caller (main.tsx)
  // follows: a null `activeDestinationId` renders a designed state, never a
  // blank shell.
  it('a caller rendering on a null activeDestinationId shows the not-found state, never a blank shell', () => {
    window.history.replaceState(null, '', '/this-path-matches-nothing');

    function Harness() {
      const { activeDestinationId, navigate } = useRoute();
      return (
        <StudioShell viewportWidth={1440} activeDestinationId={activeDestinationId ?? ''} onNavigate={navigate}>
          {activeDestinationId === null ? (
            <div role="alert">
              <h2>Page not found</h2>
            </div>
          ) : (
            <p>a real surface</p>
          )}
        </StudioShell>
      );
    }

    render(<Harness />);
    expect(screen.getByRole('alert')).toHaveTextContent('Page not found');
  });

  // Focus-on-navigation is StudioShell's own behaviour (asserted at M3-39);
  // this proves it survives being driven by real navigation rather than a
  // prop change a test set directly.
  it('focus moves to the main heading when navigate() changes the destination', () => {
    function Harness() {
      const { activeDestinationId, navigate } = useRoute();
      return (
        <StudioShell viewportWidth={1440} activeDestinationId={activeDestinationId ?? ''} onNavigate={navigate}>
          <p>content</p>
        </StudioShell>
      );
    }

    render(<Harness />);
    // StudioShell already moves focus on the initial render (M3-39) — move
    // it away so navigating is what is actually under test here.
    act(() => {
      screen.getByRole('heading', { level: 1 }).blur();
    });
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();

    act(() => {
      screen.getByRole('button', { name: 'Taxonomy' }).click();
    });

    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('imports nothing beyond react and navigation.js — no dependency added', () => {
    const source = readFileSync(resolve('src/shell/use-route.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .*? from '([^']+)';$/gmu)].map((match) => match[1]);
    expect(imports).toEqual(['react', './navigation.js']);
  });

  it('names D30 and the trigger that replaces it', () => {
    const source = readFileSync(resolve('src/shell/use-route.ts'), 'utf8');
    expect(source).toContain('D30');
    expect(source).toMatch(/not a router/iu);
  });
});
