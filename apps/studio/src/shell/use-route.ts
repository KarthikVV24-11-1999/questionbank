import { useCallback, useEffect, useState } from 'react';
import { DESTINATIONS, destinationById, type Destination } from './navigation.js';

/**
 * Navigation over the History API (DEC-M0-13) — turns `navigation.ts`'s
 * typed route table into working back/forward without a router. **This is
 * not a router**: no nested layouts, no loaders, no code splitting, no
 * validated search state. It is deliberately small enough to delete in an
 * afternoon, and the route table is already the shape TanStack Router
 * consumes, so the eventual replacement is a swap, not a rewrite. Debt
 * **D30**, trigger: the first nested route, or the first surface needing
 * validated search state beyond M3-43's URL filters.
 *
 * **No dependency added.** Only `react` and `./navigation.js` are imported —
 * asserted in `use-route.spec.tsx` so this file cannot quietly grow one.
 *
 * A destination not in the table, or one that is `enabled: false`, cannot be
 * navigated to: `navigate` is a no-op for either. The current path failing to
 * match any destination's `path` is a *different* case — the user typed or
 * followed a bad URL — and is reported as `activeDestinationId: null` rather
 * than silently falling back to some default, so the caller can render the
 * designed not-found state instead of a blank shell.
 */
export interface UseRouteResult {
  /** `null` when the current path matches no destination — render `NotFoundView`. */
  readonly activeDestinationId: string | null;
  readonly navigate: (destinationId: string) => void;
}

function destinationForPath(path: string): Destination | undefined {
  return DESTINATIONS.find((destination) => destination.path === path);
}

export function useRoute(): UseRouteResult {
  const [path, setPath] = useState(() => window.location.pathname);

  // Back and forward both fire `popstate`; there is nothing else to trap —
  // `navigate` below already updates `path` synchronously with the push, so
  // this effect only ever needs to catch history moves this hook did not
  // itself cause.
  useEffect(() => {
    const onPopState = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((destinationId: string): void => {
    const destination = destinationById(destinationId);
    if (destination === undefined || !destination.enabled) return;
    window.history.pushState(null, '', destination.path);
    setPath(destination.path);
  }, []);

  return {
    activeDestinationId: destinationForPath(path)?.id ?? null,
    navigate,
  };
}
