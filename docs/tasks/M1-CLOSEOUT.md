# M1 — Close-out

Audit run 2026-08-05, after M1 was reported complete. Everything below was re-executed for this
document; nothing is carried over from the build.

Environment: PostgreSQL 16.14 (Homebrew) on port 5433, Node 23.3.0, pnpm 9.15.4 via corepack.
See [ADR-0004](../adr/ADR-0004-local-postgres-pending-m0-compose.md).

---

## Part 1 — Evidence

### Full suite

```
> @questionbank/api@ test — vitest run --coverage
 Test Files  33 passed (33)
      Tests  684 passed (684)

> @questionbank/studio@ test — vitest run
 Test Files  4 passed (4)
      Tests  91 passed (91)

> @questionbank/seed@ test — vitest run
 Test Files  5 passed (5)
      Tests  94 passed (94)
```

**869 tests, 42 files, 0 failures, 0 skipped.** `pnpm -r typecheck` reports 0 errors across all five
workspace packages.

### Coverage (handbook §5 thresholds now enforced)

```
All files          |   92.79 % stmts |   92.64 % branch |   93.02 % funcs |   92.79 % lines
  award.ts         |     100 |      100 |     100 |     100
  condition.ts     |     100 |      100 |     100 |     100
  marking-rule.ts  |     100 |      100 |     100 |     100
  marking-rule-set.ts / marking-rule-set-hash.ts | 100 | 100 | 100 | 100
```

Thresholds are a build gate: ≥80% line/statement/function and ≥70% branch overall, 100% on the five
marking modules. Verified failing before the gaps below were closed.

### Fitness checks

| Check | Result | Evidence |
|---|---|---|
| F1 — cross-module imports via `public/` barrels | Pass | `boundary-rules.spec.ts` 20 tests, incl. planted violation |
| F2 — `domain/` imports nothing | Pass | same file; planted domain violation + planted dynamic-import/require evasion |
| F5 — every JSONB column has a `*_schema_version` sibling | Pass | `curriculum-schema.integration.spec.ts` (catalogue query over the live database) |
| F15 — every public endpoint appears in the spec | Pass | `curriculum-contract.spec.ts` 24 tests, `x-handler` reconciled against the registry |
| F18 — every event has an analytics counterpart or exemption | Pass | `outbox-emitter.integration.spec.ts` |
| F36 — a policy-less handler fails the boot | Pass | `curriculum.module.spec.ts` 5 tests, planted policy-less handler |
| F46 — rule set terminates in `ALWAYS` | Pass | `marking-rule-set.spec.ts` |
| F8 — Compose boots ≤ 10 min | **Cannot run** | No Compose stack; blocked by M0 (ADR-0004) |

### Migrations — up, down, up on a clean database

```
$ createdb qb_closeout
=== UP #1 ===        up ok
  curriculum.concept_identity, concept_node, exam, exam_profile_version,
  exam_section_spec, prerequisite_edge, taxonomy_mapping, taxonomy_migration,
  taxonomy_version, platform.outbox_message          (10 tables)
=== DOWN ===         down ok
  schemata matching curriculum|platform: 0
=== UP #2 ===        up ok again
  tables: 10
```

### `pnpm seed` on a clean database, then re-run

```
=== SEED RUN 1 (clean db) ===
loaded    jee-main-2026.taxonomy.yaml (608 concepts)
loaded    neet-ug-2026.taxonomy.yaml (59 concepts)
published jee-main-2026.profile.yaml
published neet-ug-2026.profile.yaml
seed completed in 0.3s          (wall clock 1.76s including process start)

=== SEED RUN 2 (idempotency) ===
unchanged jee-main-2026.taxonomy.yaml (608 concepts)
unchanged neet-ug-2026.taxonomy.yaml (59 concepts)
unchanged jee-main-2026.profile.yaml
unchanged neet-ug-2026.profile.yaml
seed completed in 0.1s
```

Budget is 60 s. Actual 0.3 s.

### Both profiles published end to end

