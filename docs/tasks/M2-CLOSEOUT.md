# M2 — Close-out

Audit run 2026-08-07, after M2 was reported complete. Everything below was
re-executed for this document; nothing is carried over from the build.

Environment: PostgreSQL 16.14 (Homebrew) on port 5433, Node 23.3.0, pnpm 9.15.4
via corepack. See [ADR-0004](../adr/ADR-0004-local-postgres-pending-m0-compose.md).

---

## Part 1 — Evidence

### Full suite

```
> @questionbank/api@ test — vitest run --coverage
 Test Files  66 passed (66)
      Tests  1555 passed (1555)

> @questionbank/studio@ test — vitest run
 Test Files  4 passed (4)
      Tests  91 passed (91)

> @questionbank/seed@ test — vitest run
 Test Files  5 passed (5)
      Tests  94 passed (94)
```

**1740 tests, 75 files, 0 failures, 0 skipped.** `pnpm -r typecheck` reports 0
errors across all workspace packages.

### Coverage

```
All files          |   90.98 % stmts |   94.06 % branch |   93.93 % funcs |   90.98 % lines
```

Overall gate ≥80% line / ≥70% branch. Per-module 100% on every
correctness-bearing module (ADR-0008) — the scoring domain, both repositories,
and the application code that resolves pinning and authorization.

### Fitness checks

| Check | Result | Evidence |
|---|---|---|
| F1 — cross-module imports via `public/` barrels | Pass | `boundary-rules.spec.ts`, now generalised to every context, with planted violations |
| F2 — `domain/` imports nothing | Pass | same file; planted domain violation and dynamic-import/`require` evasion |
| F5 — every JSONB column has a `*_schema_version` sibling | Pass | `scoring-schema.integration.spec.ts`, catalogue query over the live database |
| F9 — golden-set regression blocking every commit | **Pass as a harness, vacuous as a gate** | see Part 4 |
| F15 — every endpoint appears in the spec | Pass | `scoring-contract.spec.ts`, `x-handler` reconciled against real policies |
| F18 — every event has an analytics counterpart | Pass | `outbox-emitter.integration.spec.ts` — emission proven transactional by rolling back |
| F36 — a policy-less handler fails the boot | Pass | planted handler fails `ScoringModule.register` |
| F45 — no I/O or clock in the scoring function | Pass | planted clock, randomness and env read all caught |
| F46 — rule set terminates in `ALWAYS` | Pass | unchanged from M1 |
| F47 — every `ItemOutcome` carries a `rule_applied_id` | Pass | type, database constraint, and per-paper assertion |
| F48 — every historical `rule_schema_version` supported | Pass | planted deletion caught |
| F8 — Compose boots ≤ 10 min | **Cannot run** | No Compose stack; blocked by M0 (ADR-0004). Unchanged from M1 |

### Migrations — up, down, up on a clean database

```
$ createdb questionbank_closeout
=== UP #1 ===   curriculum.concept_identity, concept_node, exam, exam_profile_version,
                exam_section_spec, prerequisite_edge, taxonomy_mapping,
                taxonomy_migration, taxonomy_version, platform.outbox_message,
                scoring.item_outcome, rescoring_operation, score_record,
                section_score                                    (14 tables)
=== DOWN ===    schemata matching curriculum|scoring: 0
=== UP #2 ===   tables: 14
```

### `pnpm seed` on a clean database, then re-run

```
=== SEED RUN 1 (clean db) ===
loaded    jee-main-2026.taxonomy.yaml (608 concepts)
loaded    neet-ug-2026.taxonomy.yaml (59 concepts)
published jee-main-2026.profile.yaml
published neet-ug-2026.profile.yaml
seed completed in 0.6s

=== SEED RUN 2 (idempotency) ===
unchanged jee-main-2026.taxonomy.yaml (608 concepts)
unchanged neet-ug-2026.taxonomy.yaml (59 concepts)
unchanged jee-main-2026.profile.yaml
unchanged neet-ug-2026.profile.yaml
seed completed in 0.1s
```

Budget 60 s. Actual 0.6 s.

### Both profiles published end to end

```
 code     | year | state     | marks  | marking_rule_set_hash    | aggregation_schema_version
 JEE_MAIN | 2026 | published | 300.00 | 4fe24605633c…1327a91     | 1
 NEET_UG  | 2026 | published | 720.00 | 048dabf4d75f…c611ae6     | 1
 taxonomy JEE  2026 | published | 608 concepts
 taxonomy NEET 2026 | published |  59 concepts
```

