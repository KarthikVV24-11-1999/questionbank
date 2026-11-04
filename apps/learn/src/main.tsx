import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@questionbank/contracts/client';
import { DEFAULT_SYNC_POLICY, type SessionPorts } from './session/ports.js';
import { createAnalytics } from './analytics/emitter.js';
import { createAnalyticsApi } from './api/analytics-api.js';
import { createAssessmentApi } from './api/assessment-api.js';
import pkg from '../package.json';
import { createLearningApi, createProfileApi } from './api/learning-api.js';
import { NO_DRAFTS, sendDraft } from './onboarding/draft.js';
import { sentDraft } from './onboarding/onboarding-events.js';
import { boot, bootPractice } from './bootstrap.js';
import { openDraftStore, openRecordStore, unavailableRecordStore } from './session/idb-record-store.js';
import { createClockFacts } from './session/clock-facts.js';
import { loadRecord, migrateLegacy } from './session/persistence.js';
import { registerServiceWorker } from './sw/register.js';
import { warmPackageCache } from './sw/warm-package.js';
import { withinTime } from './api/within-time.js';
import { createVerdictReporter } from './practice/verdict-events.js';
import { ConceptMapScreen } from './ui/ConceptMapScreen.js';
import { TopicScreen } from './ui/TopicScreen.js';
import { HomeScreen } from './ui/HomeScreen.js';
import { OnboardingScreen } from './ui/OnboardingScreen.js';
import { PracticeScreen } from './ui/PracticeScreen.js';
import { ReportScreen } from './ui/ReportScreen.js';
import { Root } from './ui/Root.js';
import type { ScreenContext } from './ui/screen-context.js';

/**
 * The entry point (M6-46). A sitting is opened with `?form=<id>&session=<ref>`; there is no login UI yet — as in Studio, a developer sets
 * `localStorage['qb-dev-token']` to a bearer token, and real sign-in is M8's (debt D69). What it wires is the real clock (`performance.now`, which is
 * monotonic), the wall clock (`Date.now`, read only to take the offset to the server's clock), the real disk (IndexedDB for the response log, M8-15; `localStorage` for the
 * small things), and the real network (through the typed client).
 *
 * The response log is opened, and anything an earlier build left in `localStorage` is moved into it, before the page renders: a learner partway through an attempt when the new build
 * loads has their answers in one place or the other, and this is the step that makes it the new one without losing them. A browser that will not give a store gets one that says so.
 */
const records = await openRecordStore(window.indexedDB).catch((reason: unknown) => unavailableRecordStore(reason));
await migrateLegacy({ getItem: (key) => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: (key) => window.localStorage.removeItem(key), keys: () => Object.keys(window.localStorage) }, records).catch(() => 0);
const activeId = await records.active().catch(() => null);
const lastRecord = activeId === null ? null : await loadRecord(records, activeId).catch(() => null);
/** The offset to the server's clock the last contact took: read once from the disk, then kept current by the session as it takes a fresher one. */
const clockFacts = createClockFacts(lastRecord);
const params = new URLSearchParams(window.location.search);
const formId = params.get('form');
const sessionRef = params.get('session');

const client = createClient({ baseUrl: window.location.origin, getToken: () => window.localStorage.getItem('qb-dev-token') });
const api = createAssessmentApi(client);
const learning = createLearningApi(client);
const profiles = createProfileApi(client);
/** What the learner has said in onboarding and the server has not heard, on the same disk as the response log. A browser that will not give one keeps nothing, and the screen says so by failing to save. */
const drafts = await openDraftStore(window.indexedDB).catch(() => NO_DRAFTS);
/**
 * Where the page was opened: the last sitting is the one this device wrote down, and one key stands for every try of a tap on this page. Which exam the learner chose, and its syllabus, are the learner's profile and
 * are read from the server (D88); the address says which screen, and which form and session for a paper.
 */
