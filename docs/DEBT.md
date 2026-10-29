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

### D31 — No OpenTelemetry exporter

The span tree stands in for a trace and does not pretend to be one. Writing an exporter against an SDK
this repository cannot compile against would produce a file never type-checked against the API it
claims to implement, which is worse than its absence.

**Trigger** The OTel SDK becoming installable.
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

### D38 — The Compose file builds three contexts that do not exist

`docker-compose.yml` declares `build: context: ./ai-fixture`, `dockerfile: apps/api/Dockerfile` and
a studio build — and none of `infra/compose/ai-fixture/`, `apps/api/Dockerfile` or
`apps/studio/Dockerfile` is in the repository. `compose-rules.ts` agrees with the file rather than
the disk, because it parses structure and cannot know whether a build context resolves; that is
precisely the Tier-1 property [ADR-0013](adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md)
forbids it from claiming. The stack has never been run, so nothing has ever surfaced it.

**Trigger** The first real `docker compose up`. At that point either the three contexts get built,
or `ai-fixture` comes out of the file and out of `REQUIRED_SERVICES` — the file and the disk must
agree, and today they do not.
**Cited** `apps/api/src/fitness/compose-rules.ts`

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
### D66 — A browser killed outright loses what it had not yet written to disk

The learner app writes every response to the device's `localStorage` before it tries to send it, and a tab that crashes or is closed, and a
browser that quits, keep all of it — a hundred seeded runs in a real Chrome show that. A browser killed with no warning (the way a phone
short of memory kills one) is different: Chrome commits `localStorage` to disk some seconds after the write, and what was written in that window
is gone on reopening. If the server has the response the learner gets it back from there; **if the backend was unreachable, nothing has it.**
Measured in `known-gaps.spec.ts`: a kill that lands before the write is on disk loses the answer, and one that waits for the write
(about five seconds on this Chrome) loses nothing.

**Trigger** Real-device evidence that a learner is killed mid-attempt while offline, or any change to how the log is kept: the log moved to
IndexedDB with strict durability (a transaction that completes only once it is on disk) closes the window, and the test that describes it goes red.
**Cited** `apps/learn/src/session/persistence.ts`

### D69 — The learner app takes its bearer token from `localStorage`

There is no sign-in. As in Studio, a developer sets `localStorage['qb-dev-token']` to a bearer token, and the app sends it. It is a development
convenience that must not survive to a student's phone.

**Trigger** M8 (closed beta hardening): real sign-in, the token held where script cannot read it, and this line removed from `main.tsx`.
**Cited** `apps/learn/src/main.tsx`

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

### D67 — A tab reopened during an outage resumes only if the service worker already holds the package; a first visit alone leaves none *(half closed at M7-56)*

The attempt continued through an outage while the page stayed open, and everything it held was on the device. Reopen the tab while the backend was down and the app asked the
server for the attempt before it would carry on. The cause was the order in `boot`: the device's record was read after two awaited network calls, so the one thing that survives an
outage was consulted only when the network was up.

**What M7-56 closed (DEC-M7-30, ADR-0055).** `boot` reads the device's record first. The package is still fetched and verified before anything is created, started or shown, and a record
is carried on only against a paper that verified and is of the form the record names. When the server cannot be reached a record that names its form and holds the offset between the
server's clock and the device's resumes from the device alone, against the deadline it wrote down. A server that answered and refused is not an outage and is not carried through.
Shown in a real Chrome (`known-gaps.spec.ts`): a tab reopened with the backend down shows the question with the learner's answer checked, when the worker holds the package.

