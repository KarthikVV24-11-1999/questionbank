import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { DESTINATIONS, filterDestinations, type Destination } from './navigation.js';
import { ViewportGate } from './viewport-gate.js';

/**
 * The Studio shell: persistent left sidebar, command palette, viewport gate
 * (FRONTEND §2, DEC-5, debt D3).
 *
 * **No `main.tsx`, no Vite dev server, no router dependency.** The destination
 * a caller is on is a prop, and changing it is a callback — so the shell is a
 * pure function of its inputs and testable in jsdom, exactly as M1's Studio
 * features are. When there is an application to route, the router reads the
 * same table and calls the same callback.
 *
 * **Focus moves to the main heading on destination change** (FRONTEND §10).
 * Without it a screen-reader user is stranded: the sidebar item they activated
 * still holds focus, and nothing announces that the whole page changed.
 */

export interface StudioShellProps {
  readonly viewportWidth: number;
  readonly activeDestinationId: string;
  readonly onNavigate: (destinationId: string) => void;
  readonly children: ReactNode;
}

function isEnabled(destination: Destination): boolean {
  return destination.enabled;
}

export function StudioShell(props: StudioShellProps): JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState('');
  const paletteInputId = useId();

  const active = DESTINATIONS.find((destination) => destination.id === props.activeDestinationId);

  // On every destination change, not only on the first render: a screen-reader
  // user who activates a sidebar item must land on the new page's heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, [props.activeDestinationId]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === 'Escape') closePalette();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closePalette]);

  const navigate = useCallback(
    (destination: Destination): void => {
      if (!isEnabled(destination)) return;
      closePalette();
      props.onNavigate(destination.id);
    },
    [closePalette, props],
  );

  return (
    <ViewportGate width={props.viewportWidth}>
      <div className="qb-studio-shell">
        <nav className="qb-studio-sidebar" aria-label="Studio sections">
          <ul>
            {DESTINATIONS.map((destination) => (
              <li key={destination.id}>
                <button
                  type="button"
                  // Disabled destinations stay in the tab order and announce
                  // *why*: a control that vanishes from the keyboard is one a
                  // keyboard user cannot discover exists.
                  aria-disabled={destination.enabled ? undefined : true}
                  aria-current={destination.id === props.activeDestinationId ? 'page' : undefined}
                  aria-describedby={
                    destination.pendingReason === undefined ? undefined : `${destination.id}-pending`
                  }
                  onClick={() => navigate(destination)}
                >
                  {destination.label}
                </button>
                {destination.pendingReason === undefined ? null : (
                  <span id={`${destination.id}-pending`} className="qb-studio-sidebar__pending">
                    {destination.pendingReason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <main className="qb-studio-main">
          <h1 ref={headingRef} tabIndex={-1}>
            {active?.label ?? 'Studio'}
          </h1>
          {props.children}
        </main>

        {paletteOpen ? (
          <div className="qb-command-palette" role="dialog" aria-label="Command palette" aria-modal="true">
            <label htmlFor={paletteInputId}>Go to</label>
            <input
              id={paletteInputId}
              type="text"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul>
              {filterDestinations(query).map((destination) => (
                <li key={destination.id}>
                  <button
                    type="button"
                    aria-disabled={destination.enabled ? undefined : true}
                    onClick={() => navigate(destination)}
                  >
                    {destination.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </ViewportGate>
  );
}
