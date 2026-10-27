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

### DEC-M5-1 — Two M5 acceptance criteria are `Fail — blocked` from the start
First-pass review acceptance (≥ 60%) and cost per published item (≤ 40% of the human-only baseline)
cannot be measured here: both need a reviewer pool, and none exists. The wording is fixed at the start so
it cannot drift toward "basically met" as pieces land — the same move DEC-M4-5 made for reviewer
throughput. They are blocked on **one** resource, not two, and what they do *not* block is the
verification catch rate (F34) and the evaluation gate (F31), which are measurable offline.
→ `testing/eval/eval-run.ts`

### DEC-M5-4 — The eval corpus is the 100 known-bad, plus synthetics
The golden set is specified as 250 real items with official keys plus 100 known-bad negative controls. The
250 real items are B1 — the licensing decision that has blocked the scoring golden set since M2 — and
nothing here attempts to source papers. M5 builds the 100 known-bad controls, on which F34's catch rate is
measured and not blocked, and synthetic positives clearly labelled as such. A run reporting zero official
items says so in words and is not a validated run.
→ `testing/eval/eval-corpus.ts` · `testing/eval/eval-run.ts`

### DEC-M5-9 — The budget is enforced at enqueue, not at call
A budget checked at call time has already committed to the work by the time it refuses, and a
partially-generated run is the worst outcome: tokens spent, nothing publishable. A run is admitted
against its period's budget when it is enqueued, in the transaction that writes it, so one that does not
fit is never written and the refusal says by how much. **Proposed at M5 and implemented at M5-41; it was
never ratified by anyone but the task that built it.**
→ `contexts/generation/application/handlers/run-handlers.ts` · `contexts/generation/infrastructure/generation-run.repository.ts`

### DEC-M5-10 — What counts as a regression, and who records an evaluation
The architecture says regression blocks promotion and does not say what one is. An evaluation run's
outcome is **derived by the domain, never asserted**: a dimension the baseline reported that this run
scores lower on, or does not report, is a regression; a dimension with an absolute floor (verification
catch rate on known-bad items, 95%, F34) scored below it is one; a run that measured nothing is not a
pass; a version's first evaluation has no baseline, so only floors apply. A regression is stored as
`fail`, which the activation gate does not accept. Recording an evaluation is `content_ops`'s alone: the
pipeline is what a pass lets through, so it cannot certify itself. **Chosen at M5-43 where the document
was silent; nobody else has agreed to these thresholds.**
→ `contexts/generation/domain/evaluation-run.ts` · `contexts/generation/application/policies.ts`

### DEC-M7-6 — Scoring's event is made atomic with the score record before Learning consumes it
`AttemptScored` was written to the outbox by an adapter that opened its own transaction, so the score record
committed in one and the event in another. Through M6 nothing consumed the event and the gap cost nothing. Learning's
only input is `AttemptScored`, and a score with no event is a mastery update that never happens, with no message in
the outbox to fail and so nothing the dead-letter queue could show. The repository now takes the event with the
record — `ScoreRecordRepository.save(record, event)` — and writes both on one connection in one transaction, the shape
assessment's attempt repository took at M6-39. A re-score's completion and `AttemptsRescored` are written the same way.
The adapter that opened its own transaction is deleted rather than wrapped. A reconciling sweep was rejected: it would
have Learning read scoring's tables, which the boundary rules forbid.
→ `contexts/scoring/infrastructure/score-record.repository.ts` · `contexts/scoring/infrastructure/rescoring-operation.repository.ts` · `contexts/scoring/application/handlers/scoring-handlers.ts`

### DEC-M7-1 — Learning reads evidence through two seams, and assembles it itself
Neither event carries what mastery is defined on — per-slot outcome, item version, concept identity, difficulty — and
scoring's own header says Learning reads the owning context rather than trusting a copy. Two seams are offered through
`public/composition.ts`, as content offers its catalogue to assessment (ADR-0015): scoring offers the per-slot outcomes
of one attempt (identifiers and outcomes; no response, no key), and content offers the primary concept, taxonomy version
and authored difficulty of a set of item versions. Learning assembles `MasteryEvidence` from the two and owns the result,
with no production import of either context. Curriculum is not a source: it owns the taxonomy and does not know which
item tests which concept.
→ `contexts/scoring/application/queries/scoring-queries.ts` · `contexts/content/application/queries/version-taxonomy-queries.ts`

### DEC-M7-3 — Difficulty is the authored band, named as an estimate
Difficulty as a measured fact belongs to Psychometrics, which does not exist yet. Learning uses
`content.item_version.difficulty_estimate` — foundational, moderate, challenging, advanced — carried on the evidence as
`difficultyEstimate`. It is an author's judgement and not a measured *p*-value, and the field names and the debt entry
both say so. The trigger is the first item statistics Psychometrics produces; the states then recompute from evidence
that was retained for exactly that reason.
→ `contexts/content/domain/repository-ports.ts`

### DEC-M7-5 — Evidence is attributed to the primary tag only
`item_taxonomy_tag` carries a weight and an `is_primary` flag, with exactly one primary per version. If a secondary tag
at weight 0.4 counted, "8 responses" would stop being a count. One response is one piece of evidence for the item's
primary concept and nothing for its secondary tags; the weights are not read. Weighted attribution needs item statistics
to calibrate, and the evidence rows retain the item version so a later rule recomputes from history without
re-collecting.
→ `contexts/content/infrastructure/version-taxonomy.reader.ts`