**What is still open.** The package comes from the service worker's cache when the server is failing, and the worker caches it only for a page it controls. A worker does not take over the
page that installed it (no `clients.claim`, by design: a new shell must not be swapped under an attempt), so the first page of a first visit asks for the package straight from the network
and nothing is kept; the cache holds the shell and no paper. A learner who opened the app once, answered, and lost the tab during an outage reopens to the shell and the words *request
failed with status 503*: the answers are on the device and out of reach, which is the symptom this entry was opened for. It is cured by any later visit while the backend is up (a reload, or
the next day's), so it bites the learner who has not yet had one. Measured, with the console, network log and screenshot of the reopen: the package and key requests are answered 503 by the
worker, which has nothing to fall back on.

**Trigger** A decision on how the package reaches the cache on a first visit — the page asking for it once the worker controls it, or the worker fetching it when it installs — and the test that
holds this half open goes red the day it does. Real-device evidence that a first visit is lost to an outage is what makes the decision worth taking now.
**Cited** `apps/learn/src/bootstrap.ts` · `tools/adversarial/src/known-gaps.spec.ts`

### D80 — Adversarial seeds time out on a CI runner and not on a developer machine

On `e604236`, seed 20261081 timed out after 60 seconds waiting for `getByRole('region', { name: /^Question \d/u })` in the browser run, so ninety-nine of a hundred runs produced a result and
the run's length assertion failed. On `cc2e6b3`, seeds 20261125 and 20261085 timed out at the same wait. The two latest pass when replayed alone on a developer machine under `CI=1` (the same 60 seconds), as the first did. Nothing is known of the cause: a slow runner, a package the shell did not finish rendering, or a real defect in the seed's path are all possible, and none has been shown.
The one thing the capture of D67 established is what it is not: a first visit whose package is never cached (D67) does not render the question, but no seed reopens a tab during an outage, so it is not this.

**What is kept now.** A run that times out writes the page's console, every request and what became of it (and whether the worker answered), a screenshot, and what the page was showing, to
`tools/adversarial/failures/seed-<n>/`, and the workflow uploads that directory as the `adversarial-failures` artifact after the job, passing or failing. The first runner failure after this carries its own evidence.

**Trigger** The next runner failure of this suite: download the artifact and read `summary.json` first. If the page was blank, the shell did not render; if it showed an error, the log says which request failed.
**Cited** `tools/adversarial/src/browser-run.ts` · `tools/adversarial/src/evidence.ts`

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

### D77 — A practice attempt's submission is not scored

Scoring marks the slots of a *form*, and `AttemptSubmitted` names one. A practice attempt has no form (M7-25), so submitting one records the submission and writes
no event: nothing reaches scoring, no score record exists for it, and Learning receives no evidence from it through the relay. This is deliberate and stated, not a
quiet skip — the alternative, an event scoring cannot act on, would dead-letter every practice submission. It means practice responses do not yet move mastery.

**Trigger** The track that feeds practice evidence to Learning: scoring needs a way to mark slots that carry no form (marks from the pinned rule set per item type), and
the event needs a form-free shape. Until then the response log holds the responses and nothing reads them for mastery.
**Cited** `apps/api/src/contexts/assessment/application/handlers/attempt-handlers.ts`

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

### D87 — A practice run's questions have no route, so the app starts a run it cannot show

A practice run is made and started by one tap (M7-58, DEC-M7-31) and exists on the server with its items chosen, each with an exposure row. No route gives a learner those
items: the attempt route returns a count of slots and not their identifiers, and the content a learner is shown comes only from a signed form package, which a practice run
(of no form) does not have. So the practice screen can show that the run has begun and how large it is, and says plainly that its questions cannot be shown; a learner cannot
answer them, and the `GetPracticeFeedback` route has nothing to be asked about. The roadmap's one tap reaches the run and stops there.

**Trigger** The route that serves a practice run's slots and their delivery content, which is a new surface on the key-free boundary and gets a `KEY-FREE.md` row of its own before it is built; the practice screen then becomes the sitting.
**Cited** `apps/learn/src/ui/PracticeScreen.tsx`

### D88 — The learner screens are told their exam profile and taxonomy by the address, and name a concept by its identifier

A practice run is made under an exam profile version, and "what is weakest" is asked about a taxonomy version; no route offers the learner either, and the attempt view does not name
the profile. The screens take both from the address (`?profile=`, `?taxonomy=`), as the sitting takes its form and session, and carry them from screen to screen. A page opened without a profile
says a run cannot be made from it instead of trying. No route offers the learner a concept's name, so a finding, a due concept and an escalation are named by the start of their identifier. Both are
the development wiring D69 describes, and neither can reach a student's phone as it is.

**Trigger** A route that gives a learner their exam profile and taxonomy version, and one that names concepts: the address parameters and the identifier labels are removed together.
**Cited** `apps/learn/src/ui/screen-context.ts`

## Closed

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