```
exams: 2
published profiles: 2
JEE_MAIN | year 2026 | published | marks 300.00 | items  75 | hash 4fe24605633c
NEET_UG  | year 2026 | published | marks 720.00 | items 180 | hash 048dabf4d75f
taxonomy JEE  2026 | published | concepts 608
taxonomy NEET 2026 | published | concepts  59
```

### Published-row immutability under raw `psql`

```
$ psql -c "update curriculum.exam_profile_version set total_marks = 1 where state='published'"
ERROR:  published_row_is_immutable: exam_profile_version is published and rejects this update

$ psql -c "update curriculum.taxonomy_version set exam_family='TAMPERED' where state='published'"
ERROR:  published_row_is_immutable: taxonomy_version is published and rejects this update

$ psql -c "update curriculum.concept_node set depth = 99 where taxonomy_version_id in
           (select taxonomy_version_id from curriculum.taxonomy_version where state='published')"
ERROR:  published_parent_is_immutable: concept_node cannot change while its taxonomy version is published
```

### Could not run

| Item | Blocker |
|---|---|
| Compose boot verification (F8) | No Compose stack, no container runtime on this machine — M0 |
| Staging deploy and end-to-end demonstration | No staging environment — M0 |
| Playwright E2E | No assembled Studio app (shell, router, 1280 px gate) — see debt register |

---

## Part 2 — Traceability

[M1-TRACEABILITY.md](M1-TRACEABILITY.md) maps all 178 acceptance criteria across the 35 tasks to the
tests that prove them: **168 ✅ · 6 ⚠️ · 4 ❌.**

---

## Part 3 — Cross-document consistency

Checked against ASSESSMENT-ENGINE §2.1–2.5, DATA-ARCHITECTURE §4, DOMAIN-MODEL §4 and
ENGINEERING-HANDBOOK §1/§2/§8.

| # | Divergence | Location | Verdict |
|---|---|---|---|
| C-1 | `MarkingRuleSet` has no `aggregation: AggregationSpec` | `marking-rule-set.ts:83` vs ASSESSMENT-ENGINE §2.1 | Accept. `AggregationSpec` is named once and defined nowhere; M2 owns aggregation. |
| C-2 | Per-column `*_schema_version` siblings instead of one `policy_schema_version` | `20260805120000_curriculum_schema.sql:110-129` vs DATA-ARCHITECTURE §4 | Accept. F5 requires a sibling per JSONB column; a single shared column cannot satisfy it, and M1-14's own acceptance names four columns each needing one. |
| C-3 | `taxonomy_migration.from_version` / `to_version` are not `<table>_id` | `…curriculum_schema.sql:165-166` vs handbook §2 (FK naming) | Accept. DATA-ARCHITECTURE §4 names these columns explicitly; the more specific document wins. Worth reconciling in the docs. |
| C-4 | Domain field `toleranceDefault` (singular); DB column and DOMAIN-MODEL §4 say `toleranceDefaults` | `exam-profile-version.ts:39` vs DOMAIN-MODEL §4 | Debt (cosmetic). The DB column and the DTO both read `tolerance_defaults`/`toleranceDefaults`; only the domain field is singular. |
| C-5 | `ConceptIdentity.createdInVersion`; DOMAIN-MODEL §4 writes `createdIn` | `concept-identity.ts:10` | Accept. M1-01's acceptance criterion names `createdInVersion`; the task spec is the tighter contract. |
| C-6 | Extra columns beyond DATA-ARCHITECTURE §4: `tenant_id`, `aggregate_version`, `created_at`, `is_active` | `…curriculum_schema.sql` | Accept. P7, P8 and P1 mandate the first three; `is_active` with a partial unique index is what enforces "at most one active profile version per academic year" at the database. |
| C-7 | Four support directories under `apps/api/src` | `src/{testing,fitness,fitness-fixtures,contracts}` vs handbook §1 | Accept — [ADR-0005](../adr/ADR-0005-src-level-support-directories.md). |
| C-8 | Two `throw`s in the application layer | `handler-registry.ts:42,45` vs handbook §8 | Accept. Both are boot-time configuration failures, which F36 requires to be fatal. No request path throws; `domain/` contains zero throws. |

