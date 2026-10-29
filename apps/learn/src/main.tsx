import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@questionbank/contracts/client';
import { DEFAULT_SYNC_POLICY, type SessionPorts } from './session/ports.js';
import { createAssessmentApi } from './api/assessment-api.js';
import { createLearningApi } from './api/learning-api.js';
import { boot } from './bootstrap.js';
import { activeAttemptId } from './session/persistence.js';
import { registerServiceWorker } from './sw/register.js';
import { warmPackageCache } from './sw/warm-package.js';
import { HomeScreen } from './ui/HomeScreen.js';
import { PracticeScreen } from './ui/PracticeScreen.js';
import { ReportScreen } from './ui/ReportScreen.js';
import { Root } from './ui/Root.js';
import type { ScreenContext } from './ui/screen-context.js';

/**
 * The entry point (M6-46). A sitting is opened with `?form=<id>&session=<ref>`; there is no login UI yet — as in Studio, a developer sets
 * `localStorage['qb-dev-token']` to a bearer token, and real sign-in is M8's (debt D69). What it wires is the real clock (`performance.now`, which is
 * monotonic), the wall clock (`Date.now`, read only to take the offset to the server's clock), the real disk (`localStorage`), and the real network (through the typed client).
 */
const params = new URLSearchParams(window.location.search);
const formId = params.get('form');
const sessionRef = params.get('session');

const client = createClient({ baseUrl: window.location.origin, getToken: () => window.localStorage.getItem('qb-dev-token') });
const api = createAssessmentApi(client);
const learning = createLearningApi(client);
/**
 * Where the page was opened (D88): the exam profile and taxonomy come in the address, as the form and the session do, until a route offers them; the last sitting
 * is the one this device wrote down; and one key stands for every try of a tap on this page.
 */
const screenContext: ScreenContext = {
  examProfileVersionId: params.get('profile'),
  taxonomyVersionId: params.get('taxonomy'),
  lastAttemptId: activeAttemptId(window.localStorage),
  pageKey: crypto.randomUUID(),
};
const open = (href: string): void => window.location.assign(href);
const ports: SessionPorts = {
  clock: { now: () => performance.now() },
  wall: { now: () => Date.now() },
  transport: api,
  storage: window.localStorage,
  newId: () => crypto.randomUUID(),
  syncPolicy: DEFAULT_SYNC_POLICY,
};

let registration: { update(): Promise<unknown> } | null = null;
// Whether a worker already controlled this page: if not, this is a first visit, and the package is put in the worker's cache by the page (DEC-M7-35).
const controlledAtLoad = navigator.serviceWorker?.controller != null;
void registerServiceWorker(navigator.serviceWorker, '/sw.js').then((r) => {
  registration = r;
  if (r !== null && formId !== null) {
    void warmPackageCache({ controlledAtLoad, origin: window.location.origin, cacheStorage: window.caches, request: (path) => client.requestBytes({ path }) }, formId);
  }
});

function App(): JSX.Element {
  const reportOf = params.get('report');
  const practiceOf = params.get('practice');
  if (formId !== null && sessionRef !== null) {
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
  if (formId !== null || sessionRef !== null) return <p role="alert">Open this page from your exam link.</p>;
  if (reportOf !== null) return <ReportScreen learning={learning} assessment={api} attemptId={reportOf} context={screenContext} onOpen={open} />;
  if (practiceOf !== null) return <PracticeScreen assessment={api} attemptId={practiceOf} context={screenContext} />;
  return <HomeScreen learning={learning} assessment={api} context={screenContext} onOpen={open} />;
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('main.tsx: #root element is missing from index.html');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
