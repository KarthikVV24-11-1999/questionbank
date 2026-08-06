# Frontend Architecture
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Extends:** [ARCHITECTURE.md](ARCHITECTURE.md) §5 (offline client) · **Traces to:** [NFR.md](NFR.md) §2, §6, §7 · [FRS.md](FRS.md)

> One recommendation per decision, one line of justification. No code.

---

## 1. The Foundational Split

**Two applications, one design system, one shared domain layer.**

| App | Audience | Surface | Offline | Bundle pressure |
|---|---|---|---|---|
| **Learn** | Students | Mobile-first PWA | **Required** | Severe — 250 KB (PER-20) |
| **Studio** | Authors, reviewers, ops | Desktop-only SPA | None | None |
| **Site** | Public | Static marketing/SEO | N/A | Moderate |

**Justification:** the authoring editor — structured math, chemistry, diagram tooling — is an order of magnitude larger than the entire student bundle budget. Shipping one app makes PER-20 unachievable and PER-04 (3 s cold start on a 2 GB Android device) impossible.

**Shared across both:** design system, `ContentRenderer`, generated API types, domain formatting logic. **Not shared:** shells, routing, state, build config.

| Decision | Justification |
|---|---|
| **React + TypeScript** | Matches the backend stack, shares generated types, and has the deepest talent pool in the target market. |
| **Vite SPA, not SSR/Next.js** | The product is auth-gated and offline-first — SSR buys one first paint while adding a permanent server tier and fighting the service worker. |
| Separate SSG marketing site | SEO and first-load matter for acquisition and nowhere else. |
| **`ContentRenderer` has exactly one implementation, shared by both apps** | Two implementations guarantee that authoring preview diverges from what students see — violating INV-14 silently. |

---

## 2. Navigation

### Learn — bottom tab shell (mobile-first)

| Tab | Purpose |
|---|---|
| **Home** | Next-best-action; the answer to "what do I do now?" |
| **Practice** | Session setup, targeted remediation, spaced review |
| **Mocks** | Catalog, schedule, results |
| **Progress** | Concept map, analytics, error notebook |
| **Me** | Profile, subscription, settings, inbox |

**Flows that escape the tab shell** (fullscreen, no tab bar): onboarding wizard, diagnostic, **exam runtime**, checkout.
**Overlays** (sheets, focus-trapped): solution viewer, paywall, filters, item report.

| Decision | Justification |
|---|---|
| Five tabs, never more | A sixth tab means the information architecture failed. |
| **The exam runtime is a navigation dead-end** — no tab bar, back intercepted, unload warned, service-worker updates deferred | An accidental navigation during a three-hour mock is an irrecoverable product failure. |
| Deep links resolve to content, not tabs | A shared concept or result link must open the thing, not the app. |
| Back always means back; no custom history stacks | Android hardware back is muscle memory and must never surprise. |

### Studio — persistent left sidebar (desktop)
Dashboard · Authoring · Review Queue · Content Health · Taxonomy · Exams & Forms · AI Console · Defects & Challenges · Users · Reports · Audit

| Decision | Justification |
|---|---|
| Sidebar, not tabs; command palette (⌘K) as the primary navigation | Reviewers work keyboard-first at 60+ items/hour (PRD §4 P4). |
| Studio is desktop-only below 1280 px, with an explicit "use a larger screen" gate | An authoring tool on a phone is a fiction; pretending otherwise costs real engineering. |

---

## 3. Pages

### Learn (29)
**Auth** — Sign Up · Sign In · Verify Contact · Recover · Parental Consent
**Onboarding** — Exam & Target · Syllabus Scope · Diagnostic Runtime · Diagnostic Result
**Core** — Home · Concept Map · Concept Detail · Progress Dashboard · Study Planner
**Practice** — Practice Setup · Practice Runtime · Practice Summary
**Mock** — Mock Catalog · Mock Pre-Flight · **Exam Runtime** · Mock Result · Mock Diagnostic Report · Attempt Review
**Learning aids** — Solution Viewer · Error Notebook · Bookmarks · Search
**Commerce** — Plans · Checkout · Subscription
**System** — Settings · Notification Inbox · Help · Offline / Error

### Studio (22)
Dashboard · Item Browser · **Item Editor** · Stimulus Editor · Solution Editor · Media Library · **Review Queue** · **Review Workspace** · Taxonomy Manager · Taxonomy Migration · Exam Profile Editor · Form Assembly · Mock Scheduling · AI Generation Console · AI Candidate Review · Model & Prompt Versions · Content Coverage · Defects · Challenge Adjudication · Re-Scoring Console · Users & Roles · Reports · Audit Log