Both hashes are byte-identical to the values ADR-0003 froze at M1 close.

### Score-record immutability under raw `psql`

```
$ psql -c "update scoring.score_record set total_raw = 300"
ERROR:  score_record_is_append_only: only is_current may change, and only from true to false
$ psql -c "delete from scoring.score_record"
ERROR:  score_record_is_append_only: a score record is never deleted; every generation is retained
$ psql -c "update scoring.item_outcome set marks_awarded = 99"
ERROR:  score_detail_is_append_only: item_outcome is append-only and rejects update
$ psql -c "delete from scoring.item_outcome"
ERROR:  score_detail_is_append_only: item_outcome is append-only and rejects delete
$ psql -c "insert into scoring.item_outcome (… rule_applied_id …) values (…, '', 'x')"
ERROR:  new row for relation "item_outcome" violates check constraint "item_outcome_rule_applied_id_check"
```

### M1 carried debt — regression check

| M1 debt | Status at M2 close |
|---|---|
| D1 SME sign-off on both taxonomy datasets | **Not regressed, not closed.** Both files still carry `STATUS: awaiting subject-matter review and sign-off`, asserted by a seed test so it cannot be dropped silently |
| D4 Durable `AuditRecorder` | **Not regressed, still in-memory.** M2 added `scoring/application/ports.ts` with its own `InMemoryAuditRecorder`; every rescoring step is audited through the port, so swapping in the durable one is a wiring change |
| D5 Real `PrincipalResolver` (JWT) | **Not regressed, still in-memory.** M2's authorization *policy* is fully implemented and tested, including step-up; only token verification is stubbed |
| D6 Compose boot verification (F8) | **Not regressed, still blocked by M0** |
| D2/D3/D10 Studio shell, Playwright, browser perf | Untouched by M2 |
| D7/D8/D9 OpenAPI meta-schema, per-endpoint happy paths, consumer contracts | **Partly addressed.** M2's contract spec reconciles `x-handler` against real policies and asserts Problem Details on every error; the 3.1 meta-schema validation (D7) is still open |
| D11 Boundary checker: path aliases, transitive re-exports | Not regressed. The checker was generalised to all contexts at M2-25; those two limits remain |
| D12 Rename `toleranceDefault` → `toleranceDefaults` | Not done. The aggregate was touched at M2-12 without taking it |
| D13 Amend ASSESSMENT-ENGINE §2.4 to the F46-complete form | Not done |
| D14 Reconcile DATA-ARCHITECTURE §4 FK naming | Not done |

---

## Part 2 — Traceability

[M2-TRACEABILITY.md](M2-TRACEABILITY.md) maps every M2 acceptance criterion to
the test that proves it.

---

## Part 3 — The two decisions, scrutinised

### 1. Rationals made canonical → [ADR-0007](../adr/ADR-0007-rationals-are-canonical.md)

| Question | Answer | How verified |
|---|---|---|
| Did any committed golden hash fixture change, including M1-08's? | **No** | `git diff` of `marking-rule-set-hashes.json` against the M1 close-out commit is empty. `marking-rule-set-hash.ts` imports only `node:crypto` and curriculum value objects; `Rational` is in the scoring domain, which Curriculum cannot reach |
| Do any persisted rows carry a pre-canonical hash? | **No** | Marks persist as decimal text via `rationalToDecimalString`, which renders value not representation. `parseRational('4.0000')` equals `parseRational('4')`, asserted |
| Does `RELATIVE_TOLERANCE` stay exact under division? | **There is no division** — the band is the fraction *multiplied* by the magnitude of the expected value. Exact | `compare.spec.ts` scores a `1/3` relative band, which has no decimal expansion |
| Is the 1,000-run byte-identity check measuring something real? | **Yes, and it measures stability rather than correctness** | Three plants, below |

**Three defects found and fixed.** All bypassed `makeRational` with raw object
literals: `RELATIVE_TOLERANCE`'s band in `compare.ts`, and two zero literals in
`rescoring-dry-run.ts`. No comparison was ever wrong — cross-multiplication is
representation-independent — but non-canonical values were escaping into code
whose whole premise is that equal values look equal. A canonicality invariant
test now covers every constructor and operation.

**Planting results.** The suite makes two different claims and each needed its
own plant:

| Planted | Caught by | Result |
|---|---|---|
| `FIXED` award shifted by 0.0001 | golden expected-marks assertions | 12 failures across all 4 papers |
| Output made to vary between runs | 1,000-run byte-identity | 2 failures |
| `Math.random` in the scoring domain | F45 | 1 failure |
| Outcome iteration order reversed randomly | *nothing* — correctly | Summation is order-independent and there is an explicit shuffle-invariance test asserting so |

That last row is the honest one: byte-identity proves **stability**, not
**correctness**. The golden expected-marks assertions are what catch a semantic
change. Neither substitutes for the other, and both are needed.

### 2. Coverage boundary re-scoped → [ADR-0008](../adr/ADR-0008-coverage-follows-correctness-bearing-code.md)

The M2-34 boundary was domain-versus-application. That was wrong. The
application layer is where **pinning** happens — which rule set version, which
item versions, which profile version, and whether the attempt is scored at all.
A bug there yields a correct score computed over the wrong inputs, which looks
right, passes review, and is worse than a crash.

Re-scoped to "does this code determine what gets scored or how". Newly in
scope: both rescoring and scoring handlers, authorization, the handler registry
and the query views. Raising them to 100% took **31 new tests**, every one a
failure path the happy-path suite never reached. One dead export
(`authorizeOwnAttempt`, duplicating an inline check) was found and removed.

---

## Part 4 — M2-30: CARRIED BLOCKING GATE

**The golden-set CI gate is vacuous until this closes.** It runs on every
commit, it catches regressions against its own fixtures, and it proves nothing
whatsoever about agreement with a real answer key. The suite prints
`golden set: 0 official paper(s), 4 synthetic` on every run and a test asserts
`official < 3`, so the gap fails a test rather than living only here.

**The narrower question was researched and is still blocked.** Using released
NTA papers as *internal test fixtures* is narrower than reproducing them in the
product, and the document set anticipates exactly this use —
[DECISIONS.md](../DECISIONS.md) D-016 specifies a golden set "sourced from
released papers with official keys", and [PRD.md](../PRD.md) §M1–M4 names
"golden-set regression against released papers and official keys" as in scope.

But no one has ruled on it. [DECISIONS.md](../DECISIONS.md) §D item 2 —
**Content licensing & IP policy: what may be reproduced, under what
attribution** — is open, requires **legal counsel sign-off**, and is flagged
against existential risk R5. PRD M4 records the same gate. Nothing distinguishes
internal fixture use from product reproduction in any approved document, so
proceeding would be assuming the answer to the question that is explicitly
reserved.

| Field | Value |
|---|---|
| **Owner** | Legal counsel, via the DECISIONS §D item 2 sign-off |
| **Acceptance criterion** | Three released JEE Main papers with official NTA answer keys, committed under `apps/api/src/testing/golden/papers/` with `provenance: "official"` and a `source` citing the key's origin; `golden-regression.spec.ts` reports `3 official` and every paper matches its key at total, sectional and per-item level |
| **What is already done** | Fixture format, loader with provenance enforcement, blocking regression suite, determinism soak. M2-30 is a **pure data drop** — no code change |
| **Decision needed** | One sentence: may released papers with official keys be held in the repository as internal test fixtures, not served to learners? |
| **Carry forward** | Into every handoff until resolved |

---

## Milestone Definition of Done — per-item verdict

| # | Item | Verdict |
|---|---|---|
| 1 | All 35 tasks merged | **Pass — 34/35.** M2-30 blocked, not incomplete |
| 2 | 100% match against official keys on 3 golden papers | **Fail — blocked.** 0 official papers exist (Part 4) |
| 3 | Golden regression blocking, provenance counts reported | **Pass** |
| 4 | Byte-identical across 1,000 runs | **Pass** — verified by planting |
| 5 | Every item outcome names the rule that produced it | **Pass** — type, database, per-paper |
| 6 | Indeterminate awards 0, never `incorrect` | **Pass** |
| 7 | Re-scoring retains both generations; dry-run matches execution | **Pass** — every preview delta checked against the stored record |
| 8 | JEE Advanced partial credit, zero non-data change | **Pass** — 1 file changed, JSON only |
| 9 | NEET `bestOf` — EXT-01 not regressed | **Pass** |
| 10 | All five comparison modes, units, normalization | **Pass** |
| 11 | F45, F47, F48 green, each vs. a planted violation | **Pass** |
| 12 | F1, F2, F5, F15, F18, F36, F46 still green | **Pass** |
| 13 | 100% on correctness-bearing modules; ≥80/≥70 overall | **Pass** — re-scoped per ADR-0008 |
| 14 | `AggregationSpec` in an ADR; M1 hashes unchanged | **Pass** — ADR-0006; hash diff empty |
| 15 | Score records reject mutation via ORM **and** raw SQL | **Pass** |
| 16 | Scoring API serves a synthetic attempt end to end | **Pass** |
| 17 | M2→M3 seam intact | **Pass after a must-fix** — see below |

