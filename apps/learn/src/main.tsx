import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@questionbank/contracts/client';
import { DEFAULT_SYNC_POLICY, type SessionPorts } from './session/ports.js';
import { createAssessmentApi } from './api/assessment-api.js';
import { boot } from './bootstrap.js';
import { registerServiceWorker } from './sw/register.js';
import { Root } from './ui/Root.js';

/**
 * The entry point (M6-46). A sitting is opened with `?form=<id>&session=<ref>`; there is no login UI yet — as in Studio, a developer sets
 * `localStorage['qb-dev-token']` to a bearer token, and real sign-in is M8's (debt D69). What it wires is the real clock (`performance.now`, which is
 * monotonic), the real disk (`localStorage`), and the real network (through the typed client).
 */
const params = new URLSearchParams(window.location.search);
const formId = params.get('form');
const sessionRef = params.get('session');

const client = createClient({ baseUrl: window.location.origin, getToken: () => window.localStorage.getItem('qb-dev-token') });
const api = createAssessmentApi(client);
const ports: SessionPorts = {
  clock: { now: () => performance.now() },
  transport: api,
  storage: window.localStorage,
  newId: () => crypto.randomUUID(),
  syncPolicy: DEFAULT_SYNC_POLICY,
};

let registration: { update(): Promise<unknown> } | null = null;
void registerServiceWorker(navigator.serviceWorker, '/sw.js').then((r) => (registration = r));

function App(): JSX.Element {
  if (formId === null || sessionRef === null) return <p role="alert">Open this page from your exam link.</p>;
  return (
    <Root
      boot={() => boot({ api, ports, formId, sessionRef, deviceRef: window.localStorage.getItem('qb-device') ?? 'device', idempotencyKey: `begin-${formId}-${sessionRef}` })}
      every={(ms, fn) => {
        const handle = window.setInterval(fn, ms);
        return () => window.clearInterval(handle);
      }}
      onOnline={(fn) => {
        window.addEventListener('online', fn);
        return () => window.removeEventListener('online', fn);
      }}
      onUpdateWanted={() => void registration?.update()}
    />
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('main.tsx: #root element is missing from index.html');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