**The four pages that carry the product:** Exam Runtime, Mock Diagnostic Report, Review Workspace, Item Editor. Everything else is supporting cast.

---

## 4. Component Hierarchy

Six layers, strictly downward-depending.

| Layer | Contents |
|---|---|
| **L1 Primitives** *(design system)* | Button, Input, Select, Checkbox, Radio, Sheet, Dialog, Popover, Tabs, Toast, Badge, Skeleton, Icon, Meter |
| **L2 Content renderers** *(domain-critical)* | **`ContentRenderer`**, MathNode, ChemNode, DiagramFigure, MediaFigure, CodeBlock |
| **L3 Domain components** | ItemStem, OptionList, NumericAnswerInput, QuestionPalette, AttemptTimer, ConceptChip, MasteryMeter, SolutionPanel, DistractorNote, DiagnosticFinding, RemediationCTA, SyncStatusBadge, EntitlementGate |
| **L4 Compositions** | PracticeRunner, **ExamRunner**, ResultReport, ConceptMapView, ReviewWorkspace, ItemEditorSurface |
| **L5 Shells** | AppShell, **ExamShell** (chrome-less), StudioShell, AuthShell, WizardShell |
| **L6 Routes** | Data loading, guards, error boundaries — no presentation logic |

| Decision | Justification |
|---|---|
| L2 is the most carefully governed layer in the codebase | It renders answer-bearing content on four surfaces and carries the entire ACC-02 accessibility burden. |
| `EntitlementGate` is a component, not scattered conditionals | Paywall logic in 40 places produces 40 inconsistent paywalls. |
| Routes contain no presentation | Keeps compositions testable without a router. |
| No component reaches into another's internals; composition over configuration | A component with 20 boolean props is two components. |

---

## 5. State Management

Four distinct kinds of state, four distinct mechanisms. Conflating them is the usual cause of frontend rot.

| State | Mechanism | Justification |
|---|---|---|
| **Server cache** — items, results, concept map | **TanStack Query** | Caching, staleness, retry, and offline behavior solved once rather than per-feature. |
| **Attempt state** — response log, timer, sync | **Attempt Engine** — a framework-agnostic TypeScript module | **The single most important frontend decision.** The exam must not depend on React's lifecycle; a re-render bug must never lose a response (REL-01). Also makes the engine reusable in native shells. |
| **Global app slice** — session, entitlement, flags, theme, locale | **Zustand** | Small, synchronous, and read everywhere; Redux boilerplate buys nothing here. |
| **Ephemeral UI** — open sheets, transient selections | Local component state | State that dies with the component should live with it. |
| **Shareable/restorable** — filters, tab, page, step | **URL** | If a refresh loses it, it belonged in the URL. |

### The Attempt Engine
Owns: append-only local event log, monotonic timer with server-anchored deadline, sync queue with watermark, package integrity, crash recovery.
React subscribes; React never owns. It persists on every event, not on unmount. It is unit-testable without a DOM, and it is the component that gets adversarial network and process-kill testing every release.

---

## 6. Data Fetching

| Decision | Justification |
|---|---|
| Typed client generated from OpenAPI; no hand-written fetch calls | A hand-written client is a divergence waiting to ship. |
| Query keys embed the entity version or content hash | Published content is immutable (INV-03), so version-keyed keys make cache invalidation mostly unnecessary. |
| Infinite `staleTime` for published content; short for mutable state | Refetching an immutable item version is pure waste on a metered 3G connection. |
| Query cache persisted to IndexedDB | Cold start on a mid-tier device must not begin with a network round trip. |
| Mutations queued in a client-side outbox mirroring the server pattern | One mental model for durability across the stack. |
| Prefetch the next item on intent (viewport/focus), never the whole set | PER-01's 400 ms render budget is met by having the next item already resident. |
| **No network fetch during exam runtime except background sync** | The exam runs entirely from the downloaded package. |
| Error boundaries per route, never one global boundary | A failed report must not blank the app. |
| Optimistic updates only where the server cannot reject — flags, bookmarks | Optimistic scoring or entitlement would show a student something untrue. |

---

## 7. Forms

