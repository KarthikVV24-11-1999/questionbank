# Handoff — M2 Closed, M3 Starting

**State as of 2026-08-07.** M2 (Scoring Engine + Golden Set) is complete and
audited. 1740 tests pass across three packages; `pnpm -r typecheck` is clean.
Close-out evidence, per-item DoD verdicts and the debt register are in
[tasks/M2-CLOSEOUT.md](tasks/M2-CLOSEOUT.md); criterion-level traceability is in
[tasks/M2-TRACEABILITY.md](tasks/M2-TRACEABILITY.md).

**34 of 35 M2 tasks merged. M2-30 is a carried blocking gate — read it before
you plan anything that depends on the golden set.**

## Where to start

**Task M3-01.** M3 is Content Model & Authoring: `Item`, `Stimulus`, `Solution`
and `MediaAsset` as independently versioned aggregates, structured
`ContentBody`, and the Studio authoring surface that fills them.

There is no M3 task breakdown yet. Write one first, in the format of
[tasks/M2-SCORING-ENGINE.md](tasks/M2-SCORING-ENGINE.md), and get it approved
before writing code — M2 lost half a session to starting without one.

## Required reading for M3 — these only

| Document | Read |
|---|---|
| [DOMAIN-MODEL.md](DOMAIN-MODEL.md) | §2 D1 and D5, §5 Content in full |
| [FRS.md](FRS.md) | FR-TCH-* (authoring), FR-QM-* (review and governance) |
| [UX-ARCHITECTURE.md](UX-ARCHITECTURE.md) | The authoring surfaces |
| [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) | §9 Studio shell — it still does not exist (D3) |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) | §5 testing, §8 error handling, §9 architecture rules |
| [adr/ADR-0007](adr/ADR-0007-rationals-are-canonical.md) · [adr/ADR-0008](adr/ADR-0008-coverage-follows-correctness-bearing-code.md) | The two M2 decisions that bind on M3 |
| [tasks/M2-CLOSEOUT.md](tasks/M2-CLOSEOUT.md) | Debt register and the M2→M3 seam |

The standing rules still apply: `domain/` imports nothing; domain and
application return typed results and never throw; integration tests use real
Postgres, never a mock.

## Running things

```bash
pnpm install
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test    # 1740 tests; coverage gate on apps/api
pnpm --filter @questionbank/seed run seed  # loads and publishes both taxonomies and profiles
```

