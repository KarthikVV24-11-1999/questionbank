# Implementation decisions

The `DEC-*` identifiers cited throughout the code. Each was taken when a milestone was planned,
before the code it governs was written, and most are cited in the module that enforces them.

**The code is the authority, not this file.** An entry here is an index entry: enough to know what
`DEC-M4-15` means when a comment cites it, and where to read the real thing. Where the two disagree,
the code is right and this file is stale. `decision-rules.spec.ts` fails the build if an identifier
is cited with no entry here, or carried here and cited nowhere.

**Three registers share the letter D, and they are not the same thing.** `D1`–`D10` are the
domain-model design decisions in [DOMAIN-MODEL.md](DOMAIN-MODEL.md); anything numbered above ten in
that same form is debt, in [DEBT.md](DEBT.md). `D-001`/`D-002`, hyphenated, are the product decisions
in [DECISIONS.md](DECISIONS.md). `DEC-*`, here, are implementation decisions.

**Numbering has gaps**, and some identifiers are reused. Both are recorded rather than tidied —
see *Collisions* below.

---

## Collisions — the same identifier, two decisions

Unqualified `DEC-n` means **M3's** plan, which is the overwhelming majority of its use. Three
identifiers were also used for an earlier milestone's decision, and the citing file's location is
what tells them apart. The planning documents that would settle this no longer exist, so both senses
are recorded rather than one being guessed at.

| Identifier | Under `contexts/content/**`, `apps/studio/**`, `packages/content-renderer/**` | Elsewhere |
|---|---|---|
| **DEC-2** | M3 — the closed node vocabulary | **M2**, in `src/testing/golden/**` — the golden-set real-paper gate |
| **DEC-3** | M3 — the answer key and the content → scoring seam | **M2**, in `contexts/scoring/domain/**` — invalid overrides are unconstructible |
| **DEC-6** | M3 — media bytes outside the database *(`contexts/content/**`)* | M3 — chemical notation vs. structures *(`packages/content-renderer/**`)* |

`DEC-1` is also cited once as "M2 DEC-1" ([ADR-0006](adr/ADR-0006-aggregation-spec-on-exam-profile-version.md)),
explicitly qualified, for a different decision: `AggregationSpec` lives on `ExamProfileVersion`.

---

## M3 — the content model

### DEC-1 — Content owns the lifecycle state machine
Every legal transition, every refusal and every publication precondition lives in content's domain.
Handlers drive a machine they do not own: they authorize, resolve the facts the domain cannot know,
save and audit. The load-bearing criterion is that publication is blocked without tags, provenance,
resolved licensing, a solution, a reviewer signature and a valid answer specification — and every one
of those checks lives in the domain.
→ [ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) · `application/handlers/lifecycle-handlers.ts`

