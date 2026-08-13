import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { StudioShell } from './shell/StudioShell.js';
import { useRoute } from './shell/use-route.js';
import { ItemBrowser } from './features/item-browser/ItemBrowser.js';
import { browserSearchParams } from './features/item-browser/item-browser-model.js';
import { createLiveItemBrowserApi } from './features/item-browser/item-browser-api.js';

/**
 * The entry point (M0-15, closes D3). Mounts `StudioShell` and does nothing
 * else it does not have to — no provider tree the app does not yet need.
 * Navigation is real (M0-16, `useRoute`, DEC-M0-13): an unmatched path
 * renders the designed not-found state rather than a blank shell, never a
 * router.
 *
 * **Only Authoring is wired live** (M0-19). Every other enabled destination
 * (Taxonomy, Exams & Forms) still renders its existing in-memory-model
 * feature nowhere — those components exist and are tested, but this milestone
 * wires exactly one surface end to end, by design, and does not silently
 * promote the rest to "live" by routing to them here.
 *
 * **There is no login UI yet.** `readDevToken`/`decodeSubject` below are a
 * named stand-in, not a design: Identity's real token issuance is M8's
 * (DEC-M0-7). A developer sets `localStorage['qb-dev-token']` to a bearer
 * token the M0-05 auth stub issued; nothing here decides who that is.
 */

function readDevToken(): string | null {
  return window.localStorage.getItem('qb-dev-token');
}

function decodeSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(atob(normalized)) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

function App(): JSX.Element {
  const { activeDestinationId, navigate } = useRoute();

  return (
    <StudioShell viewportWidth={window.innerWidth} activeDestinationId={activeDestinationId ?? ''} onNavigate={navigate}>
      {activeDestinationId === 'authoring' ? <Authoring /> : null}
      {activeDestinationId === null ? (
        <div role="alert">
          <h2>Page not found</h2>
          <p>There is nothing here. Use the sidebar to go somewhere that exists.</p>
        </div>
      ) : null}
    </StudioShell>
  );
}

function Authoring(): JSX.Element {
  const token = readDevToken();
  const myPrincipalId = token === null ? null : decodeSubject(token);

  if (myPrincipalId === null) {
    return (
      <p role="alert">
        No developer session token is set. Set <code>localStorage[&apos;qb-dev-token&apos;]</code> to a
        bearer token issued by the auth stub to use Authoring.
      </p>
    );
  }

  const api = createLiveItemBrowserApi({
    baseUrl: window.location.origin,
    getToken: readDevToken,
    myPrincipalId,
  });

  return <ItemBrowser api={api} searchParams={browserSearchParams()} myPrincipalId={myPrincipalId} />;
}

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('main.tsx: #root element is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