/** The platform tenant (P7); one until there are others. */
const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
const connection = (navigator as Navigator & { connection?: { effectiveType?: string; type?: string }; deviceMemory?: number }).connection;
const analytics = createAnalytics({
  storage: window.localStorage,
  nowMs: () => Date.now(),
  // the offset to the server's clock the last contact took, so `occurred_at` is the server's reading of when it happened (§1)
  offsetMs: clockFacts.offsetMs,
  random: () => crypto.getRandomValues(new Uint8Array(10)),
  send: createAnalyticsApi(client),
  identity: {
    // a random identifier this device keeps: pseudonymous, and the mapping to a person is Identity's, not stored here (M8)
    pseudonymousId: (() => {
      const kept = window.localStorage.getItem('qb.analytics.actor');
      if (kept !== null) return kept;
      const made = `dev-${crypto.randomUUID()}`;
      window.localStorage.setItem('qb.analytics.actor', made);
      return made;
    })(),
    sessionId: `ses-${crypto.randomUUID()}`,
    appVersion: pkg.version,
    tenantId: PLATFORM_TENANT,
    surface: 'web',
    deviceClass: () => {
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? navigator.hardwareConcurrency;
      return memory <= 2 ? 'low' : memory <= 4 ? 'mid' : 'high';
    },
    networkClass: () => {
      if (!navigator.onLine) return 'offline';
      const effective = connection?.effectiveType;
      if (effective === 'slow-2g' || effective === '2g') return '2g';
      if (effective === '3g') return '3g';
      return connection?.type === 'wifi' ? 'wifi' : '4g';
    },
  },
});
window.addEventListener('online', () => {
  analytics.flush();
  // an onboarding answer given offline is sent when the connection returns
  void sendDraft({ drafts, profiles }, sentDraft(analytics)).then(() => analytics.flush());
});
analytics.flush();

const screenContext: ScreenContext = {
  lastAttemptId: activeId,
  pageKey: crypto.randomUUID(),
  analytics,
};
const open = (href: string): void => window.location.assign(href);
/** How long the screen waits for the server's word on an answer before it says the answer is saved and will be marked: a run is sat with a poor connection, and a verdict is never worth a wait. */
const VERDICT_WAIT_MS = 6_000;
const waitFor = (fn: () => void, ms: number): (() => void) => {
  const handle = window.setTimeout(fn, ms);
  return () => window.clearTimeout(handle);
};
/** The two calls a practice run makes while it is open, each given up on if the server is slow. */
const runApi = {
  getPracticeFeedback: (attemptId: string, slotId: string) => withinTime(api.getPracticeFeedback(attemptId, slotId), VERDICT_WAIT_MS, waitFor),
  growPracticeAttempt: (attemptId: string, count: number) => withinTime(api.growPracticeAttempt(attemptId, count), VERDICT_WAIT_MS * 2, waitFor),
};
/** Made once for the page, so a question visited twice is told once. */
const verdictsTold = params.get('practice') === null ? null : createVerdictReporter(analytics, params.get('practice') as string);
const ports: SessionPorts = {
  clock: { now: () => performance.now() },
  wall: { now: () => Date.now() },
  transport: api,
  records,
  observe: clockFacts.observe,
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
  const onboarding = params.get('onboarding');
  const topicOf = params.get('topic');
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
  if (reportOf !== null) return <ReportScreen learning={learning} assessment={api} profiles={profiles} attemptId={reportOf} context={screenContext} onOpen={open} />;
  if (practiceOf !== null) {
    return (
      <PracticeScreen
        boot={() => bootPractice({ api, ports, attemptId: practiceOf, deviceRef: window.localStorage.getItem('qb-device') ?? 'device' })}
        every={(ms, fn) => {
          const handle = window.setInterval(fn, ms);
          return () => window.clearInterval(handle);
        }}
        onOnline={(fn) => {
          window.addEventListener('online', fn);
          return () => window.removeEventListener('online', fn);
        }}
        onUpdateWanted={() => void registration?.update()}
        assessment={runApi}
        attemptId={practiceOf}
        told={verdictsTold as NonNullable<typeof verdictsTold>}
        onOpen={open}
      />
    );
  }
  if (topicOf !== null) return <TopicScreen learning={learning} conceptIdentityId={topicOf} from={Number.parseInt(params.get('from') ?? '0', 10) || 0} context={screenContext} />;
  if (params.get('map') !== null) return <ConceptMapScreen learning={learning} context={screenContext} />;
  if (onboarding !== null) return <OnboardingScreen profiles={profiles} drafts={drafts} edit={onboarding === 'coverage' ? 'coverage' : null} context={screenContext} onOpen={open} />;
  return <HomeScreen learning={learning} assessment={api} profiles={profiles} context={screenContext} onOpen={open} />;
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('main.tsx: #root element is missing from index.html');
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
