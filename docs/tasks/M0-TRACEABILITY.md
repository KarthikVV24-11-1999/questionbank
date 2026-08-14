# M0 Traceability — Walking Skeleton

Every acceptance criterion in [M0-WALKING-SKELETON.md](M0-WALKING-SKELETON.md), mapped to the test that
proves it. Tier per [ADR-0013](../adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md). Format
follows M3's own traceability document.

## Track A — Ground (M0-01 → M0-06)

| Criterion | Proof | Tier |
|---|---|---|
| Workspace resolves offline, `react`/`react-dom` install for `apps/api` | `corepack pnpm install --offline` run at M0-01; verified again this session (M0-19's `@questionbank/studio` devDependency) | 1 |
| Typed config module, no default signing key | `platform/config/config.spec.ts`, 100% threshold | 1 |
| Allowlist log serializer, no PII | `platform/observability/serializer.spec.ts`, 100% threshold | 1 |
| Span tree seam (`Telemetry`, `RecordingTelemetry`) | `platform/observability/telemetry.spec.ts`, 100% threshold | 1 |
| Auth stub issues/verifies a principal only | `platform/auth/token.spec.ts`, 100% threshold | 1 |
| `PrincipalResolver` shared by all three contexts | `platform/auth/principal-resolver.spec.ts`, 100% threshold | 1 |

## Track B — The composition root (M0-07 → M0-14)

| Criterion | Proof | Tier |
|---|---|---|
| `SystemClock`/`UuidIdentifierFactory`/`PostgresAuditRecorder`, append-only audit | `platform/persistence/*.spec.ts`, `audit-recorder.integration.spec.ts` | 1 |
| Durable `IdempotencyStore`, closes D22 | `idempotency-store.integration.spec.ts` — concurrent duplicates resolve to one execution | 1 |
| `RenderValidator` production adapter, closes D27 | `render-validator.adapter.integration.spec.ts` — publication blocked on unrenderable LaTeX | 1 |
| `FilesystemMediaStore`, production refusal | `filesystem-media-store.spec.ts`; refusal proven at unit speed via `createApplication` | 1 |
| Composition seam on every barrel (ADR-0015) | Per-context `composition.spec.ts` (implied by each context's own test suite); `m4-seam.spec.ts` for the barrel-purity check | 1 |
| `createApplication` — F11 across the composed set | `app-factory.spec.ts` — planted policy-less handler, real factory rejects, names the handler | 1 |
| F1 extended to `platform/` | `app-factory.spec.ts` + `boundary-rules.spec.ts` — planted deep import of `contexts/content/infrastructure/item.repository.js`, and the real tree scanned non-vacuously | 1 |
| `main.ts`, health, graceful shutdown | `main.spec.ts`, `main.integration.spec.ts` (SIGTERM drains a real in-flight request), `health.controller.integration.spec.ts` | 1 |
| One request, one span tree, correlation id end to end | `walking-skeleton.integration.spec.ts` — root/handler/db.query spans share one `traceId` equal to the response header | 1 |
| No answer key in a delivery response, live output | `walking-skeleton.integration.spec.ts` — F6/F35 re-run over the real composed app | 1 |
| Unauthenticated → 401, and the 401 check can fail | `walking-skeleton.integration.spec.ts` — planted resolver bypass turns the same request into 200 | 1 |

## Track C — Studio as an application (M0-15 → M0-19)

| Criterion | Proof | Tier |
|---|---|---|
| `index.html`/`main.tsx`/Vite build, closes D3 | `build.spec.ts` (runs Vite's own build API), `main.spec.tsx` | 1 |
| Initial bundle measured, not estimated | `bundle-size.json`, written by `build.spec.ts` on every run (~398 KB) | 1 |
| Navigation over History API, not a router | `use-route.spec.tsx` — push/back/forward over real `window.history`, no dependency beyond `react`/`navigation.js` | 1 |
| Typed HTTP client, F15's subject | `client.spec.ts`; F15 scan in `frontend-rules.spec.ts`, planted `fetch(` in a fixture | 1 |
| Studio tokens & F24 | `frontend-rules.spec.ts` — hex/rgb/hsl blanket, named colours scoped to a style-property context, proven not to fire on exam-content prose | 1 |
| One surface (Item Browser) wired end to end, live client | `item-browser-live.spec.tsx` (stubbed transport) + `item-browser-live.integration.spec.ts` (real composed API, real Postgres, a seeded draft returned) | 1 |

**Partial, named rather than hidden:** the live adapter's `subject`/`conceptIdentityId` filters are client-side
no-ops — the one real listing endpoint carries no subject (**D33**). The Item Editor's own commands remain
unwired (**D29**, carried from M3).

## Track D — Authored infrastructure (M0-20 → M0-23)

| Criterion | Proof | Tier |
|---|---|---|
| Compose: six services, healthchecks, `service_healthy`, no `latest`, no port collision | `compose-rules.spec.ts` — one planted mutation per assertion | 2 |
| CI: five jobs, zero assertions of its own, every project covered | `ci-rules.spec.ts` — five planted mutations; spec states the workflow has never run | 2 |
| Terraform: one staging deployable, tagged, no secret, `ap-south-1`, `postgres` engine, non-local backend | `terraform-rules.spec.ts` — five planted fixtures; header states this is a lint | 2 |
| F39 — no secret in source/config/workflow/HCL | `secret-rules.spec.ts` — **real scan**, five planted fixtures, clean against the real tree | **1** |
| `.env.example` = typed config's key set, both directions | `secret-rules.spec.ts` | 1 |

## Track E — Gates and close-out (M0-24 → M0-27)

| Criterion | Proof | Tier |
|---|---|---|
| `questionbank_app` role, closes D9 | `content-rules.integration.spec.ts` — role exists, NOLOGIN, exact privilege set by equality | 1 |
| F7/F40 fires against a real role, first time | `content-rules.integration.spec.ts`, `platform-rules.integration.spec.ts` | 1 |
| F26 — attempt engine, no subject | `frontend-rules.spec.ts` — package confirmed absent, planted React import fails the rule, planted unconfirmed package fails the confirmation scan. **`Pass (rule proven) / no subject`** | 1 (rule) / 3 (subject) |
| M0 gate register: F1/F7/F11/F16/F24/F26/F39/F15/F1/F12 | `platform-rules.spec.ts`, `frontend-rules.spec.ts`, `content-rules.spec.ts`, `boundary-rules.spec.ts` — each with a planted violation | 1 |
| F1, F2, F5, F6/F35, F9, F20, F36, F45–F48 still green | Full `pnpm test` run, this session, exit 0 — not assumed | 1 |
| 100% coverage: `token.ts`, `config.ts`, `serializer.ts`, `app-factory.ts`, `idempotency-store.ts` | `vitest.config.ts` thresholds, each verified failing first (`app-factory.ts`'s pool-close bug was found this way) | 1 |
| §11 describes a path someone has taken | `handbook-rules.spec.ts`; `start` verified live this session (healthz/readyz/authenticated-200) | 1 |

## Findings — partially proven or blocked criteria

| # | Criterion | Status | Why |
|---|---|---|---|
| F-1 | F8 (`docker compose up ≤ 10 min`) | `Fail — blocked` | No container runtime on this machine. No check written — a check that cannot run is not a gate |
| F-2 | Grafana trace, client → API → DB | `Fail — blocked` | No `@opentelemetry/*` in the offline store (D31), no Grafana account. The in-process span tree is real but is not a trace in a backend |
| F-3 | Staging deploy ≤ 15 min | `Fail — blocked` | No cloud account, no network, no CI runner. Terraform lint is not deploy evidence |
| F-4 | CI gates blocking | `Fail — blocked` | No CI provider connected; workflow authored and its gate set asserted, never executed |
| F-5 | F26 | `Pass (rule proven) / no subject` | `packages/attempt-engine` does not exist; the rule is proven against fixtures, not against a real violation in the shipped tree |
| F-6 | Item Browser's subject/concept filters | Partial | No source on the real listing endpoint (D33); client-side no-op, documented in the adapter |
| F-7 | `CreateItemDraftHandler`'s response shape | Diverges from `content.yaml` | Echoes the raw domain aggregate, not `toAuthoringItemView` (D34); out of scope to fix in M0-19, cross-cutting |
| F-8 | "An author produces a stimulus-linked set in ≤ 20 min" | `Fail — blocked on D29` | The Item Editor's commands are unwired; the blocker shrank from a milestone to a task |
| F-9 | "40 items/hour, 3 real reviewers" | `Fail — blocked on M4` | No review workspace exists to time; M0 changes nothing here |