Conformant with no divergence: the eight conditions and three awards (§2.2–2.3), §2.5 overrides
correctly absent from Curriculum, all nine table names, the ten-member error taxonomy (§8), file
naming (all kebab-case), the five-directory context anatomy (§1).

---

## Part 4 — The four deviations

### 1. NestJS at M1-26 rather than M1-19 — **accept**

F36 was proven, not asserted. A planted policy-less handler makes `CurriculumModule.register` throw,
and no controller is built. Five tests in `curriculum.module.spec.ts` — added during this audit,
because the previous coverage tested `HandlerRegistry` alone and not the module boot path.
Recorded as [ADR-0001](../adr/ADR-0001-nestjs-arrives-with-the-http-surface.md).

### 2. In-repo boundary checker replacing dependency-cruiser — **fix now, then accept**

Parity probing found the checker blind to dynamic `import()`, `require()` and bare side-effect
`import 'x'`. A domain module could have reached infrastructure through any of them with the rule
staying green — an evadable fitness function, which is worse than none.

Fixed: `boundary-rules.ts` now matches all four import forms, and
`src/fitness-fixtures/as-domain/planted-evasion.ts` plants a dynamic import and a `require` that the
suite proves are caught. Remaining known limits (no tsconfig path aliases, no transitive re-export
following) are in the debt register. Recorded as
[ADR-0002](../adr/ADR-0002-in-repo-boundary-checker.md).

### 3. JEE Main rule 3 as `ALWAYS → −1` — **fix now**

The critique is correct and the original reasoning was wrong. Corrected to four rules with a neutral
terminal award; golden hashes regenerated; ASSESSMENT-ENGINE's own JEE Advanced set uses the same
neutral termination. Full reasoning and the hash change table are in
[ADR-0003](../adr/ADR-0003-terminal-marking-rule-awards-zero.md).

### 4. Homebrew Postgres on 5433 — **accept as an M0 deferral**

F8 cannot pass and is recorded as failed-blocked, not passed. Confirmed that nothing in the code
depends on port 5433 or a local path: the only two references were `DATABASE_URL ?? <default>`
fallbacks, and both defaults were changed during this audit from 5433 to **5432**, the port Compose
will publish. The local cluster is now reached by exporting `DATABASE_URL`, so the repo carries no
trace of the workaround. Recorded as
[ADR-0004](../adr/ADR-0004-local-postgres-pending-m0-compose.md).

---

## Part 5 — Gap classification

| Gap | Classification | Note |
|---|---|---|
| Staging deploy and end-to-end demonstration | **blocked-by-M0** | No environment exists. DoD item 11 fails. |
| Compose boot verification (F8) for `pnpm seed` | **blocked-by-M0** | |
| Playwright E2E for the four Studio surfaces | **deferred-to-a-later-milestone** | Needs an assembled Studio app — shell, router, 1280 px gate — which M1 never builds. Component tests and axe scans cover behaviour; the browser journeys do not exist. |
| SME sign-off on both taxonomy datasets | **debt — release gate** | Not testable. Both files carry `STATUS: awaiting subject-matter review and sign-off`, asserted by a test so it cannot be dropped silently. Must clear before any exam built on this taxonomy is delivered. |
| In-memory audit port (`AuditRecorder`) | **deferred-to-a-later-milestone** | `identity.audit_record` (P3) belongs to the Identity schema. The port is exercised by every handler test. |
| In-memory auth port (`PrincipalResolver`) | **deferred-to-a-later-milestone** | JWT verification is the Identity context's work. Authorization *policy* is fully implemented and tested here. |
| CI coverage thresholds | **must-fix-now → fixed** | Enforced in `apps/api/vitest.config.ts`; `pnpm test` fails below them. |

### Fixed during this audit

1. **Marking rule sets corrected to four rules** with a neutral terminal award (ADR-0003); golden
   hashes regenerated; both shipped profiles and all fixtures updated.