| Decision | Justification |
|---|---|
| **React Hook Form + Zod**, schemas generated from OpenAPI | Uncontrolled inputs cost far less on low-end devices, and one schema definition prevents client/server drift. |
| Client validation is UX only; the server is always authoritative | Client-side validation is a courtesy, never a control. |
| `NumericAnswerInput` is a domain control honoring `NumericAnswerSpec` accepted forms | Decimal, fraction, and scientific notation are domain rules (D-001), not input masking. |
| Error summary at the top of the form with focus moved to it, plus inline field errors | WCAG 2.2 AA and the only pattern screen-reader users can actually navigate. |
| Every field programmatically labeled; errors bound via `aria-describedby` | Placeholder-as-label fails both accessibility and usability. |
| Autosave with debounce in Studio; explicit submit in Learn | Losing 40 minutes of authoring is unacceptable; accidental exam submission is worse. |
| Multi-step flows keep step in the URL and draft in local storage | A dropped connection mid-checkout must not restart onboarding. |
| Destructive actions require typed confirmation, never a bare dialog | Re-scoring and retirement are not undoable by a click. |

---

## 8. Routing

| Decision | Justification |
|---|---|
| **TanStack Router** | End-to-end type-safe params and validated search state, and it composes with TanStack Query rather than duplicating it. |
| Route-level code splitting is mandatory | The 250 KB initial budget is unreachable without it. |
| Layered guards: authenticated → onboarded → role → entitlement | Each concern fails with a different, actionable response (401/403/402/redirect). |
| **Exam route blocks navigation, intercepts back, warns on unload, defers SW updates** | The one route where leaving must be deliberate and difficult. |
| Search params are typed and validated, not parsed ad hoc | Filters are shareable state and deserve a schema. |
| Scroll restoration on back; reset on forward | Returning to a 200-item list at the top is a bug. |
| Explicit `/offline`, `/error`, `/not-found` routes | Offline is a first-class state here, not an error. |

---

## 9. Responsive Design

| Decision | Justification |
|---|---|
| Mobile-first from a **360 px floor**; breakpoints 360 / 480 / 768 / 1024 / 1280 | The minimum supported device (NFR §2) is the default test target, not an afterthought. |
| Learn on desktop is a centred, wider column — **not a redesign** | Students overwhelmingly use phones; a bespoke desktop layout is cost without return. |
| Studio has a hard 1280 px minimum with an explicit gate below it | See §2. |
| Exam runtime keeps item presentation identical across sizes; only the palette relocates (bottom sheet ↔ sidebar) | Item presentation is exam fidelity and must not vary. |
| Fluid type via `clamp()`; OS text scaling to 200% must not break layout | ACC-08, and Indian Android users scale text more than Western defaults assume. |
| Container queries for components appearing in multiple contexts | An ItemCard in a list and in a review pane should not need two implementations. |
| **The body never scrolls horizontally**; wide tables, equations, and diagrams scroll inside their own container | A long equation must not break the page. |
| Safe-area insets honored; layout never sits under a notch or gesture bar | Losing a submit button to a home indicator is a real failure mode. |

---

## 10. Accessibility

| Decision | Justification |
|---|---|
| **WCAG 2.2 Level AA**, automated axe scan blocking in CI | ACC-01; the RPwD Act 2016 makes this a legal obligation, not a preference. |
| **MathML-first rendering with an authored text alternative per expression** | ACC-02 is not solved by a rendering library — reading order must be verified per notation class against TalkBack, VoiceOver, and NVDA. |
| Mandatory alt text on every figure; long descriptions for complex diagrams | Enforced at publication (FR-QM-06), so the frontend can rely on it existing. |
| **Full keyboard operability of the exam runtime, including the palette** | ACC-04 — a keyboard-only student must complete a mock in standard time (ACC-12). |
| Focus moves to the main heading on route change; modals trap and restore focus | Without this, screen-reader users are silently stranded on navigation. |
| Timer announces at thresholds only, never continuously | A live-region timer reading every second makes the exam unusable with a screen reader. |
| Polite live regions for sync status and autosave; assertive reserved for time warnings | Assertive interruptions during an exam are harmful. |
| No colour-only encoding — mastery states carry shape and label as well | Weak/developing/strong appear throughout the diagnostic product (ACC-07). |
| Touch targets ≥ 44 × 44 px with spacing | ACC-09, and mid-tier device touch accuracy is worse than flagship. |
| `prefers-reduced-motion` honored; no task requires motion to complete | ACC-10. |
| Extended-time accommodation reflected in the runtime timer | D-014. |

---

## 11. Design System

