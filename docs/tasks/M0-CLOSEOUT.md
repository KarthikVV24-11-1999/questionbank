# M0 Close-out — Walking Skeleton

**All 27 tasks merged. HEAD at close-out carries M0-01 through M0-27.**

Full workspace, this session's final run, exit 0 both commands:

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 150 | **3515** |
| `apps/studio` | 16 | **272** |
| `packages/content-renderer` | 4 | **118** |
| `packages/contracts` | 2 | **10** |
| `packages/domain-types` | 1 | **2** |
| `tools/seed` | 5 | **94** |
| **Total** | **178** | **4011** |

`pnpm run fitness` (apps/api): 10 files, 171 tests, green. Coverage thresholds hold across the workspace;
every module ADR-0008 names is at 100%, each verified failing first.

---

## Milestone Definition of Done

### Delivered and proven here (Tier 1)

- [x] All 27 tasks merged
- [x] **`corepack pnpm --filter @questionbank/api start` serves an authenticated request** through the
      composed application to real Postgres and back, answer key absent from the delivery payload.
      Verified live this session: `/healthz` 200, `/readyz` 200 against real Postgres, an authenticated
      `GET /v1/exams` returns `200 []` with `X-Correlation-Id` present. `start` runs `vite-node src/main.ts`
      — there is no build step for `apps/api`, and a real bug in `main.ts`'s entry guard (never fired, in
      this repository's own path) was found and fixed while proving this
- [x] **`createApplication` rejects on a handler with no authorization policy** (F11), proven against a
      planted violation across the whole composed handler population (`app-factory.spec.ts`)
- [x] **`RenderValidator` has a production adapter and the publication precondition runs against it** —
      **D27 closed**
- [x] **The idempotency store is durable and survives a restart** — **D22 closed**
- [x] **`questionbank_app` exists locally and F7/F40 fires against it** — **D9 closed**; the "role is
      absent" test rewritten to assert the real privilege set by exact equality, not deleted
- [x] **Studio builds, mounts and navigates; one surface talks to the API through the typed client** —
      **D3 closed**; initial bundle measured at ~398 KB, written to `apps/studio/bundle-size.json`
- [x] F15 has a subject for the first time: no `fetch` outside `packages/contracts/src/client.ts`
- [x] Every configuration value is read through the typed config module (F16); `.env.example` and the
      config key set are asserted equal, both directions
- [x] No secret in source, config, workflow or HCL (F39, the one Tier-1 task in Track D); no PII in any log
      record or span attribute
- [x] One request emits one connected span tree carrying the response's correlation id end to end
- [x] **Handbook §11 describes a path someone has actually taken**, and `handbook-rules.spec.ts` asserts
      every command it names exists
- [x] F1, F2, F5, F6/F35, F9, F20, F36, F45–F48 still green — re-run this session, not assumed, after
      `platform/` and `react` entered the tree
- [x] 100% coverage on `auth/token.ts`, `config/config.ts`, `observability/serializer.ts`,
      `composition/app-factory.ts`, `persistence/idempotency-store.ts`, each verified failing first —
      `app-factory.ts`'s own proof found a real pool-leak-on-shutdown bug; ≥ 80% line / ≥ 70% branch overall

### Authored and asserted, claiming nothing more (Tier 2)

- [x] Compose file: six services, a health check on every one, `service_healthy` on every dependency,
      pinned images, no port collision — every assertion proven red on a planted mutation. No boot, no
      boot time, no claim of either
- [x] CI workflow: five jobs covering every workspace project, no `continue-on-error`, no conditional
      gate, no assertion of its own
- [x] Terraform for one staging deployable, linted and labelled a lint, Tier-3 command recorded verbatim
- [x] ADR-0011, ADR-0012, ADR-0013, ADR-0014, ADR-0015 merged; **ADR-0004 amended in place**, still
      recording F8 as failed-blocked

### Blocked — marked so now, not narrowed until they pass (Tier 3)

