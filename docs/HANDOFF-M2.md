# Handoff — M1 Closed, M2 Starting

**State as of 2026-08-05:** M1 (Curriculum Spine) is complete and audited. 869 tests pass across
three packages; `pnpm -r typecheck` is clean. Close-out evidence, per-item DoD verdicts and the debt
register are in [tasks/M1-CLOSEOUT.md](tasks/M1-CLOSEOUT.md).

## Where to start

**Task M2-01.** M2 is the scoring rule executor: it evaluates a `MarkingRuleSet` against an attempt's
responses and produces `ItemOutcome`s and a `ScoreRecord`.

## Required reading for M2 — these only

| Document | Read |
|---|---|
| [ASSESSMENT-ENGINE.md](ASSESSMENT-ENGINE.md) | §2 in full (the rule language), §3 scoring execution, §2.5 item-level overrides |
| [DOMAIN-MODEL.md](DOMAIN-MODEL.md) | §2 D3 and D6, §7 Scoring (`ScoreRecord`, `RescoringOperation`) |
| [ENGINEERING-HANDBOOK.md](ENGINEERING-HANDBOOK.md) | §5 testing, §8 error handling, §9 architecture rules |
| [adr/ADR-0003](adr/ADR-0003-terminal-marking-rule-awards-zero.md) | Why the terminal rule awards 0 — this directly shapes the executor |
| [tasks/M1-CLOSEOUT.md](tasks/M1-CLOSEOUT.md) | Debt register and the M1→M2 seam |

The standing rules from M1 still apply: `domain/` imports nothing; domain and application return
typed results and never throw; integration tests use real Postgres, never a mock.

## Running things

```bash
pnpm install
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test    # 869 tests; coverage gate on apps/api
pnpm seed                                  # loads + publishes both taxonomies and both profiles
```

**Database caveat.** M1 was built without Docker. `DATABASE_URL` defaults to
`postgres://postgres@127.0.0.1:5432/…` — the port Compose will publish — so once M0 lands, nothing
needs changing. Until then, supply your own Postgres 16 and export `DATABASE_URL`. The machine M1 was
built on runs a Homebrew cluster on **5433**:

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"   # tests
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank"        # pnpm seed
```

Integration specs create and drop the `curriculum` and `platform` schemas, so point them at a
throwaway database. See [adr/ADR-0004](adr/ADR-0004-local-postgres-pending-m0-compose.md).

`pnpm` is not on PATH in every environment; `corepack pnpm …` works everywhere.

## The M1 → M2 seam

Verified end to end by `apps/api/src/contexts/curriculum/m2-seam.integration.spec.ts` (16 tests).
M2 should not need to reach past these.

| What M2 needs | Where it is | Guarantee |
|---|---|---|
| The marking rule set, as data | `contexts/curriculum/public/index.ts` → `MarkingRuleSetData`, `MarkingRuleData`, `Condition`, `Award` | Type-only exports. The barrel's entire value surface is one constant, so no aggregate can be mutated from outside. |
| Rule order | Preserved through persistence | A 7-rule set round-trips in evaluation order. **First match wins** — order is semantic. |
| `schemaVersion` | On the rule set and in `marking_rule_set_schema_version` | Pinned into every `ScoreRecord` (R2). |
| Canonical hash | `hashMarkingRuleSet`, frozen at publication into `marking_rule_set_hash` | Golden fixtures in `apps/api/src/testing/golden/`. A hash change means a scoring-semantics change. |
| `NumericAnswerSpec` | Via the profile's `toleranceDefault`; DTO on the barrel | Carries expected value **as the authored decimal literal** (not a float — `SIGNIFICANT_FIGURES` depends on it), mode parameters, `UnitSpec`, accepted forms, and all four normalization flags. |
| `goldenSetValidation` | `ExamProfileVersion.goldenSetValidation`, defaulted `{status:'not_run'}` | Writable on a draft via `recordGoldenSetValidation`; frozen once published. Run the golden set, record it, then publish. |
| Immutability of what a score is pinned to | Database triggers | A published profile's rule set and hash reject raw SQL `UPDATE` and `DELETE`. Proven from `psql`, not just the ORM. |

Two things M2 owns that M1 deliberately left alone:

- **`AggregationSpec`** (ASSESSMENT-ENGINE §2.1) is not modelled. It is named once in the docs and
  defined nowhere. M2 owns score aggregation and should define it.
- **Item-level overrides** (§2.5: `DROPPED`, `BONUS`, `KEY_CORRECTED`) apply *before* rule evaluation
  at the form level. They belong to Assessment/Scoring, not Curriculum.

## Accepted deviations carried into M2

| # | Deviation | Rationale |
|---|---|---|
| [ADR-0001](adr/ADR-0001-nestjs-arrives-with-the-http-surface.md) | NestJS introduced at M1-26, not M1-19 | F36 is enforced by `HandlerRegistry` and `CurriculumModule.register`, both proven with planted violations. Nest injection uses explicit `@Inject` tokens because esbuild emits no decorator metadata. |
| [ADR-0002](adr/ADR-0002-in-repo-boundary-checker.md) | In-repo boundary checker instead of dependency-cruiser | dependency-cruiser refuses to run on Node 23. Parity proven for all four import forms, including dynamic `import()` and `require()`. |
| [ADR-0003](adr/ADR-0003-terminal-marking-rule-awards-zero.md) | Terminal `ALWAYS` awards 0, never a penalty | **Read this before writing the executor.** JEE Main is four rules: `UNATTEMPTED→0`, `EXACT_MATCH→+4`, `NO_MATCH→−1`, `ALWAYS→0`. An unanticipated response state must never cost a candidate a mark. |
| [ADR-0004](adr/ADR-0004-local-postgres-pending-m0-compose.md) | Local Postgres on 5433 pending M0 | F8 cannot pass and is not claimed. No code depends on the port. |
| [ADR-0005](adr/ADR-0005-src-level-support-directories.md) | Four support directories under `apps/api/src` | `testing/`, `fitness/`, `fitness-fixtures/`, `contracts/`. None imported by production code. |

## Open debt, with owners

Full register in [tasks/M1-CLOSEOUT.md](tasks/M1-CLOSEOUT.md#debt-register). The ones that touch M2:

| # | Item | Owner | Why M2 should care |
|---|---|---|---|
| D1 | **SME sign-off on both taxonomy datasets** | Curriculum SME | Release gate. The data is structurally sound and content-unreviewed. |
| D4 | Durable `AuditRecorder` (`identity.audit_record`) | Backend | Re-scoring is a consequential command and will need real audit. |
| D5 | Real `PrincipalResolver` (JWT) | Backend | Re-scoring needs step-up authorization, which needs a real principal. |
| D6 | Compose boot verification (F8) | Platform | Unblocks the staging DoD item M1 could not meet. |
| D2/D3/D10 | Studio app shell, Playwright E2E, browser perf | Frontend | Not on M2's path. |
| D7/D8/D9 | OpenAPI meta-schema validation, per-endpoint happy paths, consumer contract tests | Backend | Adopt the same pattern when M2 adds endpoints. |

## What M1 does not give you

- No running application. There is no `main.ts`, no HTTP server bootstrap, no Compose, no CI.
  `CurriculumModule.register` builds the module; nothing calls it outside tests.
- No Studio app — four feature components with tests, no shell or router.
- No authentication, no audit persistence, no outbox relay (the outbox table and emitter exist; the
  drainer does not).