2. **Boundary checker parity** — dynamic import, `require`, and side-effect imports now detected,
   with a planted evasion fixture proving it.
3. **F36 proven at the module boot path**, not only at the registry (`curriculum.module.spec.ts`).
4. **Coverage thresholds enforced** per handbook §5, including 100% on the five marking modules.
5. **Two real coverage gaps closed on the scoring surface**: `MATCHING_PAIRS_CORRECT` was never
   exercised through the canonical hash (a rule set using it would have been hashed by untested
   code), and a dead comparator arm was removed from the serializer.
6. **Database URL defaults moved from 5433 to 5432** so the repo matches Compose, not this laptop.

---

## Milestone Definition of Done — per-item verdict

| # | Item | Verdict |
|---|---|---|
| 1 | All 35 tasks merged | **Pass** — 35/35, with the SME gate on M1-28 outstanding |
| 2 | JEE Main 2026 taxonomy (600 concepts) and profile published | **Pass** — 608 concepts, published end to end above |
| 3 | NEET UG published with zero non-data file changes — CI-asserted | **Pass** — `git diff` over the NEET commit range returns only 3 data files |
| 4 | Every published version rejects mutation via ORM **and** raw SQL | **Pass** — 19 trigger tests plus the raw `psql` transcript above |
| 5 | Migration dry-run produces a correct exception list on a real version pair | **Pass** |
| 6 | JEE Advanced-shaped rule set validates and hashes (EXT-03) | **Pass** — 7-rule set publishes; hash `556c3c63…` unchanged by this audit |
| 7 | Fitness functions F1, F2, F5, F36, F46 green | **Pass** — F15 and F18 additionally |
| 8 | Authorization negative-path coverage 100% on curriculum handlers | **Pass** — all 22 handlers/queries have negative-path tests; branch coverage now measured, though not per-path-attributed |
| 9 | `pnpm seed` completes in ≤ 60 s | **Pass** — 0.3 s |
| 10 | Studio taxonomy and profile surfaces pass automated accessibility scan | **Pass** — axe WCAG 2.2 AA clean on all four surfaces |
| 11 | Deployed to staging and demonstrated end to end | **Fail — blocked by M0** |

**10 of 11 pass. Item 11 is blocked, not incomplete.**

---

## Debt register

| # | Item | Owner | Trigger |
|---|---|---|---|
| D1 | SME sign-off on the JEE Main and NEET taxonomy datasets | Curriculum SME | Before any exam built on this taxonomy is delivered |
| D2 | Playwright E2E for the four Studio surfaces | Frontend, with M0 | When the Studio app shell and router exist |
| D3 | Studio app shell, router and 1280 px gate (FRONTEND §9) | Frontend | Next Studio milestone |
| D4 | Durable `AuditRecorder` writing `identity.audit_record` | Backend | With the Identity schema |
| D5 | Real `PrincipalResolver` (JWT verification) | Backend | With the Identity context |
| D6 | Compose boot verification of `pnpm seed` (F8) | Platform | With M0 |
| D7 | Validate the OpenAPI document against the 3.1 meta-schema | Backend | Cheap; next API task |
| D8 | Individual happy-path tests for the 16 untested endpoints | Backend | With the consumer-driven contract tests |
| D9 | Consumer-driven contract tests against the live controller | Backend | When a client consumes the API |
| D10 | "p95 < 200 ms" measured in a browser, not jsdom | Frontend | With D2 |
| D11 | Boundary checker: tsconfig path aliases, transitive re-exports | Backend | If either is introduced |
| D12 | Rename domain field `toleranceDefault` → `toleranceDefaults` (C-4) | Backend | Next touch of the aggregate |
| D13 | Amend ASSESSMENT-ENGINE §2.4 to show the F46-complete four-rule form | Architecture | Next doc revision |
| D14 | Reconcile DATA-ARCHITECTURE §4 FK naming with handbook §2 (C-3) | Architecture | Next doc revision |