### DEC-M7-2 — The learner's sitting is a StudySession, owned by Learning
Assessment's `form_session` is a sitting a *form* declares. D-002 reads *2 sessions* and *a different session*, which is a
*learner's* sitting: one word with two meanings inside one rule. The shipped schema is left alone; `form_session` is
called a **shift** in prose and keeps its name in the database. Learning owns a `StudySession`, a learner-scoped window
closed by an idle gap (30 minutes by default, tunable per exam alongside the other D-002 thresholds), and every piece of
evidence is assigned one as it arrives, so a mock attempt and a practice run both count uniformly. Renaming
`form_session` was rejected because it rewrites two composite constraints a week after they landed; reading *2 sessions*
as *2 attempts* was rejected because massed evidence in one afternoon would qualify as mastery.
→ `contexts/learning/domain/mastery-evidence.ts`

### DEC-M7-4 — A practice run is its own aggregate, on the shared engine *(Rejected)*
**Rejected; DOMAIN-MODEL D2 stands.** The proposal was that practice be a separate `PracticeAttempt` aggregate in Assessment, because M6's `Attempt` is
deadline-bearing and single-submission and carries four composite foreign keys that encode mock invariants, and a mode on `Attempt` would make each of them
"enforced when mode = mock". D2 states the opposite, and states it as a foundational decision: *"`Attempt` is mode-parameterized, not duplicated. Mock,
practice, and diagnostic are one aggregate distinguished by a pinned `DeliveryPolicy`. Alternative designs duplicate response capture, timing, and scoring
three times and guarantee divergence."* The model already has what the proposal said was missing: `mode (mock / practice / diagnostic)`, a pinned
`deliveryPolicy` carrying `pausable` and `feedbackMode`, an optional `FormId?` and an optional `serverAnchoredDeadline?`. The grounds for splitting were
properties of the schema M6 happened to build, which is non-null only because M6 built mocks and nothing else.
The objection has an answer that needs no second aggregate: constrain the nullability by mode, so every row is checked and nothing becomes "not applicable".
`CHECK ((mode = 'mock') = (form_id IS NOT NULL))`; the composite foreign keys stay and fire whenever `form_id` is present; the same shape for the server-anchored
deadline, driven by the pinned policy; `mode` and `delivery_policy` pinned at creation and never granted `UPDATE`. A practice run's evidence reaches Learning
through the same port as a mock's. That is the track that builds practice, not this one.
→ `contexts/learning/domain/mastery-evidence.ts`

### DEC-M7-7 — D-002's thresholds are rows in the database, versioned, and pinned on what they decided
DECISIONS D-002 says the thresholds are tunable per exam, DOMAIN-MODEL 12.2 says they are configuration and not code, and
BACKEND-ARCHITECTURE keeps mastery thresholds in the database with the marking rules. So the context's source carries none:
`learning.mastery_rule_set` holds one immutable row per version, named by the SHA-256 of its canonical thresholds, scoped to a
taxonomy version (the exam-shaped identifier evidence carries) with a platform default where none is published, and a
transition will name the version it was decided under, so a change never restates history. The `StudySession` idle gap is
one of the values, not a second setting. A rule fails the build on a threshold literal in production source. Publishing is an
administrator's act behind step-up and is audited. **Three values D-002 does not give were chosen here and nobody else has
agreed to them**: below what recent accuracy a concept with evidence is `weak` (0.5), and the decay's half-life (60 days) and
confidence floor (0.5).
→ `contexts/learning/domain/mastery-rule-set.ts` · `infra/migrations/20261028100000_learning_mastery_rule_set.sql` · `contexts/learning/application/handlers/rule-set-handlers.ts`

### DEC-M7-8 — Decay is computed at read, not applied by a sweep
Confidence is built from the evidence (its count, the sessions and items it spans, and the spread of difficulty it covers) and multiplied by a
recency factor that halves every half-life since the last response. A `strong` state whose confidence falls below the floor reads as `developing`.
That is a function of the evidence and of the instant of the read, so it needs no scheduled job, leaves no stale row behind, and cannot fail to run;
D36 already names what the repository lacks around scheduled work. `decayAppliedAt` records the instant a read was computed against, and not when a
job ran. `decayedTo` (from a state) and `deriveConceptState` (from the evidence) are two paths to one read, and a spec holds them to each other.
A regression that decay alone produces is observed at read; the next response recomputes the state and records it (M7-15). **The half-life, the floor and
the line below which a state with evidence is `weak` are chosen values: D-002 does not give them.**
→ `contexts/learning/domain/concept-state.ts`

### DEC-M7-9 — A promotion's `from` is the weakest state since the concept was last strong, and verification is its own step
DOMAIN-MODEL 12.2 and the roadmap name a `weak → strong` transition with `verifiedAt` set as the north-star event. Accuracy moves one response at a time, so a
concept that was weak passes through `developing` on the way up; read as "the state the instant before", a promotion's `from` would almost never be `weak` and
the event would almost never happen. So `from` is the weakest state the concept was in since it was last strong, or since it was first assessed, kept with the
concept's state as it is advanced. Reaching `strong` on D-002's five clauses is recorded at once as a qualification, with its responses and no `verifiedAt`;
it becomes a gain only when confirmed by further correct responses on other items, in a sitting the qualifying responses were not in, at least the rule set's
gap after the qualification, each of the three refused separately and under the rule set the qualification was pinned to. A regression, whether from
accuracy or from decay observed at the next response, is a transition of its own: the gain it reverses is never touched, and the table will not let it be.
**This reading, and "different items" meaning other than those that qualified it and each other, were chosen where D-002 is silent.**
→ `contexts/learning/domain/mastery-transition.ts` · `infra/migrations/20261028120000_learning_mastery_transition.sql`