- [ ] **`docker compose up` → full stack healthy in ≤ 10 min** — `Fail — blocked`: no container runtime.
      Successor: `docker compose -f infra/compose/docker-compose.yml up --wait`
- [ ] **One request traced client → API → database in Grafana** — `Fail — blocked` on two independent
      resources: no `@opentelemetry/*` in the offline store (D31), no Grafana account
- [ ] **Staging deploy from a green main in ≤ 15 min** — `Fail — blocked`: no cloud account, no network,
      no CI runner
- [ ] **CI gates blocking** — `Fail — blocked`: no CI provider connected
- [ ] **Every listed fitness function fails a planted violation** — **Partial: 9 of 10.** F1, F2, F5, F7,
      F11, F16, F24, F26, F39 each proven red on a planted violation; **F26 additionally reported as
      `rule proven / no subject`**. F8 not claimed. **This is the one ROADMAP acceptance criterion M0
      substantially meets, and it is reported as partial, not as met**

### Carried and reassigned

- [ ] **"An author produces a stimulus-linked set in ≤ 20 min"** — moves to `Fail — blocked on D29`, the
      unwired Item Editor
- [ ] **"40 items/hour reviewing"** — `Fail — blocked`, blocker reassigned from M0 to M4. **M4 must not
      read M0's landing as permission to claim this**
- [ ] D2 (Playwright E2E) still deferred
- [ ] D10 (browser-measured p95) still deferred, blocker renamed: a real app in a real browser now exists;
      a measurement harness does not
- [x] New debt recorded: **D29, D30, D31, D32** (M0's own), **D33, D34** (found this session)
- [ ] **B1 carried forward** — see below

---

## DEC-M0-12 — what M0 unblocked, restated

| Gate | Before M0 | After M0 | Why |
|---|---|---|---|
| "≤ 20 min" (M3, DEC-5) | `Fail — blocked on D3/M0` | `Fail — blocked on D29` | The blocker shrank from a milestone to a task |
| "40 items/hour, 3 reviewers" (M4) | `Fail — blocked` | `Fail — blocked on M4` | No review workspace to time; the blocker moved to M4's own scope |
| D2 — Playwright E2E | Deferred | Still deferred | Not in the offline store |
| D10 — browser p95 | Deferred | Still deferred, renamed | A real app exists; a measurement harness does not |

---

## Debt register

**Closed this milestone:** D3 (Studio entry point/build/navigation/one live surface), D9
(`questionbank_app` role), D22 (durable idempotency store), D27 (`RenderValidator` production adapter).

**New this milestone:**

| # | Item | Trigger |
|---|---|---|
| D29 | Item Editor's commands unwired | The next session that wires a second live surface |
| D30 | `useRoute` is not a router | The first nested route, or the first surface needing validated search state |
| D31 | No OTLP exporter (span tree, not a trace in a backend) | The OTel SDK becoming installable offline |
| D32 | No S3 `MediaStore` adapter (filesystem stands in) | The first staging deploy that needs real object storage |
| D33 | Item Browser's `subject`/`conceptIdentityId` filters have no source on the real listing endpoint | A curriculum concept → subject lookup lands (echoes D23), or content exposes one directly |
| D34 | `CreateItemDraftHandler` echoes the raw domain aggregate, not its documented view | The next authoring command handler this divergence is found to affect, or a client that needs the create response's shape |

**Unchanged:** D19–D21, D23–D26, D28.

### B1 — blocking gate, still open

**M2-30: the golden set is validated against zero real papers.** The CI gate runs every commit and is
vacuous — 4 synthetic fixtures, nothing about agreement with an official key. Blocked on
[DECISIONS §D item 2](../DECISIONS.md) (content licensing & IP policy), needing legal counsel sign-off.

The decision is one sentence: *may released papers with official NTA keys be held in this repository as
internal test fixtures, not served to learners?* Acceptance: three papers under
`apps/api/src/testing/golden/papers/` with `provenance: "official"`, and the suite reporting `3 official`.

**Do not attempt to source papers.** Carried into every M4 handoff until it closes.
