# Debt register

Known gaps, each with the trigger that closes it. An entry here is a decision to stop somewhere and
say so, not a thing forgotten.

**The code is the authority, not this file.** Every entry below is cited at the place it constrains —
usually a module header stating the gap in the terms that matter there. This register is the index:
it exists so a reader meeting `debt D25` in a comment can find out what D25 is. Where the two disagree,
the code is right and this file is stale, and `debt-rules.spec.ts` fails the build if an identifier is
cited without an entry here or carried here without a citation.

**`D1`–`D10` are not debt.** They are the domain-model design decisions in
[DOMAIN-MODEL.md](DOMAIN-MODEL.md) §"Decisions", which reuse the same prefix. Debt starts at `D11`.

Numbering has gaps. An identifier that never reached the code was retired before anything depended on
it, and inventing an entry to fill the hole would be recording a decision nobody made.

---

## Open

### D19 — Chemical structures are out of the renderer's scope

Benzene rings, reaction schemes and mechanism arrows are authored as `MediaAsset` diagrams with
mandatory alt text and long descriptions, not as notation the renderer draws. A half-drawn ring tells
an author nothing; the documented affordance tells them exactly what to do (DEC-6).

**Trigger** A structural chemistry renderer worth trusting on the minimum device profile.
**Cited** `packages/content-renderer/src/chem-to-mathml.ts`, `chem-node.tsx`

### D23 — Curriculum exposes no concept → subject-domain lookup

Half closed. An in-scope author can no longer mistype their own subject: it is resolved from the
principal's subject scope where that is unambiguous. What stays open is the cross-check — nothing
compares a declared subject against the subject domain of the concepts actually tagged, so an author
scoped to more than one subject, or unscoped, can still mistag their own in-scope work. The Studio's
authoring views report `outOfScopeConceptIds: []` rather than guessing, which is honest: nothing was
found because nothing was checked.

**Trigger** Curriculum exposing a concept → subject-domain lookup through its public barrel.
**Cited** `contexts/content/domain/item.ts`, `application/authorization.ts`,
`application/queries/authoring-queries.ts`

### D25 — A published version cannot be corrected

Supersession has no producer. Publication is legal only from `approved`, and an item refuses a new
version in any state past draft, so nothing can be superseded today. The optional supersession field
is left unemitted rather than shipped as dead code pretending to be a feature.

**Trigger** Travels with the answer-key challenge to M5 (DEC-M4-6, [ADR-0022](adr/ADR-0022-item-defect-and-answer-key-challenge-move-to-m5.md)).
An upheld challenge needs a corrected published version, and this forbids exactly that — which is why
the intake was not built in M4.
**Cited** `application/handlers/lifecycle-handlers.ts`, [ADR-0018](adr/ADR-0018-approve-with-edits-keeps-the-author.md)

### D28 — A repository constraint violation can surface a raw driver message

An error crossing the repository boundary can still carry a Postgres message. Consumers defend
themselves rather than trust it: the Studio's item browser reads a transport error's own typed shape
(`ApiProblemError.problem.title`) and never `Error#message`.

**Trigger** The error taxonomy growing a constraint-violation kind that repositories map onto.
**Cited** `apps/studio/src/features/item-browser/ItemBrowser.tsx`

### D30 — The Studio route table is not a router

`use-route.ts` is a route table, not a router. The shape is already what TanStack Router consumes, so
the replacement is a swap rather than a rewrite.

**Trigger** The first nested route, or the first surface needing validated search state beyond M3-43's
URL filters.
**Cited** `apps/studio/src/shell/use-route.ts`

### D31 — The span tree is not exported, and there is no OpenTelemetry SDK

The span tree stands behind a port (`Telemetry`) and is written as JSON lines; it is not an OTLP exporter and does not pretend to be one. The first reason given here, that no `@opentelemetry/*` package could be fetched, stopped being true when the lockfile began to move (M8 Track K resolved a dozen overrides): the registry is reachable. The SDK is still not taken on, for different reasons. It is a large dependency surface that the `security` job gates at high severity; it exports to a collector, and there is no collector to export to; and the port means an exporter can be written against it later without a caller changing. What stands in the meantime is a plain text metrics page (`GET /metrics`, M8-53, DEC-M8-30): request counts and latency by route template, the outbox backlog and its age, the relay's lag, the pool, and refusals by tier. It carries no trace, and a trace id appears only in logs and spans, so a slow request can be found by its correlation id and not followed across a service.

**Trigger** A collector to export to (a host that runs one, or a hosted one chosen): write an exporter against the `Telemetry` port, and take the SDK on then, behind the audit.
**Cited** `platform/observability/telemetry.ts`

### D32 — No S3 media store adapter

`@aws-sdk/client-s3` is not in the offline store, so the filesystem adapter is the only implementation.
It refuses to be selected when `NODE_ENV` is production — a boot failure, not a warning — so the
absence cannot quietly become the production configuration.

**Trigger** The SDK becoming installable.
**Cited** `platform/persistence/filesystem-media-store.ts`

### D33 — `subject` has no source on the authoring item view

Content attaches a concept, not a subject name, to a version's taxonomy tags, and resolving one to the
other is D23's lookup. The Studio's subject filter is therefore a no-op and the field is returned
empty rather than fabricated.

**Trigger** D23 closing, or content exposing a subject on the authoring query directly.
**Cited** `apps/studio/src/features/item-browser/item-browser-api.ts`,
`features/queue-management/queue-management-api.ts`

### D34 — One integration spec bypasses the typed client

The generated client's create-response type diverges from what the authoring command handler actually
returns, so that spec sets up through a plain `fetch`. Recorded rather than papered over, because the
divergence is the defect, not the workaround.

**Trigger** The next authoring command handler the divergence affects, or a client that needs the
create response's shape for more than the created `itemId`.
**Cited** `contexts/content/item-browser-live.integration.spec.ts`

### D35 — Nothing makes a cross-context reaction atomic with the fact that caused it

A reaction in another context cannot be made atomic with the fact that caused it, and the review domain's open questions are stated as
questions for that reason.

**The trigger fired at M6-38 and the entry is restated, not closed.** The relay supplies the pattern that answers the question *reliably*, not
*atomically*: the fact and its event are one transaction (M6-39), a relay delivers the event at least once, and an idempotent consumer in the
other context produces the effect once — so the reaction **eventually** follows the fact, and a failure between them is recoverable and visible
(a dead letter) rather than silent. Assessment's submission → scoring is the working example, tested end to end. What a consumer cannot give
is atomicity: for a moment the fact has happened and the reaction has not, and anything that reads in that moment sees it.

**Restated at M7-01 for scoring.** Scoring's event was the one the pattern had not reached: the score record and `AttemptScored` were committed in two
transactions, so a crash between them lost the announcement and the relay had nothing to deliver. They are now one transaction
([ADR-0042](adr/ADR-0042-a-score-and-its-event-are-written-in-one-transaction.md)). The reaction in Learning is still eventual, and that is still true.

The review domain's own questions are unanswered still; they are now answerable by the same pattern, and each is a decision about whether
"eventually" is acceptable for it.