### DEC-2 — The node vocabulary is closed
A renderer that meets a node kind it does not know cannot render it, and INV-14 promises
deterministic rendering across web, mobile, offline and print. Adding a node is a reviewed change in
`content-body.ts` *and* in the renderer, plus a `schemaVersion` bump. The constructor crosses the
public barrel too, because a consumer that hand-built a `ContentBody` would build one the renderer
has never been asked to render.
→ `domain/content-body.ts` · `renderer-seam.spec.ts` · *(see Collisions — M2's DEC-2 is the golden-set gate)*

### DEC-3 — The answer key lives on the response specification
`ResponseSpecification` carries the key, and `answer-key-projection.ts` is the M3 → M2 seam that turns
it into the `AnswerKeyData` the executor consumes. Its guarantee is enforced on the write path: **a
specification whose projection the executor refuses cannot be saved**, so an author is told what is
wrong with their numeric item rather than a database constraint name. The item-type vocabularies on
both sides must agree, asserted as a set equality so either side drifting shows up.
→ `application/answer-key-projection.ts` · *(see Collisions — M2's DEC-3 is about overrides)*

### DEC-4 — Authoring DTOs carry the answer key; delivery DTOs never do
Three conditions, ratified before M3-01 and not negotiable at the point of enforcement:
1. The authoring route list is **enumerated and closed** (`x-authoring-routes` in `content.yaml`),
   never inferred from a path prefix — a prefix check makes `/v1/authoring-preview/…` an authoring
   route by accident.
2. The check asserts **both directions** — keys absent from every delivery schema, *and* present on
   every authoring schema meant to carry one. A one-directional check passes when somebody silently
   removes the key from the editor.
3. No `Authoring*` DTO is reachable from a delivery controller, asserted **by import graph** rather
   than naming convention, because a rename defeats a convention.
→ [ADR-0009](adr/ADR-0009-authoring-dtos-carry-the-answer-key.md) · `fitness/content-rules.ts`

### DEC-5 — The Studio has no router
The route table is data the shell consumes. Filters live in the URL so a screen is a link somebody
can send, and the query string is reached through a small port — the router, when it exists, replaces
the port and nothing else. Asserted negatively on every surface: the shell, the item browser, queue
management and the review workspace each have a test that they import no router.
→ `apps/studio/src/shell/navigation.ts` · carried as debt **D30**

### DEC-6 — Media bytes live outside the database and outside the domain
`ApplicationPorts` is the only place in the content context where a byte array is named, so that no
command, handler, DTO, route or event has to — asserted by source scan. A command names a
`storageKey`, never content; the upload edge puts the bytes and the store answers with a key. The
failure being prevented is a base64 blob in a JSONB column, invisible until the table is unmanageable.

*In `packages/content-renderer/**` the same identifier marks a different decision:* chemical
**notation** renders through the same MathML pipeline as mathematics, while chemical **structures**
are deliberately out of scope and degrade to a documented affordance — "author it as a diagram asset"
— rather than a half-drawn ring. Carried as debt **D19**.
→ `application/ports.ts` · `packages/content-renderer/src/chem-to-mathml.ts`

### DEC-7 — The import path cannot create a draft the editor would refuse
The batch format is JSON Lines with a **header record first** carrying the batch identity, the source
description and a licensing declaration every record inherits. The parser turns bytes into records and
asserts nothing about their shape, so every authored body goes back through `createContentBody` —
without which a document could carry an equation with a blank `textAlternative` that the interactive
editor refuses and ACC-02 forbids. Import runs **no duplicate check and says so** in words; duplicate
detection is M4's.
→ `application/import/import-batch.ts` · `application/handlers/import-handlers.ts`

---

## M0 — the walking skeleton

### DEC-M0-1 — A check that cannot read its input and says nothing is a vacuous check
A glob shaped in a form the parser does not handle is rejected rather than silently ignored, and every
scan asserts that it scanned something. The standing instruction is against a vacuous green.
→ `fitness/workspace-rules.ts` · `platform/composition/app-factory.spec.ts`

### DEC-M0-2 — The workspace is checked for internal consistency
Not a boundary rule: every package the `pnpm-workspace.yaml` globs could reach has a `package.json`,
and every one of those declares the `test` and `typecheck` scripts the root scripts call.
→ `fitness/workspace-rules.ts`

### DEC-M0-3 — The CI workflow is a thin caller with no assertions of its own
Every gate lives in `apps/api/src/fitness/` and is run from the workflow by name — one implementation,
run the same way locally and in CI. An inline assertion in a `run:` step is a violation the workflow
parser catches.
→ `.github/workflows/ci.yml` · `fitness/ci-rules.ts` · see also [ADR-0023](adr/ADR-0023-the-ci-workflow-is-executed-and-leaves-tier-2.md)

### DEC-M0-5 — The composition seam is a fourth barrel export
`platform/composition/` may import only `contexts/*/public/composition.js`. A context composes its own
handlers, repositories and adapters and returns a `DynamicModule`; nothing in the composition root
reaches past that seam, which is why a context that owns a domain type is the only thing that can
construct one from validated configuration.
→ [ADR-0015](adr/ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md) · `contexts/*/public/composition.ts`

### DEC-M0-6 — The Learn shell is deferred
ROADMAP named "Learn and Studio app shells" under M0; there is no `apps/learn`. Building it would be
three weeks of work five milestones early, in the wrong bounded context, that M8 would have to inherit
or throw away. The same argument was later reused to refuse a minimal user table.
→ [ADR-0012](adr/ADR-0012-the-learn-shell-is-deferred-to-m6.md)

### DEC-M0-7 — The auth stub issues a principal, not an identity
There is no user store, no password, no refresh rotation, no revocation list and no role assignment —
all five are Identity's, in M8. Signing keys have **no default**, deliberately: a key an application
never chose to set is not a safe one.
→ [ADR-0014](adr/ADR-0014-the-auth-stub-issues-a-principal-not-an-identity.md) · `platform/auth/token.ts`

### DEC-M0-8 — Configuration is read once, at one place
`loadConfigFromProcessEnv` is the only reader; `loadConfig` itself is pure and takes `env` as a
parameter. Test and tool support is not shipped runtime and defaults `DATABASE_URL` independently of
the running application's config. In Compose, postgres publishes 5432.
→ `platform/config/config.ts` · `fitness/platform-rules.ts`

### DEC-M0-9 — Liveness and readiness are two routes, not one
`/healthz` answers "is this process alive"; `/readyz` answers "can this instance serve a request right
now", which here means the database is reachable. Compose's `depends_on: { condition: service_healthy }`
depends on that difference existing as two routes. Neither is authenticated and neither is contract.
→ `platform/http/health.controller.ts`

### DEC-M0-10 — One interceptor turns a request into a span tree
It sits entirely in `platform/`, wired once in `createApplication`, and wraps whatever the matched
controller does. No context file changes to get tracing. The exporter is deferred — debt **D31**.
→ `platform/observability/telemetry.interceptor.ts`

### DEC-M0-11 — Terraform is linted as text, not validated
There is no HCL parser and no AWS provider plugin in the offline store, so the rules scan the text of
every `.tf` file. What that proves is exactly what a text scan can honestly prove, and nothing about
whether the configuration would apply.
→ [ADR-0013](adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md) · `fitness/terraform-rules.ts`

### DEC-M0-13 — Navigation over the History API, not a router
A typed route table turned into working back/forward. **Not a router**: no nested layouts, no loaders,
no code splitting, no validated search state — deliberately small enough to delete in an afternoon.
→ `apps/studio/src/shell/use-route.ts` · carried as debt **D30**

### DEC-M0-14 — Rule 3: when a fact changes, rewrite the test to assert the new truth
A test left asserting something that has stopped being true is worse than no test. Where M0 closed a
gap an earlier test recorded as absent, the test was rewritten to assert presence rather than left
recording an absence.
→ `fitness/content-rules.integration.spec.ts` · `apps/studio/src/shell/StudioShell.spec.tsx`

---

## M4 — governance and the review workspace

### DEC-M4-1 — The ageing sweep releases and escalates; escalation does not reassign
One command, one handler, nothing that implies a timer. It releases every expired lease and writes a
role-targeted escalation row that Content Ops acts on — it never claims, assigns or otherwise decides
who holds an item. A version whose `stateEnteredAt` the domain refuses is skipped, not the whole sweep
failed.
→ `application/review/handlers/ageing-handlers.ts`

### DEC-M4-2 — Decision evidence: absent and empty are different answers
`candidatesShownIds` is **required and may be empty**. A caller that never ran the duplicate check must
say so by omitting the field entirely, never by sending `[]` — collapsing the two is exactly what
`assertDecisionEvidenceComplete` exists to prevent. Fingerprints are computed on claim, when the full
`ItemVersion` is already in hand.
→ `domain/review/decision-evidence.ts` · `application/commands/lifecycle-commands.ts`

### DEC-M4-3 — Approve-with-edits is a reviewer act, and the author stays the author
The reviewer is recorded in `editedBy`, the edit is bounded by an enumerated scope, and an
out-of-scope edit is refused with the field named. No second reviewer is required for the common case.
→ [ADR-0018](adr/ADR-0018-approve-with-edits-keeps-the-author.md) · `application/review/handlers/reviewer-edit-handlers.ts`

### DEC-M4-4 — The audit chain is database-enforced and locally anchored
The hash is computed in the database so the chain cannot be bypassed by an application that forgets.
The daily anchor is HMAC-signed with a key that **must differ** from the auth signing key — one key
compromised should not forge both sessions and history. External witnessing is Tier 3,
`Fail — blocked`: no network, no account, no witness.

> **Correction (2026-08-20).** DEC-M4-4 stated the link as `sha256(canonical(row) ‖ prev_hash)`;
> M4-22's acceptance criterion states the opposite order. **M4-22's order governs** —
> `SHA-256 over prevHash ‖ canonical` — and is normative in
> [ADR-0020](adr/ADR-0020-the-audit-chain-is-database-enforced-and-locally-anchored.md). Both orders
> are sound; what mattered was fixing one, because the point of the decision is that two
> implementations produce identical bytes.

→ [ADR-0020](adr/ADR-0020-the-audit-chain-is-database-enforced-and-locally-anchored.md) · `platform/persistence/audit-link.ts`

### DEC-M4-5 — No reviewer pool exists anywhere in M4
The throughput gate and QC sampling's second-review assignment are blocked on **one** missing
resource, not two. The wording was fixed at the start of the milestone rather than at its end, so it
could not drift toward "basically met" as pieces landed — and that wording is itself enforced:
`timing-criterion.spec.ts` fails the build if the gate's phrase appears anywhere without its status
beside it.
→ `src/testing/review/timing-criterion.spec.ts` · `src/testing/review/machine-time.integration.spec.ts`

### DEC-M4-6 — `ItemDefect` and `AnswerKeyChallenge` move to M5
Taken at ratification, before any M4 code was written. An upheld challenge needs a corrected published
version and debt **D25** forbids exactly that, so the intake would have shipped a loop that does not
close — worse than not shipping it, because it looks like a feature.
→ [ADR-0022](adr/ADR-0022-item-defect-and-answer-key-challenge-move-to-m5.md)

### DEC-M4-7 — The review sub-boundary inside content
`authoring/` imports nothing from `review/`; `review/` reaches authoring only through `domain/**` and
four named shared contracts. It governs `application/` and `infrastructure/`, **never `api/`**
(amended 2026-08-26). A handler in `application/review/**` cannot reach a private helper in
`lifecycle-handlers.ts`, which is why a one-line error unpacking appears in both — field names, not a
rule, so there is no judgement to drift.
→ [ADR-0019](adr/ADR-0019-the-review-workspace-lives-inside-content.md) · `fitness/content-rules.ts`

### DEC-M4-8 — Review is subject-scoped, and the subject is resolved rather than declared
For a subject-scoped author their scope **is** the subject of everything they author; a Physics-scoped
principal has no legitimate reason to declare anything else. A review assignment without a subject is
refused at construction. What stays open is a principal whose scope changes between creation and a
later touch — debt **D23**.
→ `application/authorization.ts` · `domain/review/review-assignment.ts`

### DEC-M4-9 — Two assignment paths, and `content_ops` has no claim path
The reviewer's **pull** (`ClaimNextForReview`, subject declared and checked against their own scope)
and Content Ops' **push** (`ReassignReview`, naming the reviewer directly, used when handling an
escalation). Content Ops is refused a claim path outright. The queue's confidence signal is "clean
items first", computed from M3's existing validation counts rather than a second implementation.
→ `application/review/commands/assignment-commands.ts` · `application/review/policies.ts`

### DEC-M4-10 — The undo window is a client-side delay, not a compensating record
`content.review_decision` is append-only with no mutator, and the transition table has no reverse edge
from `approved` back to `in_review` — so there is nothing to retract once a decision reaches the
server. Nothing is sent until the window elapses. A reviewer who closes the tab inside it loses that
decision; the item stays claimed until its lease expires, which is recoverable by re-deciding.
→ `apps/studio/src/features/review-workspace/undo-buffer.ts`

### DEC-M4-11 — A non-approving outcome names a reason from the taxonomy
Ten reasons, chosen by keystroke. `DUPLICATE` must name its target. The taxonomy exists in two places
— the domain's declaration and the mirror the Studio imports — and a parity test asserts them equal
over the whole table.
→ `domain/review/rejection-taxonomy.ts` · `packages/contracts/src/review-taxonomy.ts`

### DEC-M4-12 — Review is inside the authoring family
Routes mount under `/v1/authoring/review/**`, the enumerated key-bearing prefix ADR-0009 already closes
over, which is why reviewing needed no amendment to it. The honest proof is the opposite of delivery's:
a review response is *capable* of carrying key material when the caller asks for it.
→ `contexts/content/api/review.controller.ts`

### DEC-M4-13 — Queue health is Content Ops' capacity-planning surface
Depth and pace are visible; there is **no per-reviewer comparison, rank or leaderboard**. A `reviewer`
principal sees only their own decisions; only `content_ops` sees every reviewer's breakdown and the
true aggregate. Overdue items are derived live from `ageState`, never read from the escalation table —
which nothing populates without a scheduler (**D36**).
→ `application/review/queries/queue-queries.ts` · `application/review/policies.ts`

### DEC-M4-14 — QC sampling is deterministic, and never on the critical path
`isSampled` hashes the decision id, so the same decision samples the same way years later. It is
deliberately **not** wired into the decision handler: a decision's outcome and timing cannot depend on
whether it lands in the sampled 5%. Blocking on it would put a second reviewer on the critical path of
one approval in twenty and destroy the throughput the milestone exists to produce.
→ `domain/review/qc-sampling.ts`

### DEC-M4-15 — Nothing in M4 is scheduled
`now` is supplied by the caller and never read from a clock inside the domain or application layer. The
HTTP boundary is where the wall-clock read belongs, and a scheduler firing the sweep on the hour would
apply the same discipline. `SweepReviewAgeing` and `RefreshFingerprints` have no route — neither is a
reviewer-facing action. Carried as debt **D36**.
→ `application/review/commands/ageing-commands.ts` · `contexts/content/api/review.controller.ts`

### DEC-M4-16 — Tripwires on the audit chain
Tripwire 2: the app role gains no `UPDATE`. §9 rule 11 already withholds `UPDATE`/`DELETE`/`TRUNCATE`
on every platform table, and the chain columns must not become the reason that softens. The backfill
disables the append-only trigger for the length of one statement inside the migration's transaction
and re-enables it, rather than weakening the rule permanently for a one-time migration.
→ `infra/migrations/20260820190000_platform_audit_chain.sql`