| Decision | Justification |
|---|---|
| **Own the design system**: headless primitives (Radix/Ark) + Tailwind — no MUI/AntD | Heavy component libraries alone exceed the 250 KB budget; headless primitives give correct accessibility semantics at near-zero weight. |
| Design tokens as CSS custom properties: colour, type, spacing, radius, elevation, motion | Themeable at runtime with no JavaScript cost. |
| Three themes: light, dark, high-contrast | Students study at night on cheap screens; high-contrast is an accessibility requirement, not a preference. |
| **No runtime CSS-in-JS** | Runtime style computation is a measurable cost on a 2 GB Android device. |
| System font stack + one subsetted variable font for Latin; Devanagari subset deferred to H1 | Webfont bytes are expensive on 3G and count against PER-25's 5 MB per-mock data budget. |
| Single tree-shaken inline SVG icon set | Icon fonts break with text scaling and fail accessibility. |
| **Domain tokens defined once**: mastery states, difficulty bands, correctness states, sync states | These appear on a dozen screens; divergence would make the diagnostic product incoherent. |
| Storybook with the a11y addon as the component contract | A component that is not in Storybook has no reviewable accessibility surface. |
| Visual regression tests on L1 and L2 | Content rendering must not drift silently (INV-14). |

---

## 12. PWA & Offline

| Decision | Justification |
|---|---|
| Service worker precaches the app shell; runtime caching per route class | Cold start after first visit comes from cache, beating SSR without a server tier. |
| Form packages stored in Cache Storage with an IndexedDB manifest | Bulk immutable assets belong in Cache Storage; metadata needs queryability. |
| **Service worker updates are deferred during an active attempt** | An update mid-exam could swap the runtime under a student. |
| Update strategy elsewhere is prompt-to-reload, never silent `skipWaiting` | Silent reload loses unsaved authoring work. |
| Install prompt only after demonstrated engagement | Prompting on first visit trains dismissal. |
| Background Sync for the response log, with a foreground fallback | Background Sync support is uneven on the target device population. |
| Storage quota checked at pre-flight; insufficient space blocks mock start with a remedy | FR-MOCK-02 — better to refuse at pre-flight than to fail at minute 90. |

---

## 13. Performance Budgets

| Budget | Target | Enforcement |
|---|---|---|
| Initial bundle (Learn), compressed | ≤ 250 KB | CI, blocking |
| Per-route chunk | ≤ 80 KB | CI, blocking |
| Exam runtime chunk incl. renderer | ≤ 150 KB | CI, blocking |
| Item render p95, mid-tier Android | ≤ 400 ms | Device lab + RUM |
| Cold start p95 | ≤ 3 s | RUM |
| Memory over a 3-hour mock | ≤ 250 MB, **no growth trend** | Long-session soak test per release |
| Battery over a 3-hour mock | ≤ 25% | Device lab |

| Decision | Justification |
|---|---|
| Long lists virtualized (item browser, review queue, palette) | A 180-item palette must not re-render as a unit. |
| Images served from pre-generated derivatives via `srcset`, AVIF/WebP | Resizing at request time burns both server cost and client battery. |
| The exam runtime carries no analytics, no A/B code, no third-party script | Nothing non-essential runs during the three hours that matter most. |
| Real-user monitoring segmented by `device_class` and `network_class` | An aggregate p95 hides the minimum-profile student entirely. |

---

## 14. Internationalization

| Decision | Justification |
|---|---|
| ICU message format, locale bundles lazily loaded | English-only at launch, but retrofitting i18n across 29 pages is far more expensive than building it in. |
| **UI locale and content locale are separate concerns** | A student may read Hindi content in an English interface; content variants come from the API (FR-QM-11). |
| No hardcoded text direction, though target locales are all LTR | Costs nothing now; avoids a rewrite if scope changes. |
| Number, date, and duration formatting always locale-aware | Timer and score displays must never be hand-formatted. |

---

## 15. Testing

| Layer | Tool | Gate |
|---|---|---|
| Unit (Attempt Engine, formatters, validation) | Vitest | Blocking |
| Component | Testing Library | Blocking |
| E2E critical journeys | Playwright | Blocking |
| **Offline & adversarial network** — connectivity loss, process kill, device switch, clock skew | Playwright + network shaping | **Blocking, every release** |
| Accessibility | axe automated + manual per release | Automated blocking |
| Visual regression | L1/L2 components | Blocking |
| Performance budgets | Bundle analyzer + Lighthouse CI | Blocking |
| Long-session soak | 3-hour mock memory/battery profile | Per release |

The offline and adversarial suite is the one that protects REL-01. It is not optional and it does not get skipped for a release.

---

## 16. Frontend Fitness Functions

| # | Check |
|---|---|
| F19 | No component in Learn imports from Studio, or vice versa |
| F20 | `ContentRenderer` has exactly one implementation across the monorepo |
| F21 | No route exceeds its bundle budget |
| F22 | No third-party script is reachable from the exam runtime chunk |
| F23 | Every interactive element has an accessible name — axe, blocking |
| F24 | No hardcoded colour outside the token layer |
| F25 | No hand-written API call — all requests go through the generated client |
| F26 | Attempt Engine has zero React imports |

---