**16 of 17 pass. Item 2 is blocked, not incomplete.**

---

## Part 5 — M2→M3 seam

`m3-seam.spec.ts` is written against `scoring/public/` **only**, so it stops
compiling the moment the seam needs something the barrel does not export.

It did not compile. **The barrel exported the `ScoreAttempt` command but none
of the types it references** — `ScoringInput`, `ScoredSlot`, `ScoringPin`,
`SlotOverride`, `ResponseSnapshot`, `AnswerKey`, `NumericAnswerSpecData`. A
consumer could name the command and had no way to construct one. M3 or M6 would
have discovered this by reaching into `scoring/domain/`, which F1 forbids, or
by having the barrel widened under time pressure later.

Fixed now, as a must-fix:

- the full input contract, the answer-key shapes and the numeric specification
  are exported as read-only types;
- `createAnswerKey` and `createScoringInput` are exported, so a consumer cannot
  hand-build an unvalidated input;
- `marksToDecimalString` is exported, so no consumer reads a mark through a
  double;
- `marksAvailableExact` moved from the input type to the output type. A caller
  supplies `marksAvailable` and the exact rational is derived, so the two can
  never disagree — previously a caller could supply both and be believed.

Confirmed by test: an `ItemVersion` can carry all four answer-key shapes and a
complete `NumericAnswerSpec` (mode parameters, `UnitSpec`, accepted forms, with
normalization flags defaulted), and an attempt can be assembled end to end from
barrel types alone.

---

## Debt register

Carried from M1, plus what M2 adds. **M2-30 sits at the top because it is a
blocking gate, not debt.**

| # | Item | Owner | Trigger |
|---|---|---|---|
| **B1** | **M2-30 — golden set validated against 3 real released papers.** The CI gate is vacuous until this closes | Legal counsel → Backend | Immediately; carry into every handoff |
| D1 | SME sign-off on the JEE Main and NEET taxonomy datasets | Curriculum SME | Before any exam built on this taxonomy is delivered |
| D2 | Playwright E2E for the four Studio surfaces | Frontend, with M0 | When the Studio app shell and router exist |
| D3 | Studio app shell, router and 1280 px gate | Frontend | Next Studio milestone |
| D4 | Durable `AuditRecorder` writing `identity.audit_record` | Backend | With the Identity schema |
| D5 | Real `PrincipalResolver` (JWT verification) | Backend | With the Identity context |
| D6 | Compose boot verification (F8) | Platform | With M0 |
| D7 | Validate both OpenAPI documents against the 3.1 meta-schema | Backend | Cheap; next API task |
| D8 | Individual happy-path tests for untested curriculum endpoints | Backend | With the consumer-driven contract tests |
| D9 | Consumer-driven contract tests against the live controllers | Backend | When a client consumes the API |
| D10 | "p95 < 200 ms" measured in a browser, not jsdom | Frontend | With D2 |
| D11 | Boundary checker: tsconfig path aliases, transitive re-exports | Backend | If either is introduced |
| D12 | Rename domain field `toleranceDefault` → `toleranceDefaults` | Backend | Next touch of the aggregate |
| D13 | Amend ASSESSMENT-ENGINE §2.4 to show the F46-complete four-rule form | Architecture | Next doc revision |
| D14 | Reconcile DATA-ARCHITECTURE §4 FK naming with handbook §2 | Architecture | Next doc revision |
| **D15** | **Response projection (§4) and F49** — the executor takes projected answers; projection itself is M6's and is untested | Backend | M6 |
| **D16** | **`AggregationSpec` is not yet read from the profile at scoring time** — the executor takes it as a parameter and the column exists, but no code path loads one into a `ScoreAttempt` | Backend | M6, when attempts are assembled |
| **D17** | **Outbox drainer still does not exist** — scoring emits into `platform.outbox_message` and nothing relays it | Platform | With M0 or the relay app |
| **D18** | **Zod request schemas are hand-written, not generated** from `scoring.yaml`. The contract spec catches drift, but M2-27's criterion says generated | Backend | Next API task |

**18 debt items and 1 blocking gate.** Nothing from M1 regressed.
