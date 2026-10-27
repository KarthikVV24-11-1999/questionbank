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

### D67 — A tab reopened during an outage cannot resume the attempt

The attempt continues through an outage while the page stays open, and everything it holds is on the device. Reopen the tab while the backend is still
down and the app asks the server for the attempt (to take its deadline afresh, so a reload never restarts the clock) before it will carry on, and the
service worker has cached the package but not an attempt: it shows nothing. The answers are still in the device's record; the learner cannot get at them
until the backend is back. Resuming offline needs a deadline without the server, which means the device's wall clock as a stand-in, and that is a
design decision (the server re-validates at submission, so the stand-in can only be wrong in the learner's disfavour or be ignored by the server).

**Trigger** A decision on offline resume (a stored offset between the server's clock and the device's, taken at the last contact), or the first learner
reported stuck on a blank page during an outage.
**Cited** `apps/learn/src/bootstrap.ts`

### D68 — The learner app does not pull the server's log: a second device starts from nothing

The server holds every event it has acknowledged, and the app never reads them back. A device with no record of the attempt — a second device, or the same
one after its storage was cleared — creates the attempt (the server returns the existing one), starts it (likewise) and begins an empty log. What the learner
did before is not shown, and the new events are numbered from one again, which the server's ordering (client sequence, then id) interleaves with the old ones.
The device-switch dimension of the roadmap's adversarial criterion is blocked on real devices, and this is the part of it that does not need one.

**Trigger** The decision to support continuing an attempt on another device: the attempt route returns the log (or a projection and the last sequence),
and a session resumes from it.
**Cited** `apps/learn/src/bootstrap.ts`

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

### D72 — A re-score does not tell Learning which outcomes changed

`ExecuteRescoring` supersedes score records and writes one `AttemptsRescored` carrying the operation, a count, the trigger and the scope. It
names no attempt, and no `AttemptScored` is written for the successors. A consumer holding evidence assembled from generation 1 cannot learn
that an outcome was corrected. The seam reads the current generation, so a later read is right; what is missing is the announcement.

**Trigger** Learning's consumer of `AttemptScored` (the next track): either the successors announce themselves, or `AttemptsRescored` lists
the attempts it changed.
**Cited** `apps/api/src/contexts/scoring/application/handlers/rescoring-handlers.ts`


## Closed

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
