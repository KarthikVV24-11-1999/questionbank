# Handoff — M0 in progress, M0-01 through M0-23 merged, green at HEAD

**23 of 27 tasks merged.** Track A, B, C and **all of Track D (authored infrastructure)** are complete.
Track E (gates and close-out, M0-24 through M0-27) has not started.

Supersedes [HANDOFF-M0-RESUME-4.md](HANDOFF-M0-RESUME-4.md) and every earlier handoff.

---

## Green at HEAD

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5433/questionbank_test"
corepack pnpm -r typecheck
corepack pnpm -r --workspace-concurrency=1 test
```

Both exit 0.

| Project | Files | Tests |
|---|---|---|
| `apps/api` | 148 | **3489** |
| `apps/studio` | 16 | **272** |
| `packages/content-renderer` | 4 | **118** |
| `packages/contracts` | 2 | **10** |
| `packages/domain-types` | 1 | **2** |
| `tools/seed` | 5 | **94** |

---

## What landed this session (M0-20 → M0-23) — Track D, Tier 2 throughout except M0-23

- **M0-20** — `infra/compose/docker-compose.yml`: six services set-equal to the closed constant, every
  healthcheck complete, every `depends_on` in map form with `service_healthy`, no `latest` tag, postgres on
  5432, no key-shaped env var. `compose-rules.ts` proves each assertion red against a planted mutation of
  the parsed structure. **ADR-0013** (the three-tier rule) and the **ADR-0004 amendment** land here — F8
  stays `Fail — blocked`.
- **M0-21** — `.github/workflows/ci.yml`: five jobs, zero assertions of its own, integration against a
  `postgres:16` service container preserving `--workspace-concurrency=1`. `ci-rules.ts` proves job coverage
  of every workspace project and Node-version parity with `engines.node`, red against five planted
  mutations. States plainly it has never been executed by a CI provider.
- **M0-22** — `infra/terraform/staging/`: API on ECS Fargate, RDS PostgreSQL 16 (never Aurora), security
  groups, ECR repo, secrets referenced by name/ARN only, S3 state backend. `terraform-rules.ts` is a text
  lint — no HCL parser or provider plugin offline — proven red against five planted fixtures; names
  `terraform init && validate && plan` verbatim.
- **M0-23** — **the one Tier-1 task in this track.** `secret-rules.ts` really scans source,
  `infra/compose/`, `infra/terraform/`, `.github/workflows/` and every `*.example` for AWS-shaped keys, PEM
  headers, a key=value secret assigned a non-placeholder string, and high-entropy quoted literals — clean
  against the real tree, proven able to fail against five planted fixtures. Root `.env.example` created,
  asserted equal to `config.ts`'s own env-var names (newly exported for this) in both directions.

**Two real false-positive traps found and fixed while proving M0-23 against the real tree, not assumed
clean:** the key-value pattern originally matched any `token = expr`, catching ordinary parser code
(`const token = parser.tokens[i]` in `content-renderer`) as a secret — tightened to require a quoted string
value. `fitness-fixtures/` itself wasn't excluded from the default scan, so the planted fixtures counted as
violations against themselves on the first run — excluded, matching every other fitness check's own
convention.

---

## Read first — these only

| Document | Read |
|---|---|
| [tasks/M0-WALKING-SKELETON.md](tasks/M0-WALKING-SKELETON.md) | **The entries for M0-24 through M0-27** — Track E, gates and close-out |
| [tasks/M0-PROGRESS.md](tasks/M0-PROGRESS.md) | One sentence per task, in order |
| [adr/ADR-0013](adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md) | The tier rule every Track D spec cites |

---

## Where to resume: M0-24 (closes D9)

Not started. `content-rules.integration.spec.ts:84` currently asserts the `questionbank_app` deployment role
does not exist locally — M0-24 lands it, making F7/F40 non-vacuous for the first time, and that existing
test must be **rewritten to assert the role is present and holds the right grants**, never deleted (DEC-M0-14
rule 3, already applied once this session for `StudioShell.spec.tsx`'s DEC-5 entry-point test).

M0-25 through M0-27 (the rest of Track E) follow — read them fresh.

---

## Environment

Unchanged from [HANDOFF-M0-RESUME-4.md](HANDOFF-M0-RESUME-4.md).

---

## Carried forward

### B1 — still open. Do not source papers.

### Debt

**Unchanged this session** — nothing in Track D touched a context's runtime behavior. D19–D21, D22
(closed), D23–D26, D27 (closed), D28–D34 all carry forward as HANDOFF-M0-RESUME-4.md records them. **D9 is
Track E's to close (M0-24), still open.**