**Trigger** The first review-domain reaction built on the relay, which decides its questions; or a need for true atomicity, which would be a
different mechanism (one transaction across the contexts' tables, which the boundary rules forbid).
**Cited** `contexts/content/domain/review/index.ts`

### D36 — The scheduler runs in the process; what is still missing is only the deployment around it

The sweeps are ordinary idempotent commands taking their moment as a parameter: the review ageing sweep, opening and closing form windows,
abandoning attempts a closed window left, and submitting attempts whose deadline passed (the one Track E found missing). Until M6-42 nothing
called them, recorded as waiting for "a deployed environment with a scheduler" and `Fail — blocked` under
[ADR-0013](adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md).

**M6-42 builds the caller** ([ADR-0038](adr/ADR-0038-the-outbox-relay-delivers-at-least-once-and-scoring-is-its-first-consumer.md)): an in-process
`Scheduler` whose `tick(now)` runs whatever is due, drives the outbox relay and all four sweeps, and is started on real timers by `main.ts`. It is
tested with time supplied, not slept through, and an expired attempt is submitted as an `expiry`. The blocked-on-a-deployment claim is therefore
withdrawn for the trigger: it needs no scheduler product.

**What is still missing, and is the debt:**
- **No coordination.** Each instance runs its own copy. That is safe because the jobs claim (the relay, with `SKIP LOCKED`) or are idempotent
  (the sweeps move state under a guard), so two instances race harmlessly — but there is no leader election, so N instances do N times the polling.
- **No observation.** A job's failure is written to standard error and tried again at its next turn; nothing alerts, and no metric counts it.
- **A started process.** The scheduler runs while the process does. A deployment that scales to zero, or runs the API only in short-lived
  instances, would sweep only while one was up.
- Queue health still derives overdue items from `ageState` rather than from `review_escalation` when the sweep has not run, and `notifiedAt`
  absent means "not yet swept", never "not overdue" — true of any gap between sweeps.

**Trigger** A deployed environment: leader election or a dedicated worker if the polling is costly, and an alert on a failing job.
**Cited** `application/review/handlers/ageing-handlers.ts`, `application/review/queries/queue-queries.ts`,
`contexts/content/domain/repository-ports.ts`, `fitness/platform-rules.ts`,
`contexts/assessment/domain/repository-ports.ts`, `platform/scheduling/scheduler.ts`

### D37 — The review workspace cannot show a solution

The solution region reports `not_available` on every claim. No authoring-side query returns a
draft or in-review solution's content by item version id — only by a `solutionId` the workspace does
not hold. Named in the model rather than faked with an empty body.

**Trigger** An authoring query returning solution content by item version id.
**Cited** `apps/studio/src/features/review-workspace/review-workspace-model.ts`,
`review-workspace-api.ts`

### D39 — No symbolic verification runtime

[AI-ARCHITECTURE](AI-ARCHITECTURE.md) §11 check 3 reads "CAS where symbolic; otherwise 2 independent
solves", and [TECH-STACK](TECH-STACK.md) names SymPy for it — a computer algebra system does not
agree with itself out of politeness, unlike a second model call. There is no Python in this
repository and SymPy is not installable offline, so the CAS branch cannot be built. The `otherwise`
branch is what ships, which the architecture already specifies as the fallback rather than a
compromise.

**Trigger** A Python service existing here, or SymPy becoming installable offline — see
[ADR-0024](adr/ADR-0024-generation-is-typescript-until-the-ecosystem-is-needed.md), which names this
as one of three triggers that would bring that runtime with it.
**Cited** [ADR-0024](adr/ADR-0024-generation-is-typescript-until-the-ecosystem-is-needed.md)

### D40 — Accepting a candidate is not atomic across the context boundary, and the relay has not changed that

`AcceptCandidate` asks content to create a draft and submit it, then records the decision and its event in generation's own transaction.
Two contexts means two transactions, and a failure between them leaves a content draft with no decision recorded against its candidate: the
candidate is still `proposed`, and accepting it again would create a second draft. The error names the draft left behind, so an operator can
find and withdraw it, and nothing is lost — but nothing prevents the duplicate either. Accepting is also automatic (`DisposeCandidate`,
ADR-0029), so the next battery run is a retry that creates the second draft by itself.

**The trigger — the outbox relay existing — fired at M6-38, and this entry is restated, not closed.** The relay gives the mechanism that would
close it: record the decision and a `CandidateAccepted` event in generation's one transaction, and let a consumer create the content draft.
Two things stand between that and a closed entry, and neither is built:

1. **The consumer would not be idempotent.** The relay delivers at least once, and content's `CreateItemDraft` has no idempotency key, so a
   redelivery creates a second draft — the defect in a new place. It needs a key derived from the candidate (content's idempotency store already
   serves `UpdateItemDraft`), and `SubmitItemForReview` must treat an item already in review as done.
2. **Accepting would stop returning the draft.** An operator's accept returns the content item id; behind a consumer it cannot. The API and the
   operator's surface would change.

Until both are done the window is exactly as open as before, and the relay has narrowed it only in that a recovery path (a dead letter an
operator can see) now exists for the *other* direction of the same shape.

**Trigger** Content's draft creation taking an idempotency key, which is the work that lets accept be split.
**Cited** `apps/api/src/contexts/generation/application/handlers/decision-handlers.ts`

### D41 — Content's other constructors still raise on structurally malformed input *(narrowed at M5-32)*

ENGINEERING-HANDBOOK §8 has domain operations report expected failures as values, never as thrown
exceptions. `content/domain/`'s own guard asserts exactly that — and it reads for the `throw`
*keyword*, so a `TypeError` raised by dereferencing something absent was invisible to it. It mattered
once generation became the first caller handing content **untyped JSON**, a model's proposal.

**Closed for the proposal path.** The constructors a proposal passes through — the content body (every
block and inline), the response specification, taxonomy tags, provenance, licensing and the item
version — now return a value for input of the wrong shape. A guard that *can* see a raise proves it:
`malformed-input.spec.ts` breaks a valid document at every position in every way a JSON value can be
wrong (`testing/mutation-sweep.ts`, enumerated, deterministic), for each of the four item types and a
body using every block and inline kind, and no constructor may raise on any. `validateProposedContent`
is total over the same sweep.

**Still open: the rest of content's domain.** The same pattern — an `isBlank` that assumes a string, a
dereference of a field assumed present — remains in constructors nothing has yet handed untyped data:
`item`, `stimulus`, `solution`, `media-asset`, `review-decision` and `locale-variant`. They are reached
today only by typed callers. `decision-handlers.ts` still contains a raise at the accept seam as
defence in depth.

**Trigger** The next caller to hand one of those constructors data it did not type-check — an import
path, a solution or stimulus proposal, or any deserialized command. The fix is the same and the sweep
is reusable: point it at the constructor.
**Cited** `apps/api/src/contexts/generation/application/handlers/decision-handlers.ts`

### D42 — No difficulty prior over a proposed item *(narrowed at M5-34)*

Pre-checks 1 (schema), 2 (renderability), 4 (numeric specification) and 8 (duplicates) were blocked
because they are content's logic and content applied it only to its own aggregate or to stored
versions. **Closed at M5-32 and M5-33:** content now validates proposed content without storing it
(`validateProposedContent`, pure and total) and finds duplicates of it (`GetDuplicateCandidatesForProposal`,
read-only, advisory), and generation runs all four through them. A candidate generated by the pipeline now
reaches content's review queue, demonstrated end to end.

**Still open: check 9, difficulty plausibility (advisory).** The §7 prior is feature-based — solution
step count, prerequisite depth, notation complexity, distractor plausibility, comparable-item
difficulty — and nothing exposes those features for content that has not been stored. Computing them in
generation would be a second implementation of measures other contexts own. Because the check is
advisory it blocks nothing: a candidate is acceptable without it, and the battery's report says it did
not run.

**Trigger** A difficulty prior computable over proposed content, from whoever owns the features.
**Cited** `apps/api/src/contexts/generation/application/prechecks/index.ts`

### D44 — A verdict does not record which model and prompt produced it

A candidate pins the model and prompt that *generated* it (F28). A pre-check verdict records its
check, outcome and reasoning, but not the registry rows of the judged check that produced it, so
"which verdicts did verification prompt v20 give?" cannot be answered by a query, only by reading
configuration at the time. Judged checks run under prompt versions of their own, so the information
exists when the verdict is written and is then discarded.

**Trigger** The first need to audit or recall verdicts by the prompt behind them, or a prompt defect
found in a judged check.
**Cited** `apps/api/src/contexts/generation/application/handlers/battery-handlers.ts`

### D45 — No live provider adapter: a composed deployment cannot reach a model

The composition root gives generation an adapter that answers every proposal and every judgement as
`Unavailable`, because the only other adapter replays committed recordings, which is a test fixture and
not something a deployment should choose. The pipeline is therefore composed, guarded and auditable
end to end, and cannot yet propose a candidate or run a judged check outside a test. A run proposed
today fails the way a run against a provider that is down fails (AI-12), so a caller already handles it.

**Trigger** The first deployment that needs the pipeline to reach a model. The work is one adapter in
`infrastructure/provider/`, a credential read in one place, and a way for the root to choose it.
**Cited** `apps/api/src/contexts/generation/infrastructure/provider/unconfigured-provider.ts`

---

### D47 — The budget counts tokens, not money: no price per model version

`AIBudget` ceilings and runs' reservations are whole numbers of tokens, because a provider reports
tokens and the registry holds no price. That makes the budget a true ceiling on usage and says nothing
about spend: two models with different per-token prices burn the same budget at different cost, and
"cost per published item" (M5's ≤ 40% criterion, itself blocked on a reviewer pool) cannot be read from
the ledger without a conversion that does not exist.

**Trigger** The first need to compare cost across model versions, or the first deployment with a
provider bill to reconcile. The work is a price per model version in the registry — immutable rows, like
the versions — and a conversion at read time, not a change to the ledger.
**Cited** `apps/api/src/contexts/generation/domain/ai-budget.ts`

### D48 — A period's budget cannot be raised once declared

A budget is one immutable row per feature and month, so a ceiling set too low cannot be raised mid-month:
a second declaration is a `CONFLICT`, and the table refuses an UPDATE from every role. The refusal is
deliberate for now — an editable ceiling is a way for a run to raise its own limit unless declaring is
a separate, audited act — but it means the only remedy for a ceiling set wrong is the next month's.

**Trigger** The first month a ceiling is declared too low and generation has to stop for want of one.
The work is a declaration that supersedes (a later row for the same period, the latest standing),
audited like the first, never an UPDATE.
**Cited** `apps/api/src/contexts/generation/infrastructure/ai-budget.repository.ts`

### D49 — The spend ledger is not partitioned by month

The data architecture sketches `ai_spend_ledger` as range-partitioned on `occurred_at`, monthly. It is a
plain table. A partitioned table needs each month's partition to exist before a row lands in it, and a
missing one fails the insert — which here fails the metered call whose spend it records. Until something
creates partitions ahead of time, an unpartitioned append-only table is the safer failure.

**Trigger** The ledger growing large enough that a month's sum or a retention policy is slow or awkward,
or a job existing to create partitions ahead of the calendar.
**Cited** `infra/migrations/20260905110000_ai_spend_ledger.sql`

### D50 — A run can overshoot its reservation by one call

The cost of a provider call is known only after it, so the meter refuses a call when the run has *already*
consumed everything it reserved, not when this call would take it over. The call that crosses the line is
allowed, recorded, and the next is refused: the overshoot is bounded by one call, but it is not zero, and a
run's ledger total can exceed its `budgetTokens`. A pre-call estimate from the prompt's size and the
call's `max_tokens` would tighten it and would be a second guess at the cost beside the real one.

**Trigger** A run whose overshoot matters — a reservation small enough, or a call large enough, that one
call is a meaningful fraction of it.
**Cited** `apps/api/src/contexts/generation/application/metered-provider.ts`

### D51 — The activation gate trusts a stored evaluation outcome

F31's gate asks whether a *passing* evaluation run exists, and "passing" is the `outcome` column. The
domain derives that outcome from the scores and the baseline, and a stored run is re-derived when it is read
back (`findById` refuses one whose outcome its scores do not derive) — but the gate itself, in SQL and in
`hasPassing`, reads the column and does not recompute it. A row inserted directly with `outcome = 'pass'` and
scores that would fail would activate a version. The table is append-only and only one handler writes it, so
today that takes a person with database access; it is not a path the application has.

**Trigger** Anyone other than the one handler gaining a way to write `ai.evaluation_run`, or an audit finding
a stored pass its scores do not support. The work is to have the gate read through the domain, not the column.
**Cited** `infra/migrations/20260906100000_ai_evaluation_run.sql`

### D52 — The renderability check accepts an unterminated optional argument

The evaluation corpus (M5-44) plants twelve unrenderable stems; the battery catches ten. The two it lets
through carry `\sqrt[` — an optional argument opened and never closed, which is malformed TeX and which the
content renderer's validation does not reject. Whether the renderer or the item is wrong cannot be settled
without a reference TeX engine, which this repository does not have; the items stay in the corpus as known-bad,
and the catch rate (95 of 100, exactly at F34's floor) is reported with them counted as misses.

**Trigger** A reference engine becoming available to check the notation against, or the first real item
carrying one of these through to a reviewer. The work is a bracket-balance rule in the renderer's validation
for optional arguments, or a ruling that the item is valid.
**Cited** `apps/api/src/testing/eval/eval-corpus.ts`

### D55 — A published item may have no fingerprint, so assembly cannot certify it duplicate-free

Content's duplicate detection compares fingerprints, and fingerprints are written for items **in review**: when a
reviewer claims one, and by the refresh over the review queue. An item that reached `published` without passing
through that — or whose fingerprint was never written — is reported `not_evaluated` by `GetDuplicateCandidates`.
Form assembly must not treat "unknown" as "no duplicates", so the corpus adapter leaves such a version out of the
candidates and names it in `unevaluated`; the pool the assembler sees is smaller than the published catalogue by
exactly those.

**Trigger** The first published item reported in `unevaluated` on a real catalogue, or content widening its
fingerprint refresh to published versions — which would make this entry go away.
**Cited** `apps/api/src/contexts/assessment/infrastructure/content-corpus.ts`

### D56 — The sessions of a form share its schedule window

[ADR-0032](adr/ADR-0032-a-session-is-a-named-sitting-that-a-form-declares.md) lets a form declare several
sessions, but the window attempts are held to belongs to the form (`opens_at`, `closes_at`), so every session
of a form opens and closes together. Real multi-shift sittings of one paper happen at different times.

**Trigger** The first form that needs two sittings at different times: the window then moves onto
`form_session`, and `attempt_window_is_the_forms` keys to it instead.
**Cited** `apps/api/src/contexts/assessment/domain/form.ts`


### D57 — The near-duplicate similarity threshold is a guess

Assembly treats a content match as a near-duplicate when it is an exact or skeleton match, or a trigram match at
or above **0.8**. The 0.8 is a default of assembly's own choosing, not a measured one: content calls the ranked
trigram group advisory and gives no number, and no real catalogue has been run through it. Too low and assembly
refuses items that are merely about the same topic; too high and a retyped item slips into a form twice.

**Trigger** Calibration: the first real catalogue large enough that the rate of items refused as near-duplicates
can be set against a reviewer's judgement of the same pairs. The threshold is then set from that comparison and
the default is removed.
**Cited** `apps/api/src/contexts/assessment/infrastructure/content-corpus.ts`


### D58 — The API serves the form package's bytes

ARCHITECTURE §5.1 and BACKEND-ARCHITECTURE §3 have the package served from a CDN, with the API answering a
redirect to a signed URL so the bytes never cross the API tier. There is no CDN or object store, so
`GET /v1/assessment/forms/{formId}/package` answers with the bytes
([ADR-0034](adr/ADR-0034-the-form-package-is-signed-over-its-bytes-and-served-by-the-api-until-a-cdn-exists.md)).
A synchronized start by a whole cohort would put every download on the API tier.

**Trigger** A deployment with a CDN or an object store: the package is written there when a form is scheduled and the
route answers a redirect. The bytes, digest and signature do not change.
**Cited** `apps/api/src/contexts/assessment/api/assessment.controller.ts`

### D59 — The package signing key has no rotation

One Ed25519 seed signs every package, and a device that has the public key accepts only that key. The key id is in
every response, which is what a rotation would need, but nothing yet serves more than one key or says which key
a given form's package should be verified with. The learner app fetches the key from the same API that serves the package, so
the signature protects the bytes on their way from that API to the screen (a CDN, a cache, a proxy) and not against the API itself:
a key pinned in the shell's own build would.

**Trigger** The first need to replace the key, or a deployment with a key-management service: the public-key route then
lists the keys in force, and a device keeps each it has seen.
**Cited** `apps/api/src/contexts/assessment/infrastructure/package-signer.ts`



### D61 — The time-on-item interval cap is a guess

The longest one visit-to-leave interval may count towards an item's time is **120 seconds**, a default of the platform's own choosing:
ASSESSMENT-ENGINE §14 lists the value as unresolved and nothing has measured it. Too low and a learner who thinks a long time on a hard
question is credited with less than they spent; too high and an app left in the background inflates the item's time. It is one configured value,
pinned onto each attempt ([ADR-0037](adr/ADR-0037-the-interval-cap-has-one-source-and-is-pinned-onto-the-attempt.md)), so changing it later is a
setting and not a code change — but attempts already taken keep the value they were pinned with.

**Trigger** Real response-time data: the distribution of visit-to-leave intervals once there are enough attempts, set against the cap.
**Cited** `apps/api/src/platform/config/config.ts`

### D62 — An answer is not validated against its item's kind when it is sent

Ingestion accepts an answer that is a string, a number or a list of them, and checks nothing about whether that is a possible answer to *this*
item: a matching item can be sent a bare number, a numeric item a list. The scoring consumer reads each answer as the kind its item takes (an
option choice, a list of `left:right` pairs, the learner's own text for a number) and treats one it cannot read as **unattempted**. That is
quiet: a device bug that sends the wrong shape costs the learner the mark without anyone being told.

**Trigger** The first device build that sends a shape the item does not take, or ingestion learning the item type of a slot (it has the pin, and
could ask content for the version's kind).
**Cited** `apps/api/src/contexts/assessment/application/consumers/scoring-consumer.ts`

### D63 — Scoring's own score-record route cannot be satisfied by a learner

`GET /v1/attempts/{attemptId}/score-records/current` is for learners and operators, and a learner may read only their own record — which the
query checks by comparing the principal with an `ownerUserId` the caller supplies. The route supplies none, and scoring does not know who owns
an attempt, so a learner is always refused and only an operator can read through it.

**What is proven, and what is not (M6-52).** The learner never needs this route: the student's result is read through assessment
(`GET /v1/assessment/attempts/{id}/result`), which knows the owner. That path is proven end to end on the server — submit, relay, score, read
by the owner, refused to another student, no key or solution in the body (`assessment-scoring.integration.spec.ts`) — and `apps/learn` reads
it through the typed client and shows it. Not proven: the learner app against a live server; its specs use a fake transport, and
the browser-driven journey is M8's. The defect itself — the scoring route is unusable by the people it names — stands.

**Trigger** A client that wants the score without going through the attempt, or scoring learning attempt ownership (a read model fed by the
outbox would give it).
**Cited** `apps/api/src/contexts/scoring/api/scoring.controller.ts`

### D64 — A window closing does not submit the attempts still running in it

An attempt is submitted as `expiry` when **its own deadline** passes: by the device at zero, or by the scheduler's sweep when the device never
came back. The form window closing is a separate fact, and nothing reacts to it for attempts already started: one started just before the
close keeps its full duration past it. Whether a closing window should also submit live attempts as `expiry` is a product decision (it
shortens a learner's paper for a fact they did not control) and has not been taken; the behaviour today is the one that never cuts a started paper short.

**Trigger** A product decision on exam-window semantics, or the first complaint that a paper ran past its window.
**Cited** `apps/api/src/contexts/assessment/application/handlers/expiry-handler.ts`

### D65 — A test that pins from the exam profile failed once in a wide run and never again

`pins from the exam profile curriculum holds, not from anything the client says` failed once in a wide run of the suite and did not
reproduce in later runs, in isolation or wide. The cause is unknown. It is recorded so that a second failure is
recognised as a second, and investigated, rather than re-run until it passes.

**Trigger** A second failure of that test, or any failure of it in CI: capture the output and the run's concurrency, and check what the test
shares with its neighbours (the clock variable, the pool, the exam profile rows).
**Cited** `apps/api/src/platform/composition/assessment-attempts.integration.spec.ts`
### D70 — Evidence is attributed to an item's primary concept only

`item_taxonomy_tag` carries a weight and an `is_primary` flag. The evidence a response yields counts for the primary concept and nothing for
a secondary tag, so "8 responses" is a count; the weights are not read. Whether a secondary tag at some weight should count for something is a
question about the item, and the answer needs item statistics to calibrate. The evidence rows keep the item version, so a rule that does count
them recomputes from history rather than re-collecting.

**Trigger** The first item statistics Psychometrics produces, or a decision to credit secondary concepts.
**Cited** `apps/api/src/contexts/content/infrastructure/version-taxonomy.reader.ts`

### D71 — Difficulty is an author's estimate, not a measured value

`MasteryEvidence.difficultyEstimate` and the band a learner has demonstrated are the item's authored `difficulty_estimate`:
foundational, moderate, challenging or advanced. Context 6 (Psychometrics) does not exist, so there is no measured *p*-value to use. A band an
author chose is a judgement, and a mastery state that leans on it is only as good as that judgement.

**Trigger** The first item statistics Psychometrics produces: the field becomes `itemDifficulty` and states recompute from retained evidence
([ADR-0044](adr/ADR-0044-evidence-names-its-difficulty-an-estimate-and-its-concept.md)).
**Cited** `apps/api/src/contexts/learning/domain/mastery-evidence.ts`

### D74 — Evidence that arrives out of order is advanced as if it were last

A concept's transitions are advanced from what is stored, one response at a time (DEC-M7-9). A response whose instant is *earlier* than a response already
stored — an attempt scored late, a delivery that waited in the relay behind a retry — is taken in the order it arrived and recorded at its own instant. The state
is right, because it is derived from all the evidence in the order it was given; but a transition can then carry an instant earlier than one stored before it,
and a qualification already recorded is not reconsidered in the light of a response that should have come first. Placing a sitting does not have the problem
(the partition is the same in any order, and a spec holds it to that).

**Trigger** The first delivery observed out of order in a real environment, or any change that lets deliveries for one learner run concurrently: rebuild the
learner's transitions from the evidence in order, under the rule sets they were pinned to.
**Cited** `apps/api/src/contexts/learning/application/handlers/record-evidence-handler.ts`

### D76 — Remediation reads a concept's stored state, not its decayed one

Decay is computed at read (DEC-M7-8): a concept last evidenced long ago is, today, weaker than the state stored with it. `SuggestRemediationConcepts` selects on the
stored `state` and so does not offer a concept that has decayed from strong to weak since it was last written, and ranks by the stored confidence. The learner is not
misled — they are shown less than the full picture — and nothing is lost: the evidence is retained and the read can be corrected.

**Trigger** The review schedule (Track G) needs the decayed state for every concept to say what is due; the remediation read moves onto the same read at that point.
**Cited** `apps/api/src/contexts/learning/infrastructure/concept-reader.ts`

### D79 — Practice feedback is judged under the first section's rules

A practice slot belongs to no form, so it has no section and no marks. `ScoringResponseJudge` puts it to marking as the first section's, worth one unit that is
never shown, and the verdict is whatever the pinned rule set's rules for that section attribute to the answer. For the exams modelled so far the rules that decide
*correct* against *incorrect* do not differ between sections, so the word a learner is shown is the one a mock would give; where a profile's sections diverge on what
counts as correct (a section of integer answers marked differently from one of options), practice would judge by the first section's, and a rule set that has no rule
for an item type in section one answers `FEEDBACK_UNAVAILABLE` instead of a wrong word.

**Trigger** A profile whose sections differ in what is correct for one item type, or the first track that scores practice (D77), which has to decide what a practice
slot is worth and under which section's rules; both should take the rule from the item's own section in the exam it was drawn for.
**Cited** `apps/api/src/contexts/assessment/infrastructure/scoring-response-judge.ts`

### D81 — A re-score does not correct the error notebook

A re-score corrects the evidence Learning holds and the transitions decided on it (D72, ADR-0053). It does not touch `learning.error_entry`: a response that was wrong and is now right still has
an entry saying it was wrong, a response that was right and is now wrong has none, and an entry cleared by a transition that has since been revoked stays cleared (the table refuses to un-resolve
one). The learner's notebook can therefore disagree with their corrected score until someone looks.

**What does and does not inherit it (M7-47).** The review schedule does not. It is derived from the evidence as it now stands, which a re-score corrects, and it never reads the notebook, so
a corrected sitting corrects the lapse count with it. The design note that a schedule "reads concept state and error entries" is not followed for that reason: the one source it could have read
that is not corrected is the one it leaves alone. The escalation recorded from an uncorrected count is resolved when a re-score takes the lapses away (D85, closed).

*Re-read at M7-53.* The notebook now has a route (`GET /v1/learning/error-entries`), so a learner's client can read an entry a re-score has made wrong. The trigger below is not met:
nothing yet shows the notebook beside a report, and no re-score has changed a learner's wrong answers outside a test. It stays open, and the route is what makes it nearer.

**Trigger** The notebook is shown to a learner next to a report (the screens, Track H2), or the first re-score that changes a learner's wrong answers in a real environment: entries get a withdrawal of
their own, as evidence got a correction, and the guard permits it once.
**Cited** `apps/api/src/contexts/learning/application/handlers/record-evidence-handler.ts`

### D82 — A burst of corrections queues ahead of a live submission

The relay claims in occurrence order across every event type it carries, and a re-score writes one `AttemptScoreSuperseded` per attempt at once. A mock submitted after a large re-score is
scored, announced and then waits behind whatever of the burst has not been delivered: the relay hands out at most `batchSize` × `maxRounds` (50 × 20 = 1,000) messages a drain, one drain a
second, and each delivery is several reads and a ledger transaction. The batch cap is not what bounds the wait; the order is. The 60-second budget for a diagnostic report was measured with no
backlog and does not hold behind one. The cost of a delivery and so the length of the wait for a given burst was not measured.

**Trigger** The first re-score over more attempts than one drain delivers in a real environment, or any measurement of a submission behind a backlog: a priority on the outbox that claims
interactive events first, with the guard that protects an event's columns taught about it.
**Cited** `apps/api/src/platform/composition/learning-consumer.ts`

### D83 — Studio component specs time out intermittently, cause unknown

Two windows have seen studio specs time out, independently, and neither found a cause. Track D saw timeouts of about 315 seconds while the machine was starved (other work running
on it); the specs were not recorded by name. Track F's window saw `ItemEditor.spec.tsx` and `SolutionEditor.spec.tsx` fail on typing-race timeouts. In both sightings the specs passed
on their own and on a rerun, and neither change had touched code the specs exercise. Nothing is known of the cause: a machine too slow for the specs' timeouts, a race in how
the specs type into the editors, and a defect in the editors themselves are all possible, and none has been shown. It has not been reproduced on purpose and has not been seen on CI.

It is registered before it is diagnosed. D73 began as two sightings with no entry, and cost a week and a quarantine.

**Trigger** The third sighting, or any run that fails twice in a row: run the failing spec 100 times in isolation and again under load with the interval and the cause recorded
(D73 was found by observing what answered, not by reading the code), and do not skip or lengthen a timeout before the cause is known.
**Cited** `apps/studio/src/features/item-editor/ItemEditor.spec.tsx`, `apps/studio/src/features/solution-editor/SolutionEditor.spec.tsx`

### D84 — A report can be labelled with an older score record than the one its findings were built from

A report is labelled with the score record the *message* names (`scoreRecordRef`, from the event payload), and its findings are built from scoring's per-slot outcomes, which
are read at delivery from the record that stands *then*. The outcomes view carries no record identifier, so nothing in the report path can say which record it read. When a
message is delivered after a second re-score has replaced the record it names (a delivery that waited in the relay behind a retry, or a first score announced and then superseded
before Learning heard of it), the report is labelled with the older record and holds the newer one's findings. Because a re-score deliberately writes a new report beside the old one
so the learner keeps a record of what they were told (D3), such a report corrupts that record silently: it reads as the generation-1 report and says what generation 2 said, and if the
real generation-1 report has not been made yet, it takes its place in the one-per-score-record constraint. The evidence path is not affected: it reconciles to whatever stands and
labels nothing.

**Trigger** Any report read in a place a learner or an auditor compares generations, or the next change to scoring's outcomes seam: the view returns the identifier of the record
it read, the source hands that on, and the report is labelled with it and not with the message's. A delivery whose message names a record that no longer stands then makes the report
for the one that does.
**Cited** `apps/api/src/contexts/learning/application/handlers/report-handlers.ts`

### D89 — Six events the taxonomy specifies are owned by no milestone

`item.defect_reported`, `item.defect_resolved`, `ai.tutor_turn`, `client.error`, `performance.render_measured` and `accessibility.assistive_tech_detected` have an `Owner` of `none` in
[EVENT-TAXONOMY.md](EVENT-TAXONOMY.md). ADR-0022 moved the item defect intake to M5, M5's deliverables do not list it, and nothing of it exists. No milestone builds a tutor, a client
error reporter, render timing or assistive-technology detection. Two of them, `ai.tutor_turn` and `client.error`, are also not past-tense facts, which the naming rule asks of every event (§2): a
turn and an error are nouns. The naming gate reads the catalog, requires each name to end in an accepted past-tense verb, and lists these two as its only exceptions, pointing here; a new name that breaks
the rule is red until its verb is accepted deliberately or the event is renamed.

**Trigger** A milestone's deliverables take the surface that can know the fact, and the Owner column says so; or the event is removed from the catalog by a taxonomy version bump.
**Cited** `apps/api/src/fitness/event-conformance.ts` · `apps/api/src/fitness/event-naming.ts`

### D90 — Analytics events are written to a local directory, not to Parquet in object storage

EVENT-TAXONOMY §1 rule 2 says date-partitioned Parquet in object storage and never the OLTP database. There is no object storage wired at M7, so the ingestion edge writes to a port, and
the implementation behind it is one line of JSON per event in `dt=YYYY-MM-DD/events.ndjson` under a local directory (memory under test). The edge, the envelope and the checks are what M7
delivers; conformance is measured before the sink (DEC-M7-36). An event that conforms has not reached analytics.

**Trigger** Object storage is wired, which M8's production environment brings: a sink that writes Parquet partitioned by the same date is a second implementation of the same port.
**Cited** `apps/api/src/platform/analytics/sink.ts`

### D91 — Twenty-nine events whose surface shipped before capture existed are not emitted *(two of the thirty-one are now: M8 Track L, M8-54)*

Events owned by M1 (taxonomy), M3 (item authoring and publication), M4 (review decisions), M5 (generation and prechecks) and M6 (the mock attempt: started, answered, flagged, interrupted,
submitted, the package download, a failed sync) have a surface that has existed for milestones, and nothing emits them. The taxonomy was specified for M0 and capture begins at M7, and M7 wired
only the events its own surfaces produce, so the mock attempt's whole funnel (`mock.attempt_started` against `mock.attempt_submitted` is the completion rate M8 is accepted on) is not captured.
Some are the cheapest to add: `mock.attempt_submitted`, `item.published` and `item.review_decided` are facts a domain event in the outbox already carries.

**Two are emitted (M8-54, DEC-M8-31):** `mock.attempt_started`, said where an attempt on a form is started, and `mock.attempt_submitted`, said by a consumer of the outbox's `AttemptSubmitted`. Together they are what acceptance criterion 2 (the mock completion rate) is counted from. **The other twenty-nine are still not emitted**: the rest of the M6 mock funnel (the package download, the items visited, answered and flagged, the sections, connectivity, interruption and recovery, the result viewed), M1's taxonomy, M3's item authoring and publication, M4's review decisions and M5's generation. Three limits on the two: the start is said directly after the attempt is saved, so a process that dies between the two loses it and the completion rate then reads slightly high; `is_offline` is `false` by construction, because the server hears of a start only when the device reached it; and `sync_lag_ms` is the time between the server last receiving a response event and the submission, on the server's clock, because the server holds no device wall times, so it is not the lag of the device's own queue.

**Trigger** The first real learner. M8's closed beta opens the mock attempt to people whose events cannot be recovered afterwards; the M6 events are captured, derived from the outbox where a
domain event carries the fact, before it does.
**Cited** `apps/api/src/fitness/event-conformance.ts`

### D92 — Seven events M7 owns have no call site, and the one it emits from the server is at-most-once

Seven of the fourteen events M7 owns are not emitted (ten before M8 Track H, eight before Track I), each for a fact that does not exist where it would be emitted:

- `solution.viewed` — no screen shows a solution; the route serves one, and a served response is not a view.
- `remediation.set_generated` — what to practise next is computed on each read; no set is stored, so there is no moment of generation.
- `mastery.regressed` — `days_since_gain` needs the instant of the gain the concept held, which the recorder's read of a concept does not return.
- `review.due_completed`, `review.due_skipped` — the schedule is derived from evidence; no action of the learner completes or skips a due review.
- `error_notebook.entry_reviewed` — no route or screen marks an entry reviewed.
- `practice.session_abandoned` — emitted since M8 Track I, when the sweep finishes a run left alone. `practice.item_answered`, `practice.session_completed` — were held by D87 and D77 and are emitted since M8 Track H. `remediation.set_completed` is the one still held, by D112.

And `mastery.gain_verified` (and, since M8 Track H, `practice.session_completed`) is emitted by the relay's consumer after the work it reports has committed. If the process dies between the two, the redelivery finds the evidence stored and the gain is
not announced again. An outbox row for the gain, written in the recorder's transaction, would make it at-least-once.

**Trigger** Each event when the surface that can know it exists (D87's route, a solution screen, a review action); the gain's outbox row with the sink of D90, since an event that cannot be
stored makes at-least-once delivery of nothing.
**Cited** `apps/api/src/fitness/event-conformance.ts`

### D95 — An unknown address can cost more than a known account that is still on older parameters

A login for an unknown address verifies against a decoy made under today's parameters. A known account whose credential was made under cheaper parameters verifies faster until it is rehashed on its next login, so for
as long as such accounts exist the two paths differ by the difference in cost. It is small, it shrinks with every login, and it is zero while there is only one parameter set (there is, now); it exists the day N is raised.

**Trigger** The first change to `CURRENT_PASSWORD_PARAMETERS`: make the decoy for each verification the cost of the parameters the real credentials still hold, or rehash in the background until none do.
**Cited** `apps/api/src/contexts/identity/application/handlers/credential-handlers.ts`

### D97 — The in-memory rate limiter counts per process

`MemoryRateLimiter` keeps its counters in the memory of the process that serves the request. With more than one instance the limit a client meets is the configured one times the number of instances, and a restart
forgets every count. It exists for routes asked too often for a database round trip each; no route uses it yet (D98), and the authentication routes use the Postgres adapter, whose limit is the same from every instance.

**Trigger** The second instance of the application, or the first route given this adapter — whichever comes first. Then either move that route to a shared counter (Redis, or the Postgres adapter if its cost is acceptable
for the route) or state in the route's header that a limit that multiplies by the instance count is acceptable for it.
**Cited** `apps/api/src/platform/rate-limit/memory-rate-limiter.ts`

### D98 — Search, export, reporting and AI endpoints are not rate limited

NFR SEC-09 asks for per-identity and per-source limits on authentication, search, export, reporting and AI endpoints. The authentication routes are limited (D94, closed below). The others are not: the limiter
and both adapters exist and are tested, and nothing applies them to those routes. Each is a different cost and a different caller, and a limit chosen without looking at the route would be a number nobody can defend.

**What changed (M8-58, DEC-M8-35).** The learner routes that had no limit now have one: every route of Learning that is not the profile (`RATE_LIMIT_LEARNING`), the answers a run sends (`RATE_LIMIT_EVENTS`, which was the only unlimited write) and the other learner routes of a run (`RATE_LIMIT_ATTEMPTS`), each from the measured cost of the operation and the rate a real learner makes, with the arithmetic beside it. Not closed, because search, export and AI endpoints do not exist yet, and an operator's authoring and form routes are not limited. Limited now: profile (M8-20); concept map, a topic's answers, review plan, remediation concepts, concept names, error entries and their cause, bookmarks, report and pace; form package, create attempt, create and grow practice run, practice package, feedback, solution, result, attempt, start, submission; response events. Not limited: operator form routes, the package signing key.

**Trigger** The first of those routes to be exposed to a caller who is not a developer: choose its limit from what the route costs and who asks, apply it through the same port, and add it to the abuse simulation.
**Cited** `apps/api/src/platform/rate-limit/rate-limiter.ts`

### D99 — The bound on hashing is sized by hand against a thread pool it does not own

Scrypt runs on libuv's thread pool, four threads by default, and the pool is shared with file, DNS and compression work. The bound keeps at most `PASSWORD_HASH_CONCURRENCY` derives in flight (two by default, 128 MiB) so that
the pool is not held by hashing and memory does not follow someone else's setting of `UV_THREADPOOL_SIZE`. Nothing checks that the concurrency stays below the pool's size: raised past it, the bound stops protecting the pool and
its memory arithmetic is for a different machine. The memory of an unbounded burst on the default pool is about 4 x 64 MiB, not the gigabytes a count of requests suggests; with the pool at 16 it is about a gibibyte.

**Trigger** Anything that sets `UV_THREADPOOL_SIZE`, or a deployment with a container memory limit: have the process read the pool size at start and refuse a concurrency at or above it, and measure the burst in the deployed
environment.
**Cited** `apps/api/src/contexts/identity/abuse-simulation.integration.spec.ts`

### D100 — The list of known-bad passwords is short, and nothing checks a password against the person's own details

`BundledPasswordList` holds a few hundred passwords of twelve characters or more and two shapes (a short unit repeated, a run of one character after another). It stops the guesses a credential-stuffing run tries first and
none of what has leaked beyond them. The stronger source, the Pwned Passwords range service, is not wired: the port (`BreachedPasswords`) is shaped for it, with a third answer for "could not say", and the policy for that
answer is decided (accept, and leave one record), but no adapter makes the call. A password is also not compared with the address it is being set for, or with the name of the product, which NIST 800-63B asks for.

**Trigger** Registration opened to anyone who is not in the closed beta, or the first `BREACH_CHECK_UNAVAILABLE` record in a deployed environment: write the range-service adapter (a timeout of its own that answers
`unavailable`, only the first five hex digits of the SHA-1 leaving the process), and add the context-specific words.
**Cited** `apps/api/src/contexts/identity/infrastructure/bundled-password-list.ts`

### D101 — Nothing asks for a second factor, or a step-up, from the people who can now be made administrators

NFR SEC-05 says multi-factor is mandatory for Content Ops, Support and Platform Admin and that destructive actions need step-up; SECURITY-ARCHITECTURE §4 marks role administration as requiring it, and §1.2 leans on step-up for the
insider. None of it exists: the policies carry a `requiresStepUp` flag nothing can satisfy, and a login is a password and a session. M8-12 makes the gap real, because there is now a way to make an administrator. What stands in
the meantime is that only an administrator can assign a role, nobody changes their own, every change is audited, and the first administrator is made by a command that needs the database. The same applies to the alert the document asks
for on a new-device login to a privileged account (no device is recorded).

**Trigger** The first person who is not a developer and holds a role other than `learner`: a second factor at login for those roles, and a step-up the role routes can require and a person can satisfy.
**Cited** `apps/api/src/contexts/identity/application/handlers/role-handlers.ts`

### D102 — A session is an opaque thirty-day token with rotation, not a short-lived token with a refresh that detects reuse

SECURITY-ARCHITECTURE §2 and NFR SEC-06 describe short-lived access tokens with an opaque refresh, rotation, and reuse detection. What exists (ADR-0056) is one opaque token that lives thirty days and seven idle, can be rotated by
asking, and is refused at once when revoked. Nothing forces a rotation, and presenting a token that was already rotated away is refused as a revoked session and does not end the sessions that came from it, which is what reuse
detection would do. Revocation is immediate, which meets the half of SEC-06 that is about time.

**Trigger** The independent penetration test before launch (SEC-13), or the first report of a stolen session: decide whether a rotated token's reuse ends its whole chain, and whether the lifetime comes down.
**Cited** `apps/api/src/contexts/identity/application/handlers/session-handlers.ts`

### D103 — Nothing deletes an account, a session, or a spent one-time token

NFR §9.1 keeps session records ninety days after expiry and an account thirty days after a deletion request, and SECURITY-ARCHITECTURE §12 promises erasure within thirty days. The application role holds no DELETE on identity's
tables by design, and no job or route does the work: a deletion request has nowhere to go, and expired sessions and spent codes stay. The counters of the rate limiter are swept (D97); these are not.

**Trigger** The first deletion request, or registration opened beyond the closed beta: a retention job run under a role that may delete, and an erasure path that leaves the pseudonymous id the audit trail names.
**Cited** `infra/migrations/20261102100000_identity_user_credential_session.sql`

### D104 — SECURITY-ARCHITECTURE §7 describes a token bucket with limit headers and other numbers than the ones built

§7 says token bucket, limits exposed in response headers, login 5 per 15 minutes per identifier and 20 per hour per source, registration 10 per hour per source, verification 3 per hour. Built (ADR-0057, DEC-M8-3): two fixed-window
tiers, a refusal that carries `Retry-After` and nothing else about the limiter's state, and the numbers in `DEFAULT_ABUSE_LIMITS`. The code's choices are argued where they are made; the document is the one that is out of date, and the
numbers are nobody's measured result.

**Trigger** The first tuning of a limit against real traffic: rewrite §7 for authentication from `DEFAULT_ABUSE_LIMITS`, and decide whether the headers it asks for are wanted.
**Cited** `apps/api/src/platform/config/config.ts`

### D105 — An authorization denial leaves no record, and there is no support role

SECURITY-ARCHITECTURE §13 says every authorization denial is logged with principal, resource and reason, and alerts on an authentication-failure spike and on a failed-authorization spike for one principal. A refused
login or token is logged with its code; a request refused for want of a role answers 403 and writes nothing, in identity as in the other contexts. §4 also names a Support role with its own limits (INV-09) that `ROLES` does not
have, so none of its rules has anything to bind to.

**Trigger** The support console, or the first alert definition: one record per denial, with the principal and the policy and not the body, and the role added to the vocabulary with its policies.
**Cited** `apps/api/src/contexts/identity/application/authorization.ts`

### D107 — The analytics buffer is in `localStorage` and has the window the response log had

`emitter.ts` buffers analytics events on the device "the way responses do" and sends them in the background. It still keeps the buffer in `localStorage`, which Chrome commits some seconds after a write and, after the first few commits,
about once a minute (D66, closed for the response log). A browser killed outright loses the events buffered in that window, as well as the pseudonymous actor id if it was first made in it. Nothing a learner did is lost: the responses
are in the response log, which is in IndexedDB. Analytics is at-most-once by its own account (D92), so this is a smaller loss than the wording of the header suggested, but the header did say "the way responses do".

**Trigger** Anything that relies on an event reaching the edge that a killed browser can lose, or the next change to the emitter: keep its buffer in the same store as the response log (`RecordStore` has the shape, with another object store), or say in the header
that the buffer is best-effort.
**Cited** `apps/learn/src/analytics/emitter.ts`

### D108 — `onboarding.abandoned` is in the catalog and nothing emits it

The catalog names `onboarding.abandoned` (`last_step`, `seconds_elapsed`). Nothing can know a learner has left: a page that is closed sends nothing, and the server sees only the last step it was told about. M8 emits `onboarding.step_completed` and `onboarding.scope_declared` from the app. The abandoned event would
have to be inferred, either by the server from a profile that stops advancing or by the app on a page-hide that the browser does not promise to deliver, and both would report a guess as a fact.

**Trigger** The first analysis that needs drop-off by step: derive it on the server from the profile's last update and the learner's next session, and name the event after what it knows.
**Cited** `apps/learn/src/onboarding/onboarding-events.ts`

### D109 — The exams and the chapters are not kept on the device, so two of onboarding's questions need a connection

A learner who is offline can answer the class and give a past score, and the answers are kept and sent later (DEC-M8-12). The first question (which exam) and the third (what they have studied) are chosen from lists the server gives, and the app does not keep a copy: with no connection it says the list cannot be loaded and offers the way out. Keeping the lists would put a second copy of Curriculum's syllabus on the device, to go stale on the next version.

**Trigger** The first learner who starts onboarding on a connection that drops before the third question and is lost there: keep the last list read, with the taxonomy version it was read for, and say when it is older than the version in force.
**Cited** `apps/learn/src/ui/OnboardingScreen.tsx`

### D110 — A practice run cannot be scored under an exam profile whose sections pay differently for an item

A practice slot belongs to no section, so what a correct answer is worth cannot come from a section. The scoring consumer for runs takes it from the profile the run pinned when every section pays the same whole number of marks per item
(`marksPerItem`), which JEE Main and NEET do. Where they differ it fails with `PRACTICE_MARKS_UNDEFINED` and the delivery goes to the dead letters, where an operator sees it: a learner on such a profile has runs that never score, and no
evidence from them. It is loud, not a zero, and it is still a run that does nothing.

**Trigger** The first exam profile whose sections pay different marks per item: decide what an item that is in no section is worth for it (the lowest, the section of its subject, or a value the profile states for practice), and publish it as data on the profile.
**Cited** `apps/api/src/contexts/assessment/application/consumers/practice-scoring-consumer.ts`

### D112 — `remediation.set_completed` has no emitter, because a run is not stored with its purpose

Two of the three practice events that waited on a surface are wired (M8 Track H): `practice.item_answered`, said when the learner is told how an answer came out, and `practice.session_completed`, said by the server once a run is scored.
What is left is `remediation.set_completed` (`accuracy_delta_vs_baseline`). It needs a scored run to be a remediation for a concept, and that concept's standing when the run began. A run is not stored with its purpose:
`source` (recommendation, self, remediation) is said by the app when a run starts and kept nowhere, and a one-concept run started from a report's finding and one started from the home screen are the same run to the server. The baseline
could be read from the evidence rows (the concept's accuracy before the run), but only for a run known to be a remediation; emitting the event for every one-concept run would state a purpose that is a guess.
Two narrower limits of the wired two: an answer given with no connection has no verdict, so `practice.item_answered` is not said for it (inventing the outcome was the alternative), and `difficulty_band` is not sent because the question's
band is not on the device.

**Trigger** The first analysis that needs the accuracy gained on a remediated concept: store a run's purpose with the run (the app already knows it when it starts one) and read the baseline from the evidence rows before it.
**Cited** `docs/EVENT-CONFORMANCE.md`

### D113 — The concept map and its drill-down are served to every learner, though free learners are meant to see only the map

FR-STU-04 rule 4: the free tier sees the map; paid tiers see the full drill-down and the history. Both the map route and the route that serves the answers behind a topic answer any signed-in learner. Gating the second needs a learner's entitlement, which is M9; a gate built before it
would be a guess at what a plan includes.

**Trigger** The first entitlement a learner can hold (M9): the drill-down checks it, and says plainly when it is held back, as FR-STU-05 rule 2 asks of a recommendation.
**Cited** `apps/api/src/contexts/learning/application/handlers/concept-map-handlers.ts`

### D114 — The concept map is of the one syllabus version the learner chose, and lists only the topics they have answered on

The map reads the states of the taxonomy version the learner's exam resolved to when they chose it. Answers recorded under another version (a mock sat after the syllabus moved on) are not on it, and nothing says so. It also lists the topics the learner has evidence on and
counts the rest: FR-STU-04's output includes `unassessed` for a topic, and a learner is told how many they have not started, not which. Listing the whole syllabus would need every name of a version of hundreds of topics on each read.

**Trigger** The first syllabus version published after a learner has chosen an exam, or the first learner who asks which topics they have not started: carry the map across versions the way a scope is carried (`needs_review`), and serve the unstarted topics as a page of the syllabus, not a list inside the map.
**Cited** `apps/learn/src/ui/ConceptMapScreen.tsx`

### D115 — The diagnostic is breadth within scope, and "high-leverage" has no data to honour it

FR-STU-03 rule 1 asks for selection that is breadth-first across high-leverage concepts within declared scope. Breadth within scope is implemented exactly: one item for each concept in force before a second for any. "High-leverage" is not: the word appears once in the FRS and nowhere in the
code, blueprint weights are section-level, and no per-concept weight exists. A proxy (the number of items a concept has, or a blueprint weight spread down to concepts) would be a guess that reads as the fact. A consequence worth knowing: with more concepts in scope than the run has places,
the concepts it reaches are those first in identifier order, which is arbitrary and not representative; a learner's ten-question diagnostic over forty topics asks about the ten lowest identifiers.

**Trigger** The first per-concept weighting the curriculum carries (an exam weight on a concept, or a measured one): order the round by it, so a short run reaches the topics that matter before the ones that happen to sort first.
**Cited** `apps/api/src/contexts/assessment/domain/practice-selection.ts`

### D118 — Terraform targets a deployment other than the one being built, and is left as it stands

`infra/terraform/` describes ECS Fargate, RDS and an S3 state backend. The stack being built and booted is Compose, with a VM and TLS in front of it as the next step, which needs a machine and a domain only the owner can supply. Growing the Terraform now would be work thrown away if the deployment is not Fargate, and nothing validates that it matches
what the Compose file runs. It is not the plan; the Compose file is.

**Trigger** The decision where the beta runs. Then either the Terraform is brought to that target and validated against the images this track builds, or it is removed.
**Cited** `infra/terraform/staging/main.tf`

### D120 — SES mail is proved up to the provider's door, takes a static credential, and ends a message at "accepted"

`SesMail` is checked against a fake provider and AWS's published signing vector, never against SES, because no run here holds a credential or a verified sender (ADR-0013, Tier 3; the line in `docs/M8-ACCEPTANCE.md` is `Fail — blocked`). It takes an access key id and secret from the environment, not a role, so a host that grants credentials through an instance or task role cannot use it without a change; it reports the provider's answer to the call and not delivery, so a bounce or a complaint is invisible to the application; and a new SES account is in the sandbox, which delivers only to verified addresses until AWS grants production access.

**Trigger** The first run on a host with a verified sender: run `mail-smoke` (below), read the inbox, and either record the line as passed or fix what the provider said. Credentials from a role, and bounce handling, when the host is chosen (D118) or the first bounce is seen.
**Cited** `apps/api/src/contexts/identity/infrastructure/ses-mail.ts`

### D121 — Studio has no sign-in and takes a development token from `localStorage`

The learner app signs a person in (ADR-0065). Studio, which authors and reviews content, still reads `localStorage['qb-dev-token']` and sends it as a bearer token, which the API's session resolver no longer accepts (ADR-0056), so nobody can use Studio against a real API. Studio was outside this track and is not on the beta path (learners are), so it was left as it stood rather than given a second copy of the learner screens.

**Trigger** The first person who is not a developer to author or review content in Studio: a sign-in screen on the same routes, and the session in the same cookie.
**Cited** `apps/studio/src/main.tsx`

### D124 — A production process does not start, so the process that serves people runs as `development`

`createMediaStore` refuses `NODE_ENV=production` as a boot failure, because the only media store is the filesystem one and no S3 adapter exists (D32). Nothing else refuses it, so a deployment runs as `development` (DEC-M8-24, DEC-M8-27): debug-level log lines are not suppressed (the configured level, `info`, still applies), a log line may carry a stack, and a message goes to a file unless the SES settings are present. None of it reaches a response. It was found by trying to start one, when the SES adapter was meant to be chosen for production and could not be.

**Trigger** The S3 adapter (D32), or a decision to allow the filesystem store in production behind an explicit setting: then `NODE_ENV=production` for the process that serves people, and the Compose file's `NODE_ENV` follows.
**Cited** `apps/api/src/platform/persistence/filesystem-media-store.ts`

### D125 — The security scan sees advisories and credential shapes, and nothing about this code's own security

`tools/security/scan.mjs` (the `security` job) audits the lockfile against published advisories and scans tracked files for credential-shaped text. It does not see this code's own logic, authorization or data handling: a route that forgets to check who is asking passes it. It does not see an advisory published after the last push (the job runs on a push or a pull request, so a new one is seen at the next, not when it is published), an unreported malicious package, or a secret that is not shaped like one. M8's acceptance line also wants a manual security review, which has not been done, and M9 wants an independent penetration test.

**Trigger** The manual review (before the first student's data) and the penetration test (M9); a scheduled run of the job, if an unchanged lockfile is to be watched.
**Cited** `tools/security/scan.mjs`

### D126 — Five moderate advisories remain, all in the test tooling

`pnpm audit` reports five at moderate, none at high: vitest and `@vitest/mocker` 3.2.7 (path traversal and code injection through the mock server, fixed in 4.1.12), and `minimatch` 5, 9 and 10 and `glob` 10 under the coverage tool (fixed in minimatch 11 and glob 14). All are in the dev dependencies of the test runner and none is in a shipped bundle or the API image (which holds no dependencies). The version that closes the vitest ones is a major upgrade of the runner across every package, with a behaviour change in the mocking the specs use; it is not done here because it is a larger change than this track and a risk to every test. The gate is at high, so these are printed on every run and do not fail it.

**Trigger** The next planned upgrade of vitest to 4.1.12 or later, or a high-severity advisory in the same packages.
**Cited** `package.json`

### D127 — The learner screens are checked by a machine against WCAG 2.2 AA, and the manual half is not done

`tools/adversarial/src/accessibility.spec.ts` runs axe over every learner screen in each state it can show (loading, loaded, empty, failed), in a real Chrome against the built bundle. It found one thing, which was fixed: controls 21 pixels high, under the 24 that WCAG 2.2 2.5.8 asks, now 44 (a stylesheet in `index.html`). What it cannot see, and nobody has checked: whether the reading order makes sense; whether an error is announced when it happens (a `role="alert"` is checked for being there, not for being heard); where focus goes after a screen changes; whether the diagnostic can be sat with a screen reader from the first question to the last; whether the words are plain; zoom and reflow at 400%; a keyboard-only pass. axe's own figure is that automation finds about a third of the problems a person would. The stylesheet is also the app's first: the colour tokens the components name (`var(--qb-color-...)`) are defined nowhere, so every colour is the browser's default, and the contrast the pass reports is the contrast of defaults, not of a design.

**Trigger** The manual pass M8's acceptance wants (before the first student), a design that defines the tokens (then the pass is re-run on it), and M9's third-party audit.
**Cited** `tools/adversarial/src/accessibility.spec.ts`

### D128 — Backups are proved on the Compose stack, not on a host, and are not kept off it

`backup.sh`, `restore.sh` and `restore-drill.mjs` back up the stack's database, drop it, restore it and count every table again, in CI. They have not run on a host; a backup lands on the disk it protects until the owner copies it off; nothing schedules one; there is no point-in-time recovery (the dump is a snapshot, so up to a day of answers is what a daily backup can lose); the drill's database is a few hundred kilobytes, so nothing is known about a restore of a database of a realistic size or how long it takes; and a dump is unencrypted. The restore stops the API with `docker compose stop`, which the CI drill exercises but cannot show to matter (a restore that left the API running would also have worked there).

**Trigger** The host (D118): run the restore into a second database there, set the schedule, the copy off the host and the retention; point-in-time recovery when the data is worth more than a day.
**Cited** `infra/compose/restore-drill.mjs`

### D129 — Two hundred students signing in at the same instant wait in a queue, and the queue has no sentence in the learner app

Password hashing is bounded: two derives at once, 256 waiting, and a wait of at most 15 seconds (`PASSWORD_HASH_*`, D99). A derive takes 160 to 220 ms of CPU, so the sign-in rate the machine can serve is about two per core-second of derive, and a whole class signing in at once is a queue. The load run's stampede (every one of 200 students signing in in the same instant, `tools/load/load.mjs`) measures it. On the CI runner ([run 41939959319](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41939959319)) **164 signed in, with a median wait of 7.9 s and a 95th percentile of 14.9 s, and 36 were refused as busy after waiting the full 15 seconds**; all 200 were answered in 15.6 s. On the author's laptop all 200 signed in, the slowest after 13.6 s. The derived day-one rate (2 a second at 3x) is well within what a core serves, so the NFR targets hold at the rate the beta is expected to arrive at; the stampede is the bound on the worst case, and nothing in the NFR table states a target for it. A sign-in that waits near 15 seconds is a screen that looks hung, and one that waits longer is a "busy" refusal the learner app shows as a failure with no instruction to try again.

**What changed (M8-57).** The learner app now shows the sign-in wait as a wait after 3 seconds (a status, not an error), retries a retryable 503 on sign-in, registration and choosing a new password once (after 2 s, times a random factor of 0.5 to 1.5), and only then says to try again in a minute. `PASSWORD_HASH_CONCURRENCY` is a host setting, passed through Compose and described in docs/DEPLOYMENT.md ("Sign-in under load"). Still open: raising the capacity itself, which is the host's cores. The worst case a person waits is about 33 s (15 s server hold, the pause, another 15 s hold; two retries were 51 s), and the dominant term is the server's own hold, which the client cannot shorten.

**Trigger** The first class told to sign in together, or a stampede run that finishes slower than 15 seconds or refuses anyone: show the wait as a wait (and retry the refusal for the learner, with a delay), set `PASSWORD_HASH_CONCURRENCY` to the host's cores, refuse faster when the queue is deep (the 15 s hold is most of the wait), and raise the capacity.
**Cited** `tools/load/load.mjs`

### D130 — Outbox messages of a type nothing consumes accumulate for ever

The relay claims only messages whose type has a consumer. `ItemPublished` and `SolutionPublished` have none, so every item published leaves two live rows in `platform.outbox_message` that are never claimed, delivered or dead-lettered, and never leave the table: 36 on the seeded stack of 18 questions. They do not slow the relay (the claim's index is partial on live rows and filtered by type), but they make a count of "the outbox backlog" meaningless unless the unconsumed are counted apart, which `qb_outbox_unconsumed` now does. It was found by the soak, whose oldest unrelayed message was 14.6 days old.

**Trigger** The first consumer of either type (Studio's search, an item feed), or the table's size becoming a cost: a retention sweep for messages nothing will ever consume, or a consumer that acknowledges them.
**Cited** `apps/api/src/platform/observability/api-metrics.ts`

### D131 — The load test and the soak are a floor, on a runner, for minutes

`tools/load/load.mjs` plays the beta's derived rates at 3x for 90 seconds, and the soak for 180, on a two-vCPU runner that also runs the thing being measured. Latency is pessimistic, throughput is a ceiling, neither is the host's, and a percentile on it is not a production percentile. A 90-second run is about 900 operations: it cannot show a problem that needs a different shape of load (a long idle, a mock's real deadline), a leak that needs a day or a restart, or contention that needs more than one source address (the source tiers of three limits are raised for the run, so it does not measure the limiter, which has its own simulation). The 75-item form's submission and its scoring (PER-10, PER-11, PER-12) cannot be measured on a stack seeded with 18 questions and are blocked, not simulated.

**What the gate now asserts (M8-56, DEC-M8-34).** The one-in-four was a gate asking two questions with one number. Whether the stack meets the NFR cannot be answered on this runner, so the exit code no longer depends on the NFR: it depends on a budget for each stream on this runner, set at least twice the worst p95 the track's runs produced, and the comparison with the table is a figure in the output. A stream is gated on its percentile only with at least 100 successful samples (the others are reported, with their counts, and said to be under), and any failed operation fails the run at any size. A budget met is not evidence about production, and a budget breached is evidence that something changed here. Observed before the change: sign-in p95 191 to 215 ms against 300, the answers' p95 38 to 89 ms (p99 201), and one run that breached for a reason not kept.

**The soak's colour on a runner (M8 Track N, DEC-M8-36).** Its stall check turned on the ordering of two samples (a gap between drains above 5 s and an oldest message above 2 s landing on the same sample), so the soak's figures are a floor on a quiet runner and no more.

**Trigger** The host: run the same script against it from another machine, with a published 75-item form, and read the figures as the host's.
**Cited** `tools/load/load.mjs`

### D132 — The metrics, objectives and alert rules are files that nothing evaluates, and nothing pages anyone

`GET /metrics`, `infra/observability/slo.json`, the burn-rate rules rendered from it and the synthetic probe exist, and are Tier 2 (ADR-0013): parsed and asserted, never loaded by a monitoring system, never fired. There is no Prometheus or other scraper, no store for the series, no dashboard, no receiver for a page and no on-call rotation, so acceptance criterion 5 (pages per person per week) remains blocked on exactly that; and a file full of alert rules is not observability until something reads it. The alert expressions have not been checked by `promtool` (not installed here). The objectives' numbers (99.5% available, 95% under the NFR latencies, 99% for the relay and the probe) are this repository's proposals for a beta of two hundred and have not been agreed with anyone who would be paged by them.

**What changed (M8-59).** What a page means is now written, for each of the six objectives (docs/DEPLOYMENT.md, "What a page means"): one sentence, the first three things to look at (named metrics and commands that exist), and what makes it a false alarm; and a Sev-1 is defined for this product, with where an incident is written. A Tier 2 check asserts that every objective has a complete entry and every `qb_` metric the runbook names is on the `/metrics` page. **Still true:** nothing evaluates the rules and nothing pages anyone; the words are written before a first page, cannot be tested by behaviour, and the first real page is expected to correct them.

**Trigger** A host with a monitoring system: load the rules, check them with `promtool`, point a receiver at the page alerts, and correct the runbook (docs/DEPLOYMENT.md, "What a page means") with what the first real page taught.
**Cited** `infra/observability/slo.json`

## Closed

### D88 — The learner screens were told their exam profile and taxonomy by the address, and named a concept by its identifier *(closed by M8 Track G, [ADR-0062](adr/ADR-0062-the-concept-map-is-the-learners-whole-history-and-topics-are-named-by-curriculum.md))*

A practice run is made under an exam profile version, and "what is weakest" is asked about a taxonomy version; no route offered the learner either. The screens took both from the address (`?profile=`, `?taxonomy=`), and named a concept by the start of
its identifier (`Concept 3f2a9c10`) because no route offered a learner the name. Both were development wiring, and neither could reach a student's phone.

**What closed it (M8-27, M8-29, M8-30).** Curriculum names concepts through the seam it offers Learning (a name and the subject and chapter above it), and a route gives the learner those names; the screens read the exam profile and the taxonomy version from the learner's own profile and
say to choose an exam when there is none, so the address parameters and `conceptLabel` are removed together. The home screen, the report and the pace table name a topic; a topic whose name could not be read is "This topic". The vocabulary rule that forbids the rest is held twice: a source
scan refuses our words and any bare identifier in a string a learner could read, and each screen's spec reads the rendered screen and refuses the same words and any identifier in what is shown (`vocabulary-rules.spec.ts`, `vocabulary.spec.tsx`). No part of D88 survives: nothing
reads a version from the address, and no label shows an identifier. What an address still carries is which screen and which thing (a run, a report, a topic), which is routing and not context.

**Cited** `apps/learn/src/ui/screen-context.ts`

### D87 — A practice run's questions had no route, so the app started a run it could not show *(closed by M8 Track F, [ADR-0061](adr/ADR-0061-a-practice-run-is-delivered-as-a-package-and-scored-without-a-form.md))*

A practice run was made and started by one tap (M7-58, DEC-M7-31) and existed on the server with its items chosen, each with an exposure row. No route gave a learner those items: the attempt route returned a count of
slots, and the content a learner is shown comes only from a signed package, which a run, having no form, did not have. So the practice screen could show that the run had begun and say plainly that its questions could not
be shown; a learner could not answer them, and the feedback route had nothing to be asked about.

**What closed it (M8-23, M8-24).** A run has a signed package of its own, served by the code that serves a form's, under the same key and bytes-not-JSON discipline, at `GET /v1/assessment/practice-attempts/{attemptId}/package`.
It is private to the run's owner (another learner's is a 404 with no bytes), changes with the run when it grows, and counts nothing when it is read. It has a row of its own in the key-free argument (`practice-package`). The
practice screen is now the sitting: one question at a time on the screen a paper is sat on, through the same session, response log and writer, with the answers held on the device and sent after the commit that holds them, and
finished through the attempt routes. Feedback on an answered slot works (`practice-loop.integration.spec.ts`); the screen does not show it yet (D111).

**Cited** `apps/learn/src/ui/PracticeScreen.tsx`

### D117 — The home screen said "the topic you are weakest on" from standings the map calls too early to say *(closed by M8 Track I, [ADR-0064](adr/ADR-0064-a-run-left-alone-is-finished-for-the-learner-and-the-promise-matches-the-evidence.md))*

After the diagnostic every topic has two or three answers behind it, so the map shows every standing as too early to say (FR-STU-04 rule 2), while the home screen's next action named a weakest topic, from the remediation route, which reads the stored state whatever its confidence,
and stated it as fact. **What closed it (M8-37, DEC-M8-23).** The home screen asks the map how the topic stands and chooses its sentence by the standing's own kind: stated plainly when the standing is asserted, "so far" when it is tentative, and "so far" when the map cannot say, because not knowing is not a reason to sound sure. The criterion it served was reworded for the same reason (row 1 of `docs/M8-ACCEPTANCE.md`).

**Cited** `apps/learn/src/ui/HomeScreen.tsx`

### D38 — The Compose file built three contexts that did not exist *(closed by M8 Track I)*

`docker-compose.yml` declared `build: context: ./ai-fixture`, `dockerfile: apps/api/Dockerfile` and a studio build, and none of `infra/compose/ai-fixture/`, `apps/api/Dockerfile` or `apps/studio/Dockerfile` was in the repository. `compose-rules.ts` agreed with the file rather than the disk.

**What closed it (M8-38, M8-39, DEC-M8-24).** The API, learner and Studio images exist; `ai-fixture` is gone, because nothing calls an AI provider on the beta path; `compose-rules.ts` now reads the disk (a build context or Dockerfile that is not there is a violation) and requires the three secrets to be references; and the `compose` CI job builds the images and boots the stack, which is what a parse could never show.

**Cited** `infra/compose/docker-compose.yml`

### D116 — A practice run that is left without being finished recorded nothing *(closed by M8 Track I, [ADR-0064](adr/ADR-0064-a-run-left-alone-is-finished-for-the-learner-and-the-promise-matches-the-evidence.md))*

FR-STU-03's fourth rule says abandoning the diagnostic gives a partial map. It did when the run was finished with questions left. It did not when the run was never finished: evidence is made when a submitted run is scored, a run has no deadline, and
nothing submitted it, so answers given in a run that was put down and not picked up were in the response log and in no one's map. The brief for Track H assumed evidence is recorded per response; it is recorded per scored run.

**What closed it (M8-36, DEC-M8-22).** The sweep that submits a mock whose deadline passed also submits a practice run whose last activity is more than forty-eight hours old, by the path a learner's own finishing takes, so there is one way for a run to be finished
and it already produced a score record, evidence and the events. The run's event is the practice one, so it reaches the consumer for runs. Answers given and left are scored when the sweep finds the run, and the learner's map has them
(`first-weakness-journey.integration.spec.ts`). Two limits that stand: the sweep is the in-process scheduler, with the coordination D36 describes, and a learner who comes back after the cutoff finds the run finished and cannot add to it.

**Cited** `apps/api/src/contexts/assessment/application/handlers/expiry-handler.ts`

### D111 — The practice screen did not show a verdict, and a run could not be grown from the app *(closed by M8 Track H, [ADR-0063](adr/ADR-0063-the-diagnostic-is-a-strategy-and-a-run-tells-the-learner-how-an-answer-came-out.md))*

`GET …/slots/{slotId}/feedback` served the word correct, incorrect or unattempted for an answered slot of a run, and `POST …/practice-items` added slots to a run and changed its package. Neither had a place on the practice screen: a learner answered a run
and finished it, was told nothing until it was scored, and could not ask for more questions in the same run.

**What closed it (M8-33, DEC-M8-20).** After an answer has reached the server the screen shows the one word the route serves, as right or wrong; an answer the server could not judge is marked when the run is scored; and no marks, key or solution are shown or
implied. One action adds five questions and brings the run up again, which fetches the package the run now has and verifies it as the first was. What is true and stays true: a run can be sat with no connection, and then there is no verdict to show. The screen says the answer is saved and will be marked, never a guessed
word and never a wait (a request is given up on after six seconds). That is the design and not a debt; the cost is registered with the events that depend on a verdict (D112).

**Cited** `apps/learn/src/ui/PracticeScreen.tsx`

### D77 — A practice attempt's submission was not scored *(closed by M8 Track F, [ADR-0061](adr/ADR-0061-a-practice-run-is-delivered-as-a-package-and-scored-without-a-form.md))*

Scoring marks the slots of a form, and `AttemptSubmitted` named one. A practice attempt has no form (M7-25), so submitting one recorded the submission and wrote no event: no score record existed for it and Learning
received no evidence from it through the relay, so practice responses did not move mastery. That was deliberate and stated; the alternative, an event scoring could not act on, would have dead-lettered every practice submission.

**What closed it (M8-25).** A form-free submission is its own event, `PracticeAttemptSubmitted`, with no form in it; `AttemptSubmitted` keeps its required form and its version, and the relay's map hands each type to its own consumer.
Scoring read the form for the slots to mark and what each is worth. The slots are the run's own; what each is worth is what the pinned profile pays per item when its sections agree (D110 is the case where they do not). A run is
one section standing for nothing in the profile, and the profile's best-of, which names sections of a paper, is not applied to it. Learning needed nothing new. Against real Postgres, a run is started, served, answered, submitted,
scored and recorded as evidence, and the concept's state is made of exactly those responses (`practice-loop.integration.spec.ts`). A rule holds the wiring (`practice-rules.ts`).

**Cited** `apps/api/src/contexts/assessment/application/consumers/practice-scoring-consumer.ts`

### D93 — The gate before a durable kill looked for the event's bytes, and failed on a runner while the app lost nothing *(closed in the repair after M7 Track I)*

`sigkill-durable` waits until the last event is durable so that what it tests is restoring what a browser wrote, not losing what it had not (that is D66). The wait searched the profile's
LevelDB files for the event's id as text. On a runner it timed out after sixty seconds in a scenario that held thirty-four unsent events through an outage: the page showed them all, the retries
backed off correctly, and nothing about the app's durability had changed. A gate on bytes had gone red for a reason that was not the fact.

**Cause.** Not the one first suspected (compaction into compressed table files made the id ungreppable): a profile written to in the same way keeps the id as plain text in the write-ahead log for
as long as the log is the newest file. The event was not on disk. Chrome commits an origin's `localStorage` about five seconds after a write for its first few commits and about once a minute
after that, so a scenario that had been writing for a while had its newest events off disk for up to a minute, and the gate, which gave up at sixty seconds on a runner, was racing a limit it did not
know of. The gate was right that the value was not durable and wrong about how long that could last; a runner is slower, so a scenario reaches its limit earlier.

**What closed it.** The gate now reads the fact. A second Chrome is started on a copy of the profile's storage and asked for the record, so "durable" means that a browser started from nothing but the
disk reads the event; the files are looked at only to know when to ask again, never for the answer. It waited up to two minutes, which was the browser's own commit and not a timeout to be raised
when a runner is slow (M8 Track D moved the log to IndexedDB, whose transactions are durable when they complete, and the wait with it: D66). A durable kill that does not wait is shown to lose events, and the failure names them: the event expected, how many the device held, how many the restored record holds, and
which are missing. The D66 tests read the restored value too (`durable.ts`, `durable.spec.ts`).

**Cited** `tools/adversarial/src/durable.ts`

### D67 — A tab reopened during an outage cannot resume the attempt *(closed in two parts: M7-56, then the repair after M7 Track H2)*

The attempt continued through an outage while the page stayed open, and everything it held was on the device. Reopen the tab while the backend was down and the app asked the
server for the attempt before it would carry on. The cause was the order in `boot`: the device's record was read after two awaited network calls, so the one thing that survives an
outage was consulted only when the network was up.

**First part (M7-56, DEC-M7-30, ADR-0055).** `boot` reads the device's record first. The package is still fetched and verified before anything is created, started or shown, and a record
is carried on only against a paper that verified and is of the form the record names. When the server cannot be reached a record that names its form and holds the offset between the
server's clock and the device's resumes from the device alone, against the deadline it wrote down. That part was closed on a unit test that handed `boot` a package during the outage.

**Second part (DEC-M7-35).** In a real Chrome the package is in the service worker's cache only for a page the worker controlled, and the worker does not take over the page that installed it, so a
first visit alone left the shell cached and no package: the reopen had nothing to verify and the app said the server failed. The page now puts the package and its key in the worker's cache itself once it
has registered the worker, leaving the worker's rule against taking over a page untouched. The test that held this open in a real Chrome (`known-gaps.spec.ts`) is now a plain test, beside the one for a visit that was
reloaded.

**Cited** `apps/learn/src/bootstrap.ts` · `apps/learn/src/sw/warm-package.ts` · `tools/adversarial/src/known-gaps.spec.ts`

### D80 — Adversarial seeds timed out on a CI runner and not on a developer machine *(closed in the repair after M7 Track H2)*

Three times (seed 20261081 on `e604236`; seeds 20261125 and 20261085 on `cc2e6b3`, and 20261087 once the evidence was kept) a seed timed out after sixty seconds waiting for the question region of
the learner app, so ninety-nine of a hundred runs produced a result. Each passed when replayed alone. The entry guessed a slow runner, a shell that did not finish rendering, or a defect in the seed's path;
it was none of them.

**Cause.** The scenarios of a run share a few browsers, and a browser's profile keeps `localStorage`, Cache Storage and service worker registrations for as long as the profile lives, keyed by origin. A scenario's server
listens on a free port, which is a new origin unless the port is one an earlier scenario in the same browser used, and then it is the same site to the browser. The new scenario's first page was controlled by
the earlier one's worker and found its device record: an attempt the new server had never issued. The server answered 404, `boot` threw it, and the page showed *request failed with status 404*; the question region
never came. It depended on which port the system handed out and on which scenarios shared a browser, hence a different seed each time, no replay by seed (a replay builds a new profile and runs alone), and only on a runner, where the number of browsers, and so which scenarios share one, follows the machine's processor count. The file said the opposite: that a seed does not depend on what else ran in its browser.

**Fixed in two places.** The app: a record the server has never heard of is left behind and a clean attempt begins, with the learner told when something was in it (DEC-M7-34), because a learner who is not on a
test server can meet the same thing after a server reset. The harness: each scenario clears its origin (storage, caches, registrations) before its first page, and `isolation.spec.ts` runs one scenario and then another on the
same browser and the same origin and requires the second's first page to start with no attempt record, no cached package and no controlling worker; it fails when the clearing is skipped. With isolation in place all hundred
seeds pass, each as a first visit.

**Cited** `tools/adversarial/src/browser-run.ts` · `tools/adversarial/src/isolation.spec.ts` · `apps/learn/src/bootstrap.ts`

### D73 — The attempts spec failed intermittently *(closed at M7-21)*

`platform/composition/assessment-attempts.integration.spec.ts` guards REL-01 and REL-06 under outage. It failed about once in every dozen to twenty runs on this
machine — 2 in 40 on `c66d937` — with a request answered `404`, and the same cause produced the one `412` seen in `assessment-scoring.integration.spec.ts`
(a submit that did not take left the attempt unsubmitted, and the result route refuses an unsubmitted attempt). It was skipped at M7-09 after one bounded look found nothing.

**Which kind of 404: neither of the two it was thought to be.** The entry first read "`404 no attempt <id>`", and that was a misreading: supertest leaves the
body of an `application/problem+json` response empty, so no one had read the text, and the failing responses carried none. M7-20 made the spec read the row
and the wire at the moment of a 404. It is not an absent row and it is not a row excluded by a predicate (the lookup is `WHERE attempt_id = $1`; ownership is the
only other thing that turns a present row into a 404, and the clock is nowhere in it). **The application never answered.** The failing responses were
`HTTP/1.1 404 Not Found`, `Content-Length: 0`, `Content-Type: text/html`, no `Date`, no `X-Correlation-Id` (which the controller sets before it does anything
else), on a fresh connection to the very port supertest had just opened, and one of them was on `POST /v1/assessment/attempts`, which has no attempt in it.

**Why.** supertest starts a server that is not listening with `listen(0)`, which binds the wildcard address, and connects to `127.0.0.1:<port>`. On this
operating system a wildcard listener and a listener on a specific address can hold the same port number, and a connection to the specific address goes to the
specific listener. Headless Chrome processes left running by earlier adversarial runs (D75) listen on `127.0.0.1` ephemeral ports; every failing port in the log was
one of theirs, and a POST to one of those ports answers with exactly those bytes. About one run in a dozen to twenty drew such a port. CI runners are fresh and
Linux does not allow the sharing, which is why CI was green.

**The fix.** Every spec that sends requests to a Nest application with supertest now starts it with `serveOnLoopback` (`listen(0, '127.0.0.1')`), which takes a
port nothing else holds on loopback and keeps it; a rule (`loopback-rules.ts`) fails a spec that calls `getHttpServer()` without it. With the fourteen strays
still alive, the attempts spec ran 150 times and the scoring spec 100 without a failure.

**What the skip cost, and what it restored.** While the file was skipped the key-free argument's `attempt-responses` row pointed at two tests that did not run,
and the gate that reads the table could not tell (it checked that the titles were in the file); M7-17 fixed the gate, and M7-18 wrote the two tests where they
run. Three files carrying a 100% threshold (`assessment.controller.ts`, `attempt-handlers.ts`, `attempt.repository.ts`) had been lowered to what the suite measured;
M7-19 covered their branches from tests that do not need the composed application and restored all three to 100. The server-side parts of the offline-runtime
criteria (the union of two devices, the outage that drains) were not checked by the suite between the skip and the fix.

**Cited** `apps/api/src/testing/loopback.ts`, `apps/api/src/testing/response-diagnosis.ts`, `apps/api/src/fitness/loopback-rules.ts`


### D72 — A re-score does not tell Learning which outcomes changed *(closed at M7-40)*

`ExecuteRescoring` superseded score records and wrote one `AttemptsRescored` carrying the operation, a count, the trigger and the scope. It named no attempt, and no `AttemptScored` was
written for the successors, so a consumer holding evidence assembled from generation 1 could not learn that an outcome was corrected, and a learner whose attempt was re-scored kept the
evidence from the first score. The supersessions also committed one at a time, before the completion and its event.

Closed by M7-40 ([ADR-0053](adr/ADR-0053-a-re-score-announces-each-attempt-it-superseded-and-learning-corrects-beside-the-record.md)): every superseded attempt is announced
(`AttemptScoreSuperseded`) in the transaction that supersedes it, and Learning corrects beside the evidence it holds, revoking a promotion that was granted on an outcome that changed.
**Cited** `apps/api/src/contexts/scoring/application/handlers/rescoring-handlers.ts`


### D17 — Nothing drains the outbox *(closed at M6-38)*

`platform.outbox_message` was written transactionally with the aggregate that produced the event, and no relay consumed it. The payload
discipline that matters — identifiers and version numbers only, never a stem, a key, a solution body or a reviewer's justification — is
there because the drain target is analytics (P4).

Closed by M6-38 ([ADR-0038](adr/ADR-0038-the-outbox-relay-delivers-at-least-once-and-scoring-is-its-first-consumer.md)). `OutboxRelay` claims
messages under a lease, hands them to the consumers registered for their type, and marks them published only when every consumer returned:
**at least once**, in order per aggregate among live messages, with a back-off, a dead letter for a message that keeps failing, and a
`requeue` for an operator. The effect happening at most once is the consumer's job. The payload discipline is now a gate on what it emits: a
message that names a key field, a stem or solution field, or carries prose under any name, is dead-lettered before a consumer sees it.

What is **not** drained is by design and not debt: a message whose type no consumer is registered for stays where it is. `AttemptSubmitted` has
a consumer; the other contexts' events are waiting for theirs (M7's learning loop is the first named).

**Cited** `apps/api/src/platform/outbox/relay.ts`, `contexts/content/domain/events/content-events.ts`, `infrastructure/outbox-emitter.ts`,
`contexts/scoring/public/composition.ts`, `platform/persistence/audit-anchor.ts`

### D60 — Submitting an attempt requests no scoring *(closed at M6-39)*

`SubmitAttempt` moved the attempt to `submitted` and emitted nothing, so "submitting twice scores once" was true only because nothing was
scored.

Closed by M6-39 and M6-40. The state change and an `AttemptSubmitted` event are **one transaction** (proved by failing the second and seeing the
first rolled back), written only by the move that happened — the loser of a race writes nothing, a retry writes nothing. Scoring consumes the
event and scores exactly once per submission under retry, redelivery and concurrent delivery, which the integration spec asserts, including the
case where scoring fails and an operator requeues it.

**Cited** `apps/api/src/contexts/assessment/application/handlers/attempt-handlers.ts`


### D54 — Nothing abandons a created attempt when its window closes *(closed at M6-20)*

ADR-0030 gave `created` an `abandon` edge, guarded on the attempt's window having closed, and left the
other half undone: a window that closes and something that acts on it.

Closed by M6-20. A form now has a schedule window — a server-side fact fixed when it is scheduled, copied
to every attempt on it and tied to it by a foreign key, so no client supplies one — and the attempt
repository finds the live attempts a closed window left behind (`findAbandonable`) for the domain's
`abandonAttempt` to decide. What is **not** built is anything that calls them on a schedule: that is
[D36](#d36--no-scheduler-so-the-ageing-sweep-is-never-invoked) again, which now also covers opening and
closing form windows and abandoning attempts.

**Cited** `apps/api/src/contexts/assessment/domain/attempt.ts`

### D53 — An attempt that is created and never started has no terminal state *(closed at M6-09)*

ASSESSMENT-ENGINE §5's diagram reached `abandoned` only from `in_progress`, so an attempt created and
never started stayed `created` for good, which collided with the same section's one-active-mock rule.

Closed by [ADR-0030](adr/ADR-0030-a-created-attempt-can-be-abandoned-and-active-is-a-state.md): `created`
gets an `abandon` edge guarded on the window having closed, and "active" is defined by state alone so the
rule can be a partial unique index. The window-closing half was left undone then, and was built as [D54](#d54--nothing-abandons-a-created-attempt-when-its-window-closes-closed-at-m6-20), which is closed too.

**Cited** `packages/attempt-engine/src/attempt-state.ts`, `apps/api/src/contexts/assessment/domain/attempt-state.ts`

### D46 — A candidate that failed a blocking check stayed `proposed` for good *(closed at M5-40)*

Deciding was a human act and the pipeline held no capability to decide, so a candidate that failed a
blocking pre-check could never be accepted and was never rejected by anything; M5-39 kept it out of the
list a person works from, but it stayed stored as `proposed` and counted by `findByRun`.

Closed by [ADR-0029](adr/ADR-0029-the-pipeline-disposes-of-a-candidate-on-the-batterys-result.md): the
battery's result is acted on by the pipeline (`DisposeCandidate`), and a candidate that failed a blocking
check is rejected, terminally, in the same run. `isForReview` stays as the listing's guard for a candidate
whose rejection could not be saved; the normal path no longer leaves one.

**Cited** `apps/api/src/contexts/generation/application/queries/candidate-queries.ts`, `apps/api/src/contexts/generation/domain/generation-candidate.ts`, `apps/api/src/contexts/generation/application/handlers/decision-handlers.ts`

### D43 — Curriculum's read policy did not admit the generation pipeline *(closed at M5-35)*

Check 5 reads concept membership through curriculum's own `GetTaxonomyVersion`, which curriculum
authorized for learners, curators, Content Ops and exam owners — not the pipeline, so under its own
identity the read was refused and the check could only run for a principal borrowing another role.

Closed by the simpler of the two options. A taxonomy is published, versioned reference data, not
sensitive: a learner may read it, so a machine classifying against it may too. `generation_pipeline` is
added to **that one query's** policy and nothing else — no delegated read context, no other query, no
command — and a spec over curriculum's whole composed registry asserts exactly that. Check 5 now runs
under the pipeline's own principal, proved against curriculum's real handler.

**Cited** `apps/api/src/contexts/generation/infrastructure/curriculum-syllabus-reader.ts`

### D18 — Hand-written contract schemas *(closed for content)*

`packages/contracts/src/content-schemas.ts` is generated from `openapi/content.yaml` by
`scripts/generate-zod.mjs`, and the contract spec regenerates it and fails on any difference — so an
edit to the generated file is caught rather than merged. One contract has one description, and a
mismatch is fixed in the document, never in the copy. Curriculum and scoring have not been brought
onto the same footing.

### D20 — Lifecycle state machine attributed to the wrong milestone *(closed at M4-45)*

Delivered by M3, not M4. The machine lives in content's domain with an exhaustive 72-pair transition
matrix, and M4 built the workspace against it. ROADMAP amended;
[ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) records the divergence.

### D22 — Process-local idempotency store *(closed at M0-08)*

`PostgresIdempotencyStore` implements content's `IdempotencyStore` port unchanged — a port that had to
move to get a durable adapter would have been the wrong port. A key remembered by one instance is seen
by a new instance against the same database, which a process-local `Set` cannot do.

### D27 — No production `RenderValidator` adapter *(closed at M0-09)*

`RenderValidatorAdapter` maps `ItemVersion` onto what `validateRender` expects and maps the verdict
back, so M3-11's publication precondition runs against a real render rather than a test-supplied fact.
The original note called this "a composition gap rather than a design one" and undersold one
consequence: the API's own compiler must type-check the renderer's `.tsx`, which
[ADR-0016](adr/ADR-0016-the-api-type-checks-the-renderer-package.md) records and bounds.

### D75 — A headless browser left running by the adversarial suite stays on loopback *(closed at M7-31)*

`tools/adversarial` launched Chrome with `--remote-debugging-port=0` and killed it when the run ended; a run whose own process died first left it listening on a
loopback port, and left its profile directory behind. On the machine this was found on there were sixty such browsers, some a day old, and 255 profile directories
of about 7.2 GB — which is what answered the requests D73 saw.

*Correction, 2026-10-27.* The `qb-prof-*` profiles seen alongside them were never made by this repository: that prefix appears on no ref, and the launcher makes only
`qb-adversarial-*`. Fixing the launcher cannot end those, and the sweep neither reports nor touches them.

**What closed it (M7-24).** The launcher tracks every browser it starts and kills its process group on exit and on `SIGINT`, `SIGTERM` and `SIGHUP`; each profile is
stamped with its owner's pid and removed when the run ends; and a sweep before and after the suite reports profiles whose run is alive and reclaims those whose run is
dead, matching only `qb-adversarial-*` directly under the temp directory, never following a link and signalling nothing else (shown with a real stranger process left
running). The suite ran green and left no profile and no browser.

**What the sweep found, and what was not shown.** On the machine this was closed on there were none to find: no profile and no browser before the run, so the reclaim
of an old backlog was exercised by constructed tests and not by the 7.2 GB that was measured elsewhere. A worker killed with `SIGKILL` cannot run anything, and its
browser outlives it until the next run's sweep.

**Cited** `tools/adversarial/src/chrome.ts`, `tools/adversarial/src/profiles.ts`

### D78 — Practice has no route *(closed at M7-53)*

`CreatePracticeAttempt`, `GrowPracticeAttempt` and `GetPracticeFeedback` were handlers with policies and tests and no HTTP route: a route needs an OpenAPI
operation, a contract, a controller method and an entry in the key-free `attempt-responses` surface. The contract spec named the unrouted set so that a handler could
not be left unrouted by accident, and listed these as the learner's, apart from the scheduler's two.

**What closed it (M7-53).** The three have operations in `assessment.yaml` (`POST /v1/assessment/practice-attempts`, `POST …/attempts/{attemptId}/practice-items`,
`GET …/attempts/{attemptId}/slots/{slotId}/feedback`), controller methods, and their responses in the `attempt-responses` key-free scan. A run is started, answered and
submitted through the attempt routes that already existed. Assessment's unrouted set is the scheduler's two, `SubmitExpiredAttempts` and `SweepWindows`, which a request
never makes. Another learner's run answers `404` on the grow and feedback routes, as an absent one does. D79 is not closed by this: a route does not change under whose
rules feedback is judged.

**Cited** `apps/api/src/contracts/assessment-contract.spec.ts`

### D85 — An escalation is never withdrawn *(closed at M7-54)*

A concept escalated to remediation (M7-48, DEC-M7-25) stayed escalated: nothing marked it resolved, neither the concept recovering nor a re-score correcting the responses
its lapses were counted from. A learner who had recovered was shown a remediation finding, and one whose lapses were a mis-scored sitting was shown one they did not earn.

**What closed it (M7-54, DEC-M7-27).** The fold that makes an escalation decides when it stands. A concept is escalated while it has lapsed `escalateAtLapses` times and is not
`strong`; a delivery that touches a concept whose escalation would not be made now resolves it, with the reason (`recovered`, or `lapses_corrected` where the count no longer
reaches the threshold). The resolution is a row beside the escalation (`learning.review_escalation_resolution`), as a revocation sits beside a transition; the escalation is
not changed or deleted. `learning.open_review_escalation` is the one definition of "still stands", and what is due, what a targeted run is about and what the learner is
shown all read it. A concept whose escalation was resolved can be escalated again if it lapses again; it has at most one open at a time.

**Cited** `apps/api/src/contexts/learning/infrastructure/review.repository.ts`

### D68 — The learner app does not pull the server's log: a second device starts from nothing *(closed at M7-55)*

The server held every event it had acknowledged, and the app never read them back. A device with no record of the attempt — a second device, or the same one after its storage was
cleared — created the attempt (the server returns the existing one), started it (likewise) and began an empty log. What the learner did before was not shown, and the new events were
numbered from one again, which the server's ordering (client sequence, then id) interleaves with the old ones. The number of the next event came from one place only, the device's own
log, so returning the server's log from the attempt route would not by itself have fixed it.

**What closed it (M7-55, DEC-M7-29).** `GET` of an attempt returns the log beside the attempt: the events that count, as the engine's own events. A session resumes from the union of
what the device wrote down and what the server returned (the engine's own merge), so the counter is read from the merged log and a resumed device numbers after the last number either
used. Proved with two devices against one attempt through the routes, with a control that numbers from one and is interleaved by the same ordering.

**Cited** `apps/learn/src/bootstrap.ts`

### D86 — A learner's bookmarks are looked up in content in one call *(closed at M7-55)*

`ContentItemStandings` asked content for the standing of every bookmarked item in a single call. Content bounds a call, and a learner with more bookmarks than that bound got
`SOURCE_UNAVAILABLE` (a `503`) from `GET /v1/learning/bookmarks` and no list. The adapter held no page size of its own, on the reasoning that a number written there would be a second
statement of content's bound; the repository already stated that bound twice (`TAXONOMY_BATCH` in the evidence adapter, and content's own cap).

**What closed it (M7-55, DEC-M7-28).** Content states its bound once, on the seam it offers Learning (`batchBound`), and both callers in the composition root page at it: the standings
adapter and the three taxonomy reads of the evidence adapter, whose private constant is gone. The handlers still refuse one identifier more than the seam says, and a test holds the two together.

**Cited** `apps/api/src/platform/composition/learning-standing.ts`

### D94 — Nothing limited how often the login and issuing routes could be asked *(closed by M8 Track B, [ADR-0057](adr/ADR-0057-limit-the-rate-and-bound-the-work.md))*

Login, registration, password recovery, reset and verification-code requests were open to anyone and not throttled: an attacker could guess passwords, flood an address with mail, or spend the server on hashes as fast
as the connection allowed.

**What closed it.** Each of those routes, and password change, is limited before it does anything that costs, by where the request came from and by whom it is about (an address, or the signed-in user), in a burst
tier and a sustained one, with the counters in Postgres so the limit holds across instances. A limited request answers 429 with `Retry-After`, the same for a known address and an unknown one, and has done no lookup and no derive.
Behind the limit, every password derive takes a turn at a bound of two in flight with a queue of 256 and a wait of fifteen seconds, so requests the limiter admitted cannot hold the thread pool. The abuse simulation shows a burst of 400 from one
source served 100 and refused 300 with no derive spent on the refused, and a school of 100 logging in at once all served. Registered with it: D97, D98 and D99.
**Cited** `apps/api/src/contexts/identity/api/admission.ts`

### D96 — Nothing assigned a role *(closed by M8 Track C, [ADR-0058](adr/ADR-0058-refuse-bad-passwords-and-make-the-first-non-learner.md))*

Everyone who registered was a `learner`, and the first author, reviewer or administrator was made by a database update.

**What closed it.** An administrator, and only one, can give a person a role and take it away (`POST /v1/identity/roles/assign` and `/remove`), audited, from the roles a person can hold. The role is in force at the person's next
request on the session they already have. Nobody changes their own roles, nobody is left without one, and the last enabled administrator cannot be removed. The first administrator is made by `bootstrap-admin`, a command that needs the
database, works only while no enabled administrator exists, and is audited as the system. What is left is D101 (no second factor or step-up for the roles that should have one) and D105 (no support role).
**Cited** `apps/api/src/contexts/identity/application/handlers/role-handlers.ts`

### D106 — A change and the audit row that records it were written apart *(closed by M8 Track D, [ADR-0059](adr/ADR-0059-an-audited-write-is-one-transaction-and-the-response-log-is-on-disk.md))*

Identity committed a change (a role, a password, a verified address, the end of every session, a new account) and then wrote its audit row through a second call, so a crash or a failed audit write between the two left a privilege
grant, or any of the others, with no record of who made it. Found in M8 Track C and first written into D101.

**What closed it.** The store that makes a change writes its audit row on the same connection, in the same transaction: the method takes the record, or a function from the person's id to it where the id is only known inside the
transaction, and the platform's recorder writes on the connection it is handed. Eight writes were checked, all had the hole, and all are fixed: registering, verifying an address (which also spent the code and marked the address in
three separate calls, now one), changing a password, resetting one, ending every session, giving a role, taking one away, and making the first administrator. A spec runs each twice, with an audit write that fails (nothing of the change
remains) and with a recorder that looks from a second connection while the transaction is open (neither the change nor the row is visible yet). Not audited, by design: logging in, rotating or ending one session, and rewriting a hash
under newer parameters, which say nothing a session row does not.
**Cited** `apps/api/src/contexts/identity/infrastructure/postgres-stores.ts`

### D66 — A browser killed outright loses what it had not yet written to disk *(closed by M8 Track D, [ADR-0059](adr/ADR-0059-an-audited-write-is-one-transaction-and-the-response-log-is-on-disk.md))*

The learner app wrote every response to `localStorage` before it tried to send it. A tab that crashes or is closed, and a browser that quits, keep all of it; a browser killed with no warning (the way a phone short of memory kills one)
did not: Chrome commits an origin's `localStorage` about five seconds after a write for its first few commits and about once a minute after that, so a learner who had been answering for a while could lose up to a minute of answers,
and with the backend unreachable nothing anywhere had them (D93 measured the window).

**What closed it.** The response log is in IndexedDB, in one transaction per commit opened with strict durability and reported complete only when the data is on disk. The screen does not wait for the commit: the answer is in the engine and
shown at once, one commit is kept in flight and everything that changed meanwhile goes in the next, and an event is sent only after the commit that holds it (so the server never holds what the device would forget). A record an earlier build left in
`localStorage` is moved across before the page renders, removed only after the commit. If the device cannot keep the log the screen says so and the answers are sent as they are given.

**Evidence.** An answer given with the backend unreachable and the browser killed a quarter of a second later is there on reopening, six kills in six (`known-gaps.spec.ts`); the same test against the previous build fails on the first, as D66
said it would. Measured in Chrome on the machine this was written on, a commit takes a median of 14.7 ms and at most 17 ms.

**What is still lost.** An answer whose commit has not completed when the browser dies or the tab closes: about 15 ms after a tap on a healthy disk, longer on a slow one, when the backend is also unreachable. That is the window, not nothing; a tab closed
inside it loses the answer, as the first version of the offline-reopen tests showed. Strict durability is about the operating system or the power failing, which a killed browser process does not distinguish from relaxed, and the run that proves it
cannot kill the machine. What the adversarial runs plant is a slow disk (`device-record.ts`), under which a kill without the gate before it loses events and one with it does not.
**Cited** `apps/learn/src/session/persistence.ts`

### D69 — The learner app takes its bearer token from `localStorage` *(closed by M8 Track J, [ADR-0065](adr/ADR-0065-a-browsers-session-is-a-cookie-script-cannot-read-and-a-stranger-can-reach-the-product.md); Studio's part is D121)*

There is no sign-in. As in Studio, a developer sets `localStorage['qb-dev-token']` to a bearer token, and the app sends it. It is a development
convenience that must not survive to a student's phone.

There is now a sign-in on the API (ADR-0056), and the token this line sends is no longer accepted by it: the stub resolves no human request. What is still to do is the app's: a login screen on those routes, the session token held where script cannot read it, and this line removed from `main.tsx`.

**Trigger** M8 (closed beta hardening): the login screen, the token held where script cannot read it, and this line removed from `main.tsx`.
**Cited** `apps/learn/src/main.tsx`

**What closed it (M8-42, M8-43).** The learner app has a sign-in, and its session is an `HttpOnly`, `Secure`, `SameSite=Lax` cookie that script cannot read, with a second cookie echoed in a header and an origin check against another site. `localStorage['qb-dev-token']` is gone from `main.tsx`, and nothing about a session is kept in browser storage. **What does not close:** Studio still takes a development token from `localStorage` (D121).
**Cited** `apps/learn/src/main.tsx`

### D119 — A production process has no mail provider, so nobody can register against it *(closed by M8 Track J, [ADR-0065](adr/ADR-0065-a-browsers-session-is-a-cookie-script-cannot-read-and-a-stranger-can-reach-the-product.md); what is not proved is D120)*

`defaultMail` gives a development process a directory to write messages to, a test a list, and every other process a mail port that refuses to send, because a message carries a secret that must not be written to a disk by default and the provider is a decision not yet taken. The Compose stack therefore runs in development mode, and a stack in front of the public could not take a registration. The learner app also has no sign-in screen (it takes its bearer token
from `localStorage`, D69), so nothing a person does in a browser reaches the journey; it is run over HTTP.

**Trigger** The decision of a mail provider, and the first stack a person who is not a developer is to register on: an adapter for it, and a sign-in screen in the learner app.
**Cited** `apps/api/src/contexts/identity/public/composition.ts`

**What closed it (M8-41, M8-43).** A process with the four SES settings sends through SES, in development or production (DEC-M8-27); production without them refuses every send; half-configured does not start. The learner app has a sign-in, a registration with a check-your-mail screen and a resend, and a screen the link in a message opens. **What is not earned:** that SES accepts a message from a real account (D120); the Compose stack's CI run is still without the settings, so mail there is a file; and the process that serves people is a development process, because production does not start (D124).
**Cited** `apps/api/src/contexts/identity/public/composition.ts`

### D123 — The Compose file publishes an unauthenticated database and the API on every interface *(closed by M8 Track K)*

`infra/compose/docker-compose.yml` publishes Postgres on 5432 with `POSTGRES_HOST_AUTH_METHOD: trust` (anyone who can reach the port is the superuser), the API on 3000, and Studio on 4173, each on all interfaces. That is what a laptop and a CI runner want (the seed commands and the journey reach them on `localhost`) and what a host that faces the internet must not have. `docs/DEPLOYMENT.md` tells the owner to firewall everything but 80 and 443; the file does nothing about it. Binding them to `127.0.0.1` would fix it, but `compose-rules.ts` reads a published port's first colon-separated field as its host port, so every binding to `127.0.0.1:` would read as one port collision.

**What closed it (M8-46).** The database, the API, Studio and minio publish on `127.0.0.1` only, and `compose-rules.ts` reads the three-field form and fails the `fitness` job if any of the four is published wider. The database asks for a password (`QB_DB_PASSWORD`, a reference, generated per run by `boot.mjs`). **What does not close:** the learner app's 8080 is meant to be reached and publishes on every interface, so a firewall is still the only protection for it (it is a static app and a proxy to the API, which has its own limits); a database volume made under `trust` before this change keeps accepting anyone until it is removed; and nothing here checks a host's own firewall.
**Cited** `infra/compose/docker-compose.yml`

### D122 — A learner signed in on one device too many is signed out of the oldest, and nothing tells them *(closed by M8 Track K, DEC-M8-28)*

`MAX_SESSIONS_PER_USER` (default 5) ends the oldest session when a login exceeds it. The server answers the login with success and says nothing of the session it ended, so the learner app has no message to show and the person on the oldest device finds themselves at the sign-in screen without being told why. The limit has no surface to build a screen on: no refusal, no field in the login answer. Building the screen first would have meant inventing the server's side.

**What closed it (M8-47).** The login answer carries `sessionsEnded`, a count. A new route, `GET /v1/identity/session`, says whether the session a request carries is in force and whether a later sign-in ended it (`endedBy: 'another_sign_in'`), answering 200 either way; the learner app asks it on every load in place of reading the profile, and its sign-in screen says "You were signed out because your account was signed in on another device." **What does not close:** the person on the new device is not told that another was signed out (the count is in the answer and no screen shows it); the sentence is shown for as long as the stale cookie is held and goes when they sign in; a session ended any other way (a sign-out elsewhere, a password change) says nothing of why; and no screen lists devices, by design.
**Cited** `apps/api/src/contexts/identity/application/handlers/session-handlers.ts`