**Database caveat, unchanged.** `DATABASE_URL` defaults to port 5432 — what
Compose will publish. Until M0 lands, supply your own Postgres 16 and export it.
The machine this was built on runs Homebrew on **5433**:

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"   # tests
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank"        # seed
```

Integration specs create and drop the `curriculum`, `scoring` and `platform`
schemas, so point them at a throwaway database. See
[adr/ADR-0004](adr/ADR-0004-local-postgres-pending-m0-compose.md).

`pnpm` is not on PATH in every environment; `corepack pnpm …` works everywhere.
Note `pnpm seed` at the repo root shells out to a bare `pnpm`, so use the
`--filter` form above.

## The M2 → M3 seam

Verified by `apps/api/src/contexts/scoring/m3-seam.spec.ts`, which is written
against `scoring/public/` **only** — it stops compiling the moment M3 needs
something the barrel does not export.

| What M3 needs | Where it is | Guarantee |
|---|---|---|
| The answer key an `ItemVersion` carries | `scoring/public/` → `AnswerKeyData` | All four variants: `SINGLE_CORRECT`, `MULTI_CORRECT`, `MATCHING`, `NUMERIC`. Store it as authored data; the executor consumes it unchanged |
| `NumericAnswerSpec` | `scoring/public/` → `NumericAnswerSpecData` | Every mode parameter, `UnitSpec`, accepted forms. Normalization flags default — M3 need not supply them. The expected value is the **authored decimal literal**, never a float |
| Item type ↔ key variant | `checkKeyMatchesItemType`, run inside `createScoringInput` | A key of the wrong variant is refused at construction. **The item-type vocabulary is closed** — adding one is a deliberate code change in `answer-key.ts`, not a data change |
| Building an attempt | `createScoringInput` on the barrel | M6's job, but the shapes are exported now so M3 can model against them |
| Reading a mark | `marksToDecimalString` | Marks are exact rationals. Never read one through a JavaScript number |
| Score events | `scoring/public/` → `SCORING_EVENT_TYPES` | `AttemptScored`, `AttemptsRescored`. Identifiers and decimal text only |

**Nothing in M3 needs to reach past the barrel to score.** That was not true
when the audit started — the barrel exported the `ScoreAttempt` command and
none of the types it references, so a consumer could name it and not construct
it. Fixed during close-out; the seam spec is what keeps it fixed.

Two things M3 should know it owns:

- **`ContentBody`, `Stimulus`, `Solution` and `MediaAsset` are entirely M3's.**
  Scoring never sees them. It reads an answer key and a projected response, and
  nothing else about an item.
- **Answer keys must not reach a client** (§9 rule 10). Scoring asserts this
  over its own DTOs and OpenAPI document; M3 will need the same assertion over
  the authoring surface, where the key is *edited* and therefore must reach the
  author but nobody else.

## Accepted deviations carried forward

| # | Deviation | Rationale |
|---|---|---|
| [ADR-0001](adr/ADR-0001-nestjs-arrives-with-the-http-surface.md) | NestJS introduced with the HTTP surface | F36 proven by `HandlerRegistry` and module boot, both with planted violations |
| [ADR-0002](adr/ADR-0002-in-repo-boundary-checker.md) | In-repo boundary checker instead of dependency-cruiser | dependency-cruiser refuses to run on Node 23. Generalised to every context at M2-25 |
| [ADR-0003](adr/ADR-0003-terminal-marking-rule-awards-zero.md) | Terminal `ALWAYS` awards 0, never a penalty | **Binding on anything that touches marking.** An unanticipated response state must never cost a candidate a mark |
| [ADR-0004](adr/ADR-0004-local-postgres-pending-m0-compose.md) | Local Postgres on 5433 pending M0 | F8 cannot pass and is not claimed. No code depends on the port |
| [ADR-0005](adr/ADR-0005-src-level-support-directories.md) | Support directories under `apps/api/src` | `testing/`, `fitness/`, `fitness-fixtures/`, `contracts/`. None imported by production code |
| [ADR-0006](adr/ADR-0006-aggregation-spec-on-exam-profile-version.md) | `AggregationSpec` on `ExamProfileVersion`, not `MarkingRuleSet` | Diverges from ASSESSMENT-ENGINE §2.1's literal shape so no published rule-set hash is reissued |
| [ADR-0007](adr/ADR-0007-rationals-are-canonical.md) | Rationals kept in lowest terms | Equal values must *look* equal, or the determinism soak measures nothing |
| [ADR-0008](adr/ADR-0008-coverage-follows-correctness-bearing-code.md) | 100% coverage follows correctness-bearing code, not layer | **M3 inherits this.** Any handler that resolves which item version or content version gets pinned is correctness-bearing and needs 100% |

## Carried debt

**One blocking gate and eighteen debt items.** B1 is not debt — it is a gate
that must be carried into every handoff until it closes.

| # | Item | Owner | Trigger |
|---|---|---|---|
| **B1** | **M2-30 — the golden set is validated against zero real papers.** The CI gate runs on every commit and is **vacuous**: it proves regression-freedom against 4 synthetic fixtures and nothing about agreement with an official key. Blocked on [DECISIONS §D item 2](DECISIONS.md) (content licensing & IP policy), which needs legal counsel sign-off. The decision needed is one sentence: *may released papers with official NTA keys be held in the repository as internal test fixtures, not served to learners?* Acceptance: three papers under `apps/api/src/testing/golden/papers/` with `provenance: "official"` and a `source`, and the suite reporting `3 official`. It is a pure data drop — no code change | Legal counsel → Backend | **Now. Carry forward until resolved** |
| D1 | SME sign-off on the JEE Main and NEET taxonomy datasets | Curriculum SME | Before delivery |
| D2 | Playwright E2E for the Studio surfaces | Frontend | With D3 |
| D3 | Studio app shell, router and 1280 px gate | Frontend | **M3** — the authoring surface needs it |
| D4 | Durable `AuditRecorder` writing `identity.audit_record` | Backend | With the Identity schema |
| D5 | Real `PrincipalResolver` (JWT verification) | Backend | With the Identity context |
| D6 | Compose boot verification (F8) | Platform | With M0 |
| D7 | Validate both OpenAPI documents against the 3.1 meta-schema | Backend | Next API task |
| D8 | Happy-path tests for the untested curriculum endpoints | Backend | With D9 |
| D9 | Consumer-driven contract tests against the live controllers | Backend | When a client consumes the API |
| D10 | "p95 < 200 ms" measured in a browser, not jsdom | Frontend | With D2 |
| D11 | Boundary checker: tsconfig path aliases, transitive re-exports | Backend | If either is introduced |
| D12 | Rename `toleranceDefault` → `toleranceDefaults` | Backend | Next touch of the aggregate |
| D13 | Amend ASSESSMENT-ENGINE §2.4 to the F46-complete four-rule form | Architecture | Next doc revision |
| D14 | Reconcile DATA-ARCHITECTURE §4 FK naming with handbook §2 | Architecture | Next doc revision |
| D15 | Response projection (§4) and F49 — untested, M6 owns it | Backend | M6 |
| D16 | `AggregationSpec` is not yet read from the profile at scoring time | Backend | M6 |
| D17 | Outbox drainer does not exist — scoring emits and nothing relays | Platform | With M0 or the relay app |
| D18 | Zod request schemas hand-written, not generated from the OpenAPI document | Backend | Next API task |

## What M2 does not give you

- No running application. There is still no `main.ts`, no HTTP bootstrap, no
  Compose, no CI. `ScoringModule.register` and `CurriculumModule.register` build
  their modules; nothing calls either outside tests.
- No `Attempt` or `Form`. Scoring takes its own input contract (the ROADMAP's
  "synthetic attempt"); M6 maps onto it.
- No response projection. The executor takes *projected* answers; deriving them
  from the event log is M6's, and F49 is untested.
- No authentication, no audit persistence, no outbox relay.
- **No validated golden set.** See B1.

## Standing instruction

**Every response stays under 15 lines. No narration, no preamble, no restating
the spec.** Report: task ID and name · files changed · tests added · test result
with real totals · anything deferred. Paste real output; never claim a pass you
did not see.
