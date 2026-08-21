# M4 — Governance & Review Workspace · Task Breakdown
**Milestone:** [ROADMAP.md](../ROADMAP.md) M4 · **Duration:** ROADMAP says 4 weeks; **this breakdown says 5** — see [Sequencing](#sequencing) · **Depends on:** M3, M0
**Deployable:** full authoring → review → publish loop, internal users only, running locally against real Postgres
**Status:** Draft, second pass. **Sixteen decisions below; none may be implemented before ratification.**

> **45 tasks**, each independently testable. Paths follow [ENGINEERING-HANDBOOK.md](../ENGINEERING-HANDBOOK.md) §1–2.
> Tiers follow [ADR-0013](../adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md).

**Two things changed from the first pass, both after review, both recorded rather than quietly applied.**

**M4 creates no new context.** The first pass proposed `contexts/governance/` and a synchronous facade for
governance to drive content's lifecycle. Three of that facade's four methods were **writes**, and the decision
handler put two contexts in one transaction — a §9 rule 4 divergence *and* a §10 divergence, to be carried
through five milestones. [DEC-M4-7](#dec-m4-7--the-review-workspace-lives-inside-the-content-context--adr-0019)
resolves it by moving the boundary instead of documenting an exception: the review workspace lives inside
`contexts/content/`, under an enforced intra-context sub-boundary. This is not a divergence from
[ADR-0010](../adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) — that ADR's table names *M4 the
milestone*, never a fourth context. The fourth-context idea came from one non-normative sentence of
HANDOFF-M4's prose.

**`ItemDefect` and `AnswerKeyChallenge` move to M5** ([DEC-M4-6](#dec-m4-6--itemdefect-and-answerkeychallenge-move-to-m5--adr-0022)).
Neither appears in any of M4's five acceptance criteria, and M4's job is unblocking the content pipeline.
ROADMAP lists them under M4, so the divergence is recorded in **ADR-0022**, with a trigger — the same
discipline ADR-0010 applied to the lifecycle machine.

**What did not change, and will not be relitigated:** M3 owns the lifecycle machine and every publication
precondition (ADR-0010, ratified). **"A reviewer sustains ≥ 40 items/hour" is `Fail — blocked` on day one and
stays there** — the missing resource is three reviewers, not three weeks of software.
[DEC-M4-5](#dec-m4-5--the-40-itemshour-gate-is-fail--blocked-from-day-one-and-the-close-out-sentence-is-written-now)
fixes that report's wording here, so it cannot drift toward "basically met" as pieces land.

**The finding that sets the milestone's shape.** A subject-scoped, age-ordered queue needs three facts content
does not record:

| The queue needs | Content today |
|---|---|
| Which item versions are awaiting review | `ListMyDrafts` is author-scoped; no query lists submitted work |
| When each entered `in_review` | `content.item` has `created_at` only — no `state_entered_at` |
| Which subject each belongs to | The subject is **declared on the authoring command and never stored** (D23) |

Under the first pass these were cross-context amendments. Under DEC-M4-7 they are ordinary content work
(Track B) — which is most of why the estimate falls from six weeks to five.

---

## Scope boundary

**M4 owns** the `review/` area inside `contexts/content/` (`domain/review/`, `application/review/`,
`infrastructure/review/`, `api/review.controller.ts`), the audit hash chain in
`apps/api/src/platform/persistence/` and `platform.audit_*`, `apps/studio/src/features/review-workspace/`,
`packages/contracts/openapi/content.yaml`'s review paths, and the gates it adds. It **drives** the lifecycle
machine; it does not own it, adds no publication precondition, and never touches a marking rule.

**What M4 deliberately does not own:**

| Not in M4 | Owner | Why M4 can proceed without it |
|---|---|---|
| The lifecycle state machine and every publication precondition | **M3, settled** ([ADR-0010](../adr/ADR-0010-content-owns-the-lifecycle-state-machine.md)) | Ratified, exhaustively tested over 72 state/transition pairs. M4 produces decisions; it does not redesign the record. Not relitigated |
| **`ItemDefect` intake and triage** | **M5** (**ADR-0022**) | In no M4 acceptance criterion. Trigger: **the first published item a reviewer or author needs to report against** — which cannot happen before M4's loop puts published items in front of internal users, i.e. not during M4 |
| **`AnswerKeyChallenge` intake and adjudication** | **M5** (**ADR-0022**) | Same. Its remedy is blocked on **D25** regardless, so building the intake now would deliver a record with no resolution path. Trigger: **the first disputed key on a published item**, or M9's learner-facing challenge surface, whichever comes first |
| AI pre-checks, generation candidates, the 12-check battery | **M5** | §C.6's "pre-checks are blocking for AI content" is M5's rule. M4 ships the *ordering seam* its confidence signal slots into (DEC-M4-9) and nothing else |
| Re-scoring after an upheld challenge | **M2 (`RescoringOperation`) + M9** | Follows the challenge to M5/M9 |
| Revising a **published** item (D25) | **Content, on request** | `addVersion` refuses past draft. `approve_with_edits` does **not** need it (DEC-M4-3); a corrected published version does. **D25's trigger moves with the challenge, to M5** |
| Wiring the Item Editor to the API (D29), and the ≤ 20 min author gate | **The next Studio task** | Not M4's, and M4 does not pay for it. The gate stays `Fail — blocked on D29`, restated unchanged in M4's close-out |
| A scheduler, a cron, an outbox relay | **Deployment / a later platform task** | M4's sweep and anchor are **commands any scheduler calls**, driven directly in tests. The scheduled invocation is Tier 3 (DEC-M4-15). New debt **D35** — nothing consumes `platform.outbox_message` today |
| An external timestamping authority for the daily anchor | **Blocked** | No network, no account, no witness. The anchor is locally sealed and signed and says so (DEC-M4-4) |

---

## Decisions

Sixteen questions the approved document set does not answer. Six were named in the brief; ten surfaced while
reading the tree. Each carries one recommendation. **DEC-M4-6 and DEC-M4-7 are rewritten from the first
pass**; the other fourteen stand as accepted.

**Standing instruction attached to every M4 task.** M4's characteristic failure is the **criterion that drifts**
— a throughput gate that becomes "the software supports it", an advisory duplicate check that becomes
decorative, an "audit chain" that is a column nobody verifies. Every M4 claim names the thing it measured and
the thing it did not. Where a criterion cannot be met it is reported `Fail — blocked` with the missing
resource named. **Do not narrow a criterion until it passes.**

### DEC-M4-1 · Ageing, escalation, and the two different clocks

ROADMAP says "ageing escalation". [DECISIONS §C.6](../DECISIONS.md) says items ageing past threshold
auto-escalate to Content Ops (FR-ADM-05). Neither states a threshold, what escalation *does*, or whether it
reassigns.

**Recommended.** Two clocks, because they measure different failures and conflating them is why queues stall:

| Clock | Measures | Threshold (default) | Effect |
|---|---|---|---|
| **Queue age** = now − `stateEnteredAt` | An item nobody has picked up | `warn` 48 h · `escalate` 72 h | At `warn` the item sorts to the front of its subject pool. At `escalate` it is flagged, an `ItemReviewEscalated` event is emitted, and it appears on the Content Ops queue surface |
| **Claim age** = now − `claimedAt` | A reviewer who claimed and vanished | `lease` 4 h | The lease expires and the item returns to the pool automatically. This is not escalation |

**Escalation does not reassign.** It makes an item visible to Content Ops with a `ReassignReview` action a
human takes. Auto-reassignment to an unnamed pool is how items ping-pong between reviewers who each assume
the other is handling it; the content of FR-ADM-05 is *someone must look at this*, and "someone" has to be a
person. **Lease expiry does release automatically** — it is a lock timing out, not a judgement.

Thresholds are a `ReviewPolicy` value read through the typed config module (F16) with the defaults above.
Ageing is a **pure function of supplied instants** — no clock in the domain, per M3's rule.

**Escalation is computed on read, not by a background job.** The queue-health query derives `warn`/`escalate`
from `stateEnteredAt` and `now`, so the *state* is always correct with no scheduler at all. Only the *event*
needs a sweep, and the sweep is a command (M4-31) any scheduler can call. See DEC-M4-15.

### DEC-M4-2 · Duplicate detection — two hashes are authoritative, trigram is retrieval → **ADR-0021**

ROADMAP names three techniques as one deliverable: "normalized hash + trigram + placeholder-normalized
numbers". FR-QM-04 rule 2 makes the result **advisory, never blocking**. Nothing says which technique answers
which question, and "advisory" is one step from "ignored".

**Recommended — the three are not three detectors, they are two verdicts and one index:**

| Technique | Question it answers | Status |
|---|---|---|
| **Exact normalized hash** — SHA-256 over the `plainText` projection after NFKC, case-fold, whitespace collapse, punctuation strip | "Is this the same item, retyped?" | **Authoritative.** Zero false positives by construction |
| **Skeleton hash** — the same normalization, then every numeric literal → `⟨n⟩`, every unit token → `⟨u⟩`, and **MCQ options sorted by their own normalized text** before hashing | "Is this the same question with different constants?" | **Authoritative.** The technique ROADMAP's acceptance criterion actually names |
| **Trigram similarity** over the normalized text | "What else is nearby?" | **Retrieval and ranking only. Never a verdict** |

**"Same question, different constants" is defined as: identical skeleton hash.** Option re-ordering is
normalized away, because re-ordering options is the cheapest possible disguise and a detector that misses it
is theatre.

**Trigram is scored in-repo, not in the database.** A pure `trigramSimilarity(a, b)` (M4-10) is deterministic
and testable at Tier 1. Postgres `pg_trgm` supplies a **GIN index for candidate narrowing only**; if the
extension is unavailable the fallback is a full scan of the subject's fingerprint set — slower, identically
correct, documented. A detector whose answer depends on whether an index exists is one nobody can reason about.

**Four things keep "advisory" from meaning "decorative":**

1. Candidates are **on the review screen with no click** (UX §10.2) — rendered with the incoming item, not behind a disclosure.
2. The `DUPLICATE` rejection reason **requires a `duplicateOfItemId`**; the domain refuses the reason without one.
3. Every decision records the candidate ids it was **shown**, so "the reviewer never saw it" is answerable after the fact.
4. **A Tier-1 gate**: the seeded corpus (M4-43) contains a planted constants-swapped pair, and the suite fails if the skeleton hash does not pair them. That is ROADMAP's fifth acceptance criterion, proven.

**No publication precondition changes.** M3 owns those; M4 adds none. Recorded in **ADR-0021**, because
reading one ROADMAP deliverable as "two verdicts and an index" is a divergence in substance even though all
three named techniques are used.

### DEC-M4-3 · Approve-with-edits: the reviewer edits, the author stays the author → **ADR-0018**

The obvious answer is wrong, and it is worth restating why. M3's `checkPublishable` refuses when
`signature.reviewer === version.authoredBy` (INV-12). If `approve_with_edits` produced **a new `ItemVersion`
authored by the reviewer**, that version could never be published by the reviewer who wrote it — the feature
would defeat itself at the last step.

**Recommended.**

1. **The edit produces a new version** — `deriveDraft(from)`, never a mutation of the author's snapshot. INV-03 and the audit chain both forbid amending a version in place, and attributing a reviewer's words to the author would be a provenance lie in the other direction.
2. **`authoredBy` stays the original author.** The reviewer's contribution is recorded as a new, distinct `editedBy: PrincipalRef` on the version and in the audit chain. `authoredBy` answers *whose subject-matter work is this* — INV-12's actual question — and a reviewer must not become an author by fixing a typo.
3. **The edit scope is closed and enforced.** Under `approve_with_edits` a reviewer may change: stem prose, solution prose, `textAlternative` strings, taxonomy tags, difficulty estimate. Never: the `responseSpec` (the key), `itemType`, or `provenance`. An edit touching any of those is not approve-with-edits — it is `request_changes`, and the domain says so with a named code. This bound is the whole difference between "approve with edits" and "the reviewer wrote the item and approved it".
4. **No second reviewer is required.** Requiring one halves throughput for the commonest case, and the edit-scope bound is what makes it unnecessary.

**D25 is not on this path.** `approve_with_edits` operates on an item in `in_review` whose version is still
pre-publication, which `addVersion` permits today. D25 blocks **correcting an item that has already
published** — which is what an upheld answer-key challenge needs, and that is now **M5's** (DEC-M4-6). So the
`editedBy` field and the edit-scope check are content work M4 does (M4-15, ADR-0018); **revising a published
item stays D25, open, with its trigger travelling to M5 alongside the challenge.**

### DEC-M4-4 · The audit chain lives in platform, is enforced by the database, and its anchor is signed, not notarized → **ADR-0020**

`platform.audit_record` already exists (M0-07): one table, three contexts, append-only by trigger, no
`UPDATE`/`DELETE`/`TRUNCATE` grant for `questionbank_app`. It has no chain. F41 is registered in
[SECURITY-ARCHITECTURE](../SECURITY-ARCHITECTURE.md) as *"audit hash chain verifies over the last 24 hours"*
and has never been built.

**Where.** In `platform.audit_record` itself. A chain covering only review records would leave *publication*
records unchained, and publication is the event the chain exists to protect.

**What is chained.** Three new columns — `chain_seq bigint`, `prev_hash bytea`, `record_hash bytea` — where
`record_hash = sha256(canonical(row) ‖ prev_hash)` and `canonical(row)` is a deterministic serialization of
the record's semantic columns (never `chain_seq`, never a default).

> **Correction, 2026-08-20 (M4-23).** Two details of the sentence above were wrong or ambiguous and are
> superseded by [ADR-0020](../adr/ADR-0020-the-audit-chain-is-database-enforced-and-locally-anchored.md),
> which states both normatively. Original text kept above rather than rewritten.
>
> 1. **The concatenation order contradicted M4-22.** This line says `sha256(canonical ‖ prev_hash)`;
>    M4-22's acceptance criterion says `SHA-256 over prevHash ‖ canonical`. **M4-22's order governs**:
>    `record_hash = SHA-256(prev_hash ‖ canonical(row))`, fixed-length predecessor first so the boundary
>    between the two inputs is unambiguous. Both are sound; what mattered was fixing one, since the SQL and
>    TypeScript implementations are asserted byte-identical.
> 2. **"never a default" was ambiguous about the primary key.** `audit_record_id` is a defaulted column but
>    is **included** in the canonical form. The rule is mechanical: the canonical form is every column of
>    `platform.audit_record` except the three the trigger itself sets — `chain_seq`, `prev_hash`,
>    `record_hash` — because chaining over a value the trigger is computing is circular. Postgres applies
>    column defaults before `BEFORE INSERT` triggers, so `NEW.audit_record_id` is populated and reproducible
>    on both sides, and including it means the chain binds record identity rather than content alone.

**How.** A `BEFORE INSERT` trigger taking `pg_advisory_xact_lock`, reading the head and computing the link
**in the database**. Not in the application: a chain the application computes is bypassed by any other
writer, and "any other writer" is the adversary. Concurrency is proven with overlapping transactions.

**What "anchor" means with no timestamping service.** One `platform.audit_anchor` row per UTC day carrying
`{ day, first_seq, last_seq, head_hash, record_count, sealed_at, signature }`, signed with **HMAC-SHA256
under a dedicated `auditAnchorKey`** — *not* `authSigningKey`, because one key compromised should not forge
both sessions and history. The same seal is emitted to `platform.outbox_message` as `AuditAnchorSealed`, so
publishing to an external witness later is a consumer, not a migration.

**And the limit is stated in the ADR, not implied.** A key held on the machine that holds the database bounds
the attacker to *someone with both database write and process configuration* rather than *someone with
database write*. That is a real reduction and it is **not notarization**. External witnessing is **Tier 3,
`Fail — blocked`**; successor named: publish `head_hash` to a third-party timestamping authority or a
second-party witness, neither of which exists here.

### DEC-M4-5 · The 40 items/hour gate is `Fail — blocked` from day one, and the close-out sentence is written now

There will be no three real reviewers.

**Recommended — the status is `Fail — blocked` at every checkpoint, and no amount of software changes it.**
The missing resource is named as *a reviewer pool*, exactly as M0 named *a container runtime* for F8. The
close-out line is fixed here, verbatim, and M4-45 asserts the close-out contains it:

> **"≥ 40 items/hour sustained by a reviewer — `Fail — blocked`: no reviewer pool exists. Nothing in M4
> measures human throughput. The interaction-cost and latency figures below are evidence that the workspace
> does not itself prevent the rate; they are not a measurement of it."**

**The nearest honest evidence is three Tier-1 measurements, each of which measures the software and says so:**

| Evidence | Instrument | Assertion |
|---|---|---|
| **Interaction cost** | jsdom, seeded 20-item queue | ≤ 1 keystroke per decision on the approve path; **0** clicks to reveal anything UX §10.2 names; **0** navigations |
| **Machine time per decision** | Real Postgres, seeded 500-item queue | p95 of `claim → render payload → decide` ≤ 300 ms — two orders of magnitude inside the 90 s/item the gate implies |
| **Queue continuity** | Component + integration | Auto-advance serves the next item from a prefetch; the reviewer never waits on a request between decisions |

**And the instrument that would measure the real thing is built and proven with no subject** — M0-25's
pattern, in the same words. `review_decision.decided_at` already exists, so per-reviewer items/hour is a
query (M4-33). M4-44 proves it against **synthetic** decision timestamps and reports it as
**`Instrument proven / no subject`**, never as a throughput result. The timed-session protocol — 3 reviewers,
the 200-item seeded corpus, 60 minutes, the exact query — is authored as a **Tier-2** artifact
(`docs/tasks/M4-REVIEW-TIMING-PROTOCOL.md`) whose every named command and query is asserted to exist.

**What this forbids, explicitly:** reporting the gate as "met in principle", "met modulo staffing", "the
workspace sustains 40 items/hour", or as a percentage. The three measurements are reported under their own
names, never under the gate's.

### DEC-M4-6 · `ItemDefect` and `AnswerKeyChallenge` move to M5 → **ADR-0022**

*(Rewritten this pass. The first pass modeled both inside M4.)*

ROADMAP lists "`ItemDefect` intake and triage" as an M4 deliverable, and M3's scope table assigns
`AnswerKeyChallenge` to M4 as well. **Neither appears in any of M4's five acceptance criteria**, and M4's
stated goal is unblocking the content workstream — the true critical path.

**Recommended: defer both to M5, with triggers, and record the divergence in ADR-0022.**

Three reasons, in order of weight:

1. **Nothing in M4 needs them.** The five criteria are throughput, self-review, the reviewer signature, audit-chain tamper detection, and duplicate detection. A reviewer rejecting a draft uses the **rejection taxonomy** (DEC-M4-11), not a defect record. Defects are about **published** items.
2. **`AnswerKeyChallenge`'s remedy is blocked regardless.** An upheld challenge needs a corrected published version, which **D25** forbids. Building the intake in M4 would ship a record whose only resolution is `suspend` — a loop that does not close, delivered under the impression that it does.
3. **M4 produces the precondition for both.** Neither can be exercised against real content until M4's loop has published something internally. Building the intake before the thing it takes intake *of* is the vacuous-green pattern under a different name.

**Triggers, stated so the deferral is not open-ended** (ADR-0011's discipline): `ItemDefect` — *the first
published item a reviewer or author needs to report against*; `AnswerKeyChallenge` — *the first disputed key
on a published item, or M9's learner-facing challenge surface, whichever comes first.* **D25's trigger moves
with the challenge.**

**ADR-0022** records the divergence from ROADMAP's M4 deliverable list, exactly as ADR-0010 recorded the
lifecycle machine's. A task breakdown that silently drops an approved deliverable is how the next reader
learns the roadmap is unreliable. **The ROADMAP edit follows the ADR** (with **D20**, at M4-45).

*Considered and rejected:* keeping a stub `ItemDefect` "so the shape exists". A modeled aggregate no command
writes and no surface reads is half-shipped work that rots — M3-16 got away with `LocaleVariant` only by
asserting that nothing accepts one, and that assertion is the whole reason it was defensible.

### DEC-M4-7 · The review workspace lives inside the content context → **ADR-0019**

*(Rewritten this pass. The first pass proposed `contexts/governance/` plus a synchronous facade.)*

**The first pass's own design refutes it.** The facade it proposed had four methods, and three were writes:
`recordItemReviewDecision`, `deriveReviewerEditedVersion`, `publishItemVersion`. Only
`getItemVersionForReview` and `listSubmittedForReview` were reads. So §9 rule 4 — *cross-context effects are
events, never calls* — was genuinely engaged, and the decision handler additionally put **two contexts in one
transaction**, which §10 forbids independently.

**Events cannot substitute, and this is the paragraph that decides it.** A reviewer presses `a` and
auto-advances. Content's publication precondition then refuses — unresolved licensing, no published solution,
a failed render verdict — and the refusal arrives asynchronously to a reviewer who is forty items downstream;
on a single-screen auto-advancing workspace there is nowhere for it to land, and **no relay to carry it**
(D35). Meanwhile the assignment has closed optimistically, so a decision whose content half failed leaves the
item neither claimed nor decided: it falls out of the queue until the lease expires, and is then re-reviewed
by someone who cannot tell it was already approved. Worse, INV-12 at decision is evaluated against
`authoredBy`/`editedBy`; replicated copies of those facts make self-review probabilistic, and "every
published item carries a reviewer signature" degrades to "eventually carries one". Atomicity here is an
invariant, not a preference.

**So the boundary moves, rather than the rule bending. Recommended: no fourth context.** The review
workspace's write path lands inside `contexts/content/`:

| Lands in `contexts/content/` | Why |
|---|---|
| `ReviewAssignment`, the queue, claim/lease/release | A claim is a fact about a content item, and it must close atomically with the decision |
| Decision capture — reason code, duplicate citation, candidates shown | Extends `content.review_decision`, which M3 already owns (M3-28) |
| Approve-with-edits | Derives an `ItemVersion`; it was never anything else |
| Fingerprints and duplicate candidates | Derived from content's own `plainText` projection |
| Ageing, escalation, QC sampling, queue health, throughput | All read or derive content's own rows |

**ADR-0010 is honoured, not amended.** Its table is headed `M3 (contexts/content/domain/) | M4` — M3's column
names a directory, **M4's names a milestone**. ADR-0010 assigned M4 the *work*, never a separate context. The
fourth-context idea came from one non-normative sentence in HANDOFF-M4's "what M4 inherits" prose, and this
decision retires it.

**Four things get simpler, and one gets harder.** Simpler: no facade, no adapters, one transaction;
**one** self-review function with two call sites instead of two implementations of INV-12 in two contexts;
the queue uses content's own `authorizeSubjectScope` rather than a copy; and **`ReviewProgress` dissolves** —
M3 declared that port *because* it assumed assignment lived elsewhere, so **W4 closes by deleting the port**,
not by supplying an adapter (M4-30, with ADR-0015 amended in place).

Harder: content becomes the largest context by a distance. **The mitigation is a real, enforced sub-boundary**
— `content/*/review/` and `content/*/authoring/` may not reach into each other's internals; they meet only at
the domain aggregates and the shared authorization module, asserted by a gate (M4-01, M4-42) and proven
against a planted violation. That keeps extraction open: if M5's generation intake ever makes a separate
context earn its keep, the seam already exists.

**ADR-0019** records the placement, the reads/writes analysis, why events cannot serve, and the sub-boundary
that replaces the context boundary.

*Considered and rejected:* two HTTP calls from the workspace, one to each context. No atomicity at all — the
queue and the audit chain would diverge silently, which is strictly worse than either alternative.

### DEC-M4-8 · Subject-scoped routing has no source, and D23 is the reason

ROADMAP requires the queue be subject-scoped. `authorizeSubjectScope` takes the subject **from the command**
and content stores it nowhere; `curriculum/public/` exposes no concept → subject lookup (**D23**); the Item
Browser's own subject filter has no source (**D33**).

**Recommended: persist the subject content already collects.** `content.item.authoring_subject`, written from
the authoring command that declares it today, exposed on the authoring view and filterable on the queue query
(M4-14, M4-16). Additive, and it turns a value that is currently validated-and-discarded into one that routes.

**The limitation is restated, not buried:** an author who declares the wrong subject routes their item to the
wrong reviewer pool, and nothing detects it. That is D23 unchanged, with its trigger unchanged (Curriculum
exposing a concept → subject lookup). *Rejected:* a second subject map maintained by the review area, which
would be a second source of truth for a fact content already has.

### DEC-M4-9 · Pull with a lease, not push — and what "confidence-ordered" means before M5

ROADMAP says "queue"; UX §10.2 says auto-advance, batched by concept, confidence-ordered. Nobody says whether
a reviewer is *assigned* items or *claims* them.

**Recommended: pull with a lease, plus push for escalation only.**

- `ClaimNextForReview(subject)` claims atomically — `SELECT … FOR UPDATE SKIP LOCKED` over the candidate set — and writes an assignment with a lease. Two concurrent claims can never return the same item, proven with overlapping transactions.
- Ordering, in this precedence: **escalated first** → **same concept as the reviewer's previous decision** (batching) → **confidence descending** → **oldest first**.
- `AssignReview(itemId, reviewerId)` is Content Ops' push path, used when handling an escalation. Both write the same record.
- **Self-review is excluded in the claim predicate itself and re-checked in the domain** after selection (INV-12, first half). Two checks, because a predicate is one refactor away from being dropped — and under DEC-M4-7 both call the **same function** the publication precondition uses.

**"Confidence" before M5 is the M3 validation warning count plus the duplicate-candidate count** — a real,
already-computed signal that puts clean items first and builds the rhythm UX §10.2 asks for. M5's AI
pre-check confidence becomes an additional term in the *same* ordering function. Saying so now is what stops
"confidence-ordered" from silently meaning nothing for a milestone.

### DEC-M4-10 · The undo window is a commit delay, not a compensating record

UX §10.2 requires an undo window on every decision. `content.review_decision` is append-only by construction
with no mutator, and M3's transition table has no reverse edge from `approved` back to `in_review`.

**Recommended: a 5-second client-side commit delay.** The decision is held in the workspace with a visible,
counting-down undo affordance; nothing reaches the server until it elapses or the reviewer decides again.

*Rejected:* writing immediately and compensating. That needs a retraction record, a reverse transition in a
state machine M3 owns and exhaustively tested, and it makes `review_decision` a log in which some rows are
lies. A retracted decision was never a decision.

**The cost is stated:** a reviewer who closes the tab inside the 5 seconds loses that decision. The item stays
claimed until its lease expires and returns to the pool. That is recoverable by re-deciding; the alternative
is not recoverable by anything.

### DEC-M4-11 · The rejection taxonomy, enumerated

UX §10.2 requires a "fixed rejection taxonomy, chosen by key, never typed". Nobody has written the list.

**Recommended — closed, `as const`, each with a single key and a declared eligibility:**

| Key | Code | Eligible outcomes |
|---|---|---|
| `f` | `FACTUALLY_INCORRECT` | reject, request_changes |
| `k` | `KEY_WRONG` | reject, request_changes |
| `a` | `AMBIGUOUS_STEM` | request_changes |
| `d` | `DUPLICATE` | reject **only, and requires `duplicateOfItemId`** |
| `s` | `OUT_OF_SYLLABUS` | reject |
| `n` | `NOTATION_BROKEN` | request_changes |
| `x` | `SOLUTION_INADEQUATE` | request_changes |
| `c` | `DIFFICULTY_MISCALIBRATED` | request_changes |
| `l` | `LICENSING_UNRESOLVED` | request_changes |
| `y` | `ACCESSIBILITY_DEFECT` | request_changes |

The free-text justification M3 already **requires** on every non-approving outcome stays required and
additional — the taxonomy is for aggregation, the justification is for the author.

**Under DEC-M4-7 the reason is a column on `content.review_decision`**, not a row in another schema. The first
pass put it in a separate context keyed by value; co-location removes that indirection entirely. Adding the
columns is an additive migration on a table whose append-only property is unchanged (M4-17).

### DEC-M4-12 · The review routes live under `/v1/authoring/review/**`

**A review screen shows the answer key.** [ADR-0009](../adr/ADR-0009-authoring-dtos-carry-the-answer-key.md)'s
first ratified condition is that the key-bearing route list is **enumerated and closed**, and it enumerates
`/v1/authoring/**`. A new `/v1/review/**` prefix carrying keys would sit outside that list and fail F6/F35 in
its *absent-everywhere-else* direction — correctly.

**Recommended: mount M4's routes under `/v1/authoring/review/**`.** The existing enumerated prefix covers
them, the both-directions check keeps working unchanged, and ADR-0009 needs no amendment. Under DEC-M4-7 this
is also the natural home: they are content's authoring surface. *Alternative:* extend the enumerated
constant, which condition 1 explicitly permits as a reviewed diff — held in reserve.

**The review surface renders through `packages/content-renderer/` at the mobile profile by default** — the
same renderer (F20), the same default as the authoring preview (FR-QM-14 rule 3). A reviewer approving a
desktop rendering of an item students read on a 360 px screen is approving something else.

### DEC-M4-13 · Queue health is M4's; reviewer ranking is forbidden

§C.6 requires queue depth and ageing tracked continuously (FR-RPT-03); UX §11 specifies "depth, ageing,
per-reviewer throughput — capacity planning, never individual ranking". ROADMAP's M4 deliverables name no
reporting surface, but escalation is meaningless without one.

**Recommended:** one Content Ops surface — depth by subject, an age histogram, the escalated list, and
aggregate throughput for capacity planning. Per-reviewer figures exist in the query (the same instrument
DEC-M4-5 needs) but the surface **renders no ranking and no leaderboard**, asserted by a component test: no
sort control keyed on reviewer productivity, no per-reviewer ordering in the default render. UX's ban on
gamification is worth a test, because the feature that violates it is one `ORDER BY` away.

### DEC-M4-14 · QC sampling is deterministic, after the fact, and never blocks

§C.6 requires 5% of approvals sampled by a second reviewer. Nobody says whether M4 builds it or whether a
sampled approval waits.

**Recommended:** M4 builds the sampling and the second-review assignment. Selection is **deterministic** —
`sha256(decisionId)` into a 5% bucket — so it is reproducible, needs no clock and no randomness in the domain,
and a disputed sample can be re-derived years later.

**A sampled approval publishes immediately.** The sample is a measurement taken after the fact; blocking on it
would put a second reviewer on the critical path of one approval in twenty and destroy the throughput the
milestone exists to produce. Divergence is **recorded and reported**; "sustained divergence triggers
re-qualification" is a human process, and M4 ships the evidence, not the enforcement.

### DEC-M4-15 · Nothing in M4 is scheduled, and the schedule is Tier 3

The ageing sweep, the sampler and the daily anchor all imply something on a timer. There is no scheduler, no
cron, no relay, no CI and no deployed environment.

**Recommended:** each is a **command with a handler**, driven directly by tests at Tier 1 and callable by any
scheduler. Ageing *state* needs no schedule at all (DEC-M4-1). The **scheduled invocation** — the sweep hourly
and the anchor daily, in a deployed environment — is **Tier 3, `Fail — blocked`**: no scheduler, no
deployment. Successor named verbatim in each task. New debt **D36**.

This is ADR-0013 applied to a process rather than a file, and it is the second time this repository has needed
that reading.

### DEC-M4-16 · No M4 gate may be satisfied by weakening an existing one

Not an open question — a constraint, with four tripwires visible from here.

1. **The `review/` area lands inside content**, which means F1, F2 and the boundary checker see new directories inside an existing context. `content/domain/review/` still imports nothing, and the **new intra-context sub-boundary gate** (M4-01) must be added to the scan, never used to justify relaxing F1.
2. **Adding three columns to `platform.audit_record`** must not relax its append-only trigger or its grant revocation. The chain columns are `NOT NULL` and set by the trigger; the app role gains no `UPDATE`.
3. **The review routes carrying keys** must not be handled by widening F6/F35. DEC-M4-12 exists so the enumeration does not move.
4. **Deleting the `ReviewProgress` port** (M4-30) must not delete the *rule* it enforced. Withdrawal after review has begun stays refused; the M3 test that asserts it is **rewritten to read the real assignment table, never removed** — M0's convention 2.

---

## Task Index

| ID | Task | Track | Tier | Depends on |
|---|---|---|---|---|
| M4-01 | Review area skeleton & the intra-context sub-boundary (DEC-M4-7) | A · domain | 1 | — |
| M4-02 | `ReviewAssignment` — claim, lease, states | A · domain | 1 | 01 |
| M4-03 | Queue ordering (DEC-M4-9) | A · domain | 1 | 02 |
| M4-04 | Self-review — one function, two call sites (INV-12) | A · domain | 1 | 02 |
| M4-05 | Ageing, escalation & the stale-claim rule (DEC-M4-1) | A · domain | 1 | 02 |
| M4-06 | The rejection taxonomy (DEC-M4-11) | A · domain | 1 | 01 |
| M4-07 | `ReviewDecision` extended — reason, citation, candidates shown | A · domain | 1 | 06 |
| M4-08 | The approve-with-edits edit scope (DEC-M4-3) | A · domain | 1 | 07 |
| M4-09 | Fingerprints — the two authoritative hashes (DEC-M4-2) | A · domain | 1 | 01 |
| M4-10 | Trigram similarity — advisory ranking | A · domain | 1 | 09 |
| M4-11 | QC sampling — deterministic 5% (DEC-M4-14) | A · domain | 1 | 07 |
| M4-12 | Review domain events | A · domain | 1 | 02, 07 |
| M4-13 | `stateEnteredAt` on `Item` and the authoring view | B · content | 1 | — |
| M4-14 | `authoringSubject` persisted (DEC-M4-8) | B · content | 1 | — |
| M4-15 | `editedBy` & the bounded reviewer edit — **ADR-0018** | B · content | 1 | 08 |
| M4-16 | `ListSubmittedForReview` — the queue's candidate source | B · content | 1 | 13, 14 |
| M4-17 | Review schema migration | B · content | 1 | — |
| M4-18 | `ReviewAssignment` repository — the atomic claim | B · content | 1 | 02, 17 |
| M4-19 | `review_decision` repository extended | B · content | 1 | 07, 17 |
| M4-20 | Fingerprint store & the trigram retrieval index | B · content | 1 | 09, 17 |
| M4-21 | Review-table immutability & grants (F7/F40) | B · content | 1 | 17 |
| M4-22 | ⚠ platform: the audit link — canonical serialization & hash | C · platform | 1 | — |
| M4-23 | ⚠ platform: the chain — columns, trigger, backfill — **ADR-0020** | C · platform | 1 | 22 |
| M4-24 | ⚠ platform: the daily anchor, sealed and signed | C · platform | 1 | 23 |
| M4-25 | Chain verification & tamper detection (**F41**) | C · platform | 1 | 23, 24 |
| M4-26 | `ReviewPolicy` configuration & the review authorization policies | D · app | 1 | 05 |
| M4-27 | Claim, release, reassign — commands & handlers | D · app | 1 | 03, 04, 18, 26 |
| M4-28 | `RecordReviewDecision` extended — one handler, one transaction | D · app | 1 | 07, 19, 27 |
| M4-29 | Approve-with-edits handler | D · app | 1 | 08, 15, 28 |
| M4-30 | `ReviewProgress` retired — **W4 closed**, ADR-0015 amended | D · app | 1 | 18 |
| M4-31 | The ageing sweep & escalation handler (DEC-M4-15) | D · app | 1 | 05, 18 |
| M4-32 | Duplicate candidates — refresh & query | D · app | 1 | 10, 20 |
| M4-33 | Queue health, ageing & throughput queries (DEC-M4-13) | D · app | 1 | 18, 19 |
| M4-34 | `SealDailyAuditAnchor` handler | D · app | 1 | 24 |
| M4-35 | Barrel, composition & the M5 seam spec | D · app | 1 | 26–34 |
| M4-36 | OpenAPI under `/v1/authoring/review/**` (DEC-M4-12) | E · api | 1 | 35 |
| M4-37 | Review controllers | E · api | 1 | 36 |
| M4-38 | Review workspace — one screen, keyboard, auto-advance | F · studio | 1 | 37 |
| M4-39 | Decision bar, taxonomy by key, undo window (DEC-M4-10) | F · studio | 1 | 38 |
| M4-40 | Duplicate panel & edit-in-place | F · studio | 1 | 38 |
| M4-41 | Content Ops queue management surface | F · studio | 1 | 33, 37 |
| M4-42 | The M4 gate module, planted fixtures & thresholds | G · gates | 1 | 21, 25, 35, 41 |
| M4-43 | The seeded review corpus — 200 items, planted pairs | G · gates | 1 | 20, 28 |
| M4-44 | The throughput instrument & the timing protocol (DEC-M4-5) | G · gates | **1 / 2 / 3** | 33, 38, 43 |
| M4-45 | Traceability, ADRs, close-out & handoff | G · gates | 1 | all |

---

## Track A — The review domain

*`apps/api/src/contexts/content/domain/review/`. Pure logic: no I/O, no framework, no ORM, no clock, no
randomness. `domain/` imports nothing (F2). Every task returns a typed `Result` and never throws (§8). Tasks
02, 04, 05, 07, 08, 09 and 11 are correctness-bearing under
[ADR-0008](../adr/ADR-0008-coverage-follows-correctness-bearing-code.md) and carry a 100% threshold the moment
they land.*

### M4-01 · Review area skeleton & the intra-context sub-boundary (DEC-M4-7)
**Objective** The seam that replaces the context boundary. Co-location must not become entanglement.
**Files** `contexts/content/domain/review/index.ts`, `apps/api/src/fitness/content-rules.ts` (extended), `content-rules.spec.ts`
**Acceptance**
- `review/` sub-directories created under `domain/`, `application/`, `infrastructure/`; `api/review.controller.ts`
- **The sub-boundary rule, as a gate:** `review/` may import content's domain aggregates, value objects and `application/authorization.ts`, and **nothing else** from `authoring/`; `authoring/` may import **nothing** from `review/`. Both directions asserted
- Review modules reuse content's existing `Result` and `ContentError` — no parallel taxonomy, which was the first thing a separate context would have forced
- **The extraction path is documented in the module header**: what would have to be true for `review/` to become its own context, so a future reader inherits the reasoning rather than the outcome
**Tests** Unit: the sub-boundary check green on the real tree and **red on a planted violation in each direction** · a planted `authoring/` import of `review/` caught · zero `throw`, zero clock read under `domain/review/`, each proven against a planted violation

### M4-02 · `ReviewAssignment` — claim, lease, states
**Objective** The record the queue is made of.
**Files** `domain/review/review-assignment.ts`
**Acceptance**
- `{ assignmentId, itemId, itemVersionId, subject, reviewer, kind: 'claimed' | 'assigned' | 'second_review', state, claimedAt, leaseExpiresAt, releasedAt?, decidedAt? }`
- States: `claimed → (decided | released | expired)`. **Every transition the table does not name is refused**, with the attempted transition in the message; an exhaustive matrix walks all pairs
- `leaseExpiresAt` is **supplied**, computed by the caller from `claimedAt` and the policy — no clock in the domain
- **At most one live assignment per item version** — a second claim while one is live is `Conflict`; the domain half of what M4-18's SQL enforces
- `isExpired(assignment, now)` is a pure function of a supplied instant
- Immutable; a state change returns a new instance
**Tests** Unit: construction · exhaustive transition matrix · expiry exactly at, before and after `leaseExpiresAt` · second live claim refused · deep immutability · 100% branch

### M4-03 · Queue ordering (DEC-M4-9)
**Objective** UX §10.2's "batched by concept, confidence-ordered", as one pure, total ordering.
**Files** `domain/review/queue-ordering.ts`
**Acceptance**
- `orderCandidates(candidates, context)` — precedence: **escalated** → **same primary concept as `context.lastDecidedConcept`** → **confidence descending** → **`stateEnteredAt` ascending** → `itemVersionId` ascending as the final tiebreak
- **Total and deterministic** — two runs over the same input are byte-identical and no pair is ever ambiguous, asserted over a shuffled fixture across 100 runs
- **`confidence` is a declared input, not a computed one**: today the caller supplies `blockingCount`/`warningCount`/`duplicateCandidateCount` from M3's validation report. The module documents that M5's pre-check confidence becomes an additional term **in this function**, not a second ordering
- No clock; `now` is supplied for the escalation term
**Tests** Unit: each precedence level in isolation · a shuffled corpus orders identically across 100 runs · concept batching keeps same-concept runs contiguous · total order asserted (no two candidates compare equal) · 100% branch

### M4-04 · Self-review — one function, two call sites (INV-12)
**Objective** FR-QM-03 and INV-12, checked at assignment and at decision — and under DEC-M4-7, by **the same function** the publication precondition already uses.
**Files** `domain/review/self-review.ts`, `domain/publication-preconditions.ts` (call site)
**Acceptance**
- `isSelfReview(version, principal)` — true when the principal is the version's `authoredBy` **or** its `editedBy` (M4-15): a reviewer who edited a version is no more independent of it than its author
- `assertAssignable(candidate, reviewer)` returns `RuleViolation` with code `SELF_REVIEW_PROHIBITED`
- **M3's publication precondition is refactored to call this function** rather than comparing principals inline — one rule, one implementation. The existing precondition tests pass unchanged, which is the proof the refactor changed no behaviour
- **Three call sites are enumerated and asserted** — the claim predicate (M4-18), the decision handler (M4-28), the publication precondition — so removing one is a test failure
- Content Ops is **not** exempt; oversight is not independence
**Tests** Unit: author refused · editor refused · unrelated reviewer permitted · Content Ops refused · call-site enumeration, red when one is removed · **the whole M3 publication-precondition suite green unchanged** · 100% branch

### M4-05 · Ageing, escalation & the stale-claim rule (DEC-M4-1)
**Objective** FR-ADM-05 and §C.6's ageing, as pure arithmetic over supplied instants.
**Files** `domain/review/ageing.ts`, `domain/review/review-policy.ts`
**Acceptance**
- `ReviewPolicy { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 }` — validated, each field bounded, `sampleRate` in `[0, 1]`
- `ageState(stateEnteredAt, now, policy)` → `fresh | warn | escalated`; boundaries **inclusive at the threshold**, asserted at exactly 48 h and exactly 72 h
- `leaseState(claimedAt, now, policy)` → `live | expired`
- **Escalation targets Content Ops and does not reassign** — `escalationTarget()` returns a role, and a spec asserts no function here returns a principal
- Pure and total; a `now` earlier than the input instant is `Validation`, never a negative age
**Tests** Unit: each state at, either side of, and far from each threshold · policy validation per field · lease boundaries · escalation returns a role and never a principal · clock-free asserted · 100% branch

### M4-06 · The rejection taxonomy (DEC-M4-11)
**Objective** "Chosen by key, never typed", as a closed vocabulary the UI and the aggregation share.
**Files** `domain/review/rejection-taxonomy.ts`
**Acceptance**
- `REJECTION_REASONS` closed `as const`, exactly DEC-M4-11's ten entries, each `{ code, key, eligibleOutcomes }`
- **Every `key` is unique**, asserted — two reasons on one keystroke is a decision the reviewer did not make
- `assertReasonPermitted(code, outcome)` refuses a reason whose `eligibleOutcomes` excludes the outcome, with a stable code
- **`DUPLICATE` requires a `duplicateOfItemId`** and is `reject`-only; the check lives here
- An unknown code is rejected, never coerced
**Tests** Unit: every code constructs · key uniqueness by set equality · each ineligible (code, outcome) pair refused · `DUPLICATE` without a target refused, with one accepted · unknown code refused · 100% branch

### M4-07 · `ReviewDecision` extended — reason, citation, candidates shown
**Objective** The governance fields, added to the record M3 already owns — not a parallel record beside it.
**Files** `domain/review-decision.ts` (extended), `domain/review/decision-evidence.ts`
**Acceptance**
- `ReviewDecision` gains `reasonCode?`, `duplicateOfItemId?`, `candidatesShownIds: readonly string[]`
- **`REVIEW_OUTCOMES` is not touched** — M3's vocabulary and `toReviewerSignature` are unchanged, and their existing tests pass unaltered
- A non-approving outcome **requires** a `reasonCode` (M4-06) in addition to the justification M3 already requires
- **`candidatesShownIds` is required and may be empty** — an empty array means "none found", a missing field means "the check did not run", and the two are never the same value (the distinction `describeDuplicateCheck` already makes)
- **INV-12 checked here** via M4-04 against the version's `authoredBy`/`editedBy`, supplied as facts
- Still append-only by construction: no mutator is added
**Tests** Unit: construction per outcome · missing reason on each non-approving outcome refused · self-review refused at decision · empty vs absent candidate list distinguished · **M3's `review-decision.spec.ts` green unchanged** · 100% branch

### M4-08 · The approve-with-edits edit scope (DEC-M4-3)
**Objective** The bound that separates "approve with edits" from "the reviewer wrote it".
**Files** `domain/review/edit-scope.ts`
**Acceptance**
- `EDITABLE_UNDER_REVIEW` closed: `stem`, `solutionProse`, `textAlternative`, `taxonomyTags`, `difficultyEstimate`
- `FORBIDDEN_UNDER_REVIEW` closed: `responseSpec`, `itemType`, `provenance`
- **The two sets are disjoint and together cover every mutable field of an `ItemVersion`**, asserted by enumeration against the aggregate's own shape — a field added to `ItemVersion` and to neither list fails here
- `diffWithinScope(before, after)` returns `RuleViolation` with code `EDIT_EXCEEDS_REVIEW_SCOPE`, **naming the offending field**
- A key change is refused with a distinct code (`KEY_EDIT_REQUIRES_CHANGES_REQUESTED`) whose message states the correct outcome — "refused" without a next step costs a reviewer a session
**Tests** Unit: each editable field permitted individually · each forbidden field refused individually, with the field named · a key edit names `request_changes` in the message · disjoint-and-exhaustive asserted, red on a planted new field in neither list · an empty diff permitted and reported as empty · 100% branch

### M4-09 · Fingerprints — the two authoritative hashes (DEC-M4-2)
**Objective** ROADMAP's fifth acceptance criterion, as a deterministic function.
**Files** `domain/review/fingerprint.ts`
**Acceptance**
- `normalize(text)` — NFKC, case-fold, whitespace collapse, punctuation strip; documented step by step in the module, because a normalization nobody can read is one nobody can debug
- `exactHash(itemFacts)` — SHA-256 over the normalized `plainText` projection from `projectContentBody`, **content's own projection**, never a private re-implementation
- `skeletonHash(itemFacts)` — the same, then every numeric literal → `⟨n⟩`, every unit token → `⟨u⟩`, and **MCQ option bodies sorted by their own normalized text** before hashing
- **Determinism:** identical input yields byte-identical digests across 1,000 calls and across process restarts
- **The pair property, asserted directly:** two items differing only in numeric constants share a `skeletonHash` and differ in `exactHash`; two items differing in a word share neither
- Pure; no I/O, no clock
**Tests** Unit: normalization step by step · constants-swapped pair shares the skeleton hash · option re-ordering does not change it · a changed word changes both · unit-token normalization (`m/s`, `ms^-1`) · determinism over 1,000 calls · 100% branch

### M4-10 · Trigram similarity — advisory ranking
**Objective** The recall widener, scored in-repo so the answer never depends on an index existing.
**Files** `domain/review/trigram.ts`
**Acceptance**
- `trigrams(text)` and `trigramSimilarity(a, b): number` in `[0, 1]`, symmetric, `1` exactly on identity, `0` on disjoint sets
- Ranked output only: `rankCandidates(candidates, limit)` returns at most `limit` (default 5) ordered by similarity then id — **never a boolean, never a verdict**. A spec asserts the module exports no function returning `boolean`
- **No dependency added.** `js-levenshtein` is present in the offline store as a transitive package and is deliberately not adopted: trigram similarity is ~30 lines, and a similarity metric this repository cannot read the source of is one it cannot debug when a reviewer disputes a candidate
**Tests** Unit: symmetry · identity is exactly 1 · disjoint is exactly 0 · monotonicity on progressively edited strings · ranking stable and capped · no boolean-returning export, asserted · 100% branch

### M4-11 · QC sampling — deterministic 5% (DEC-M4-14)
**Objective** §C.6's quality control, reproducible years later.
**Files** `domain/review/qc-sampling.ts`
**Acceptance**
- `isSampled(decisionId, policy): boolean` — `sha256(decisionId)`'s leading bits against `policy.sampleRate`. **No clock, no randomness**; the same decision id is always sampled or never
- Over a 10,000-id fixture the observed rate is within ±1 pp of 5% — a uniformity check, not a coin flip
- **A sampled approval is not blocked**: the module exports nothing that could gate a transition, asserted
- `secondReviewerExcludes(decision)` returns the ineligible principals — the original reviewer, the author, the editor
**Tests** Unit: determinism over repeated calls · uniformity over 10,000 ids · a rate change moves the boundary · no gating export, asserted · exclusion set correct · 100% branch

### M4-12 · Review domain events
**Objective** Cross-context effects are events, never calls (§9 rule 4) — which, after DEC-M4-7, is a rule M4 keeps rather than bends.
**Files** `domain/events/content-events.ts` (extended)
**Acceptance**
- `ReviewClaimed`, `ReviewReleased`, `ReviewDecided`, `ItemReviewEscalated` added to content's existing vocabulary — past tense (§2), and `CONTENT_EVENT_TYPES` grows rather than a second vocabulary appearing
- Payloads carry identifiers, vocabulary members and instants only: **no answer key, no stem, no justification text, no PII** (§9 rules 10, 12). A reviewer's justification is feedback to one author, not an analytics field
- `ReviewDecided` carries the outcome and the reason code — the two fields capacity planning needs — and nothing more
- Every event has an analytics counterpart or a recorded exemption (F18), reconciled against [EVENT-TAXONOMY.md](../EVENT-TAXONOMY.md)
**Tests** Unit: each event constructs · payload inspection for key material, body text, justification text and PII, per event · F18 reconciliation · **M3's existing event tests green unchanged** · 100% branch

---

## Track B — Content model & data

*Under DEC-M4-7 these are ordinary content changes, not cross-context amendments. Every existing content test
must still pass unchanged unless it asserted something that stopped being true — in which case it is
**rewritten, never deleted** (M0's convention 2). Each task states what it does **not** change.*

### M4-13 · `stateEnteredAt` on `Item` and the authoring view
**Objective** The queue's ageing clock. Content records `created_at` and nothing about *when* an item entered its current state.
**Files** `domain/item.ts`, `infrastructure/item.repository.ts`, `application/queries/authoring-queries.ts`, `infra/migrations/<ts>_content_state_entered_at.sql`
**Acceptance**
- `content.item.state_entered_at timestamptz NOT NULL`, backfilled from `created_at`, set on **every** lifecycle transition
- `Item` carries `stateEnteredAt`, **supplied** by the handler from the clock port — the domain stays clock-free
- Exposed on `AuthoringItemView`; **absent from every delivery view**, asserted (a student has no interest in review latency, and F6/F35's method already scans these)
- **What this does not change:** no precondition, no transition, no published-version mutability. The exhaustive 72-pair matrix is re-run unchanged
- *Rejected alternative, recorded in the task:* deriving the instant from `platform.audit_record`. An audit log is evidence, not an index; routing the queue through it makes renaming an action string a silent queue outage
**Tests** Integration: migration up/down/up · every transition updates the instant, asserted per transition · backfill correctness on a pre-existing row · absent from delivery views · the M3 lifecycle matrix still green

### M4-14 · `authoringSubject` — corrected 2026-08-20, split into two tasks

**Correction.** This entry's premise — "content validates a declared subject today" — is false
for items. `authorizeSubjectScope(command.subject, …)` is called by the stimulus, solution,
media and import handlers. It is called by **none** of the four item handlers:
`CreateItemDraft` carries no `subject` field at all, and `CreateItemDraftHandler` never calls it.
FR-TCH-01 rule 1 was unenforced on the primary authoring path — found while implementing this
task, proven with a test before the fix (a Physics-scoped author declaring `chemistry` was not
refused; the item was created), corrected rather than implemented around.

**The decision made, resolve rather than declare.** For a subject-scoped author, their scope
**is** the subject of everything they author — letting them declare a different one is the exact
mistagging D23 says nothing catches. So `CreateItemDraft.subject` is optional; the handler
*resolves* it: exactly one `subject:<name>` scope on the principal derives it (a declaration
that disagrees is refused, one that agrees is redundant); an unscoped principal (Content Ops) or
one scoped to several subjects must declare it, authorized the existing way; neither derivable
nor declared is `Validation`. The resolved value is persisted. `UpdateItemDraft`,
`DeriveDraftFromVersion` and `DeleteItemDraft` take **no** subject at all — a subject is a fact
about the item, not something a later edit could misdeclare, so each authorizes against the
*stored* value instead.

That is strictly better than declare-and-check, not merely equivalent to it: the common case
cannot be lied about, and edits have nothing to declare. It is more than the original additive
storage change, so it is split in two.

### M4-14a · Resolve and persist the authoring subject at item creation
**Objective** FR-TCH-01 rule 1, actually enforced on item creation.
**Files** `domain/item.ts`, `application/authorization.ts`, `application/commands/authoring-commands.ts`,
`application/handlers/authoring-handlers.ts` (`CreateItemDraftHandler` only),
`application/queries/authoring-queries.ts`, `infrastructure/item.repository.ts`,
`infra/migrations/<ts>_content_authoring_subject.sql`
**Acceptance**
- `resolveAuthoringSubject(declared, context)` in `application/authorization.ts`: single scope →
  derive, refuse a disagreeing declaration; unscoped or multi-scoped → declaration required,
  authorized via the existing `authorizeSubjectScope`; neither → `Validation`, located
- `CreateItemDraft.subject?: string` — optional, so a single-scoped author's existing call
  (declaring nothing) is unaffected
- `content.item.authoring_subject text NOT NULL`, a non-blank `CHECK`, backfilled and
  column-defaulted to `'unclassified'` for rows and callers that predate subject tracking
- `Item.authoringSubject` optional at the domain level, the same discipline `stateEnteredAt`
  (M4-13) already set — every M3 constructor call site is unaffected
- Exposed on `AuthoringItemView`; **not** on delivery views
- **The D23 caveat restated, corrected**: this closes the half of D23 where a scoped author's
  own declaration could disagree with their scope. It does not close the half where nothing
  cross-checks a resolved or declared subject against the content itself — that still needs a
  concept → subject-domain lookup Curriculum does not expose. D23 stays open for that half, with
  its existing trigger
**Tests** Unit: `resolveAuthoringSubject` over all six shapes (single-agree, single-disagree,
single-absent-declaration, multi-required, unscoped-required, neither-derivable-nor-declared) ·
Integration: round trip · a blank subject refused at the database and in the type · **the
before/after hole-closing test, with the before state recorded** · existing authoring tests
green (the shared author/otherAuthor fixtures needed a subject scope each — the fixture was
part of the gap, not incidental to it)

### M4-14b · Authorize every later touch against the stored subject
**Objective** The hole was not only at creation. `UpdateItemDraft`, `DeriveDraftFromVersion` and
`DeleteItemDraft` touched an item with no subject check at all, before this task and after
M4-14a alone.
**Files** `application/handlers/authoring-handlers.ts` (`UpdateItemDraftHandler`,
`DeriveDraftFromVersionHandler`, `DeleteItemDraftHandler`)
**Acceptance**
- None of the three commands gain a `subject` field
- Each handler calls `authorizeSubjectScope(item.authoringSubject, context)` after
  `authorizeDraftAccess`, so an existing ownership refusal's error code is unchanged — this only
  ever refuses an owner (or Content Ops) whose own scope no longer covers the item
**Tests** Integration: a principal whose subject scope no longer covers the item's stored
subject is refused on update, derive and delete · Content Ops (cross-subject) unaffected ·
existing ownership tests green unchanged

**Not done now, named for later:** the stimulus, solution and media authoring paths still
declare-and-check rather than resolve. Aligning them to `resolveAuthoringSubject` is worth doing
the next time one of them is touched; it is not part of M4-14a/b.

### M4-15 · `editedBy` & the bounded reviewer edit — ADR-0018
**Objective** DEC-M4-3, in the domain where every caller meets it.
**Files** `domain/item-version.ts`, `domain/publication-preconditions.ts`, `infrastructure/item.repository.ts`, `infra/migrations/<ts>_content_edited_by.sql` · **plus `docs/adr/ADR-0018-approve-with-edits-keeps-the-author.md`**
**Acceptance**
- `ItemVersion.editedBy?: PrincipalRef` — set only by the reviewer-edit path; `authoredBy` is **never** rewritten, asserted
- `deriveReviewerEditedVersion(from, reviewer, edits)` produces a new version carrying `authoredBy` and setting `editedBy`, refusing an edit outside M4-08's scope
- **INV-12 extended, not weakened**: `checkPublishable` refuses when the signing reviewer equals `authoredBy` **or** `editedBy` — via M4-04's single function. A reviewer may edit *or* sign, never both on one version
- **INV-01 unchanged**: AI-sourced provenance still requires a human signature, and `editedBy` cannot substitute for one
- **ADR-0018** records: why the author stays the author, why the edit scope is closed, why no second reviewer, and **why D25 is not on this path**
**Tests** Unit + integration: `authoredBy` survives a reviewer edit · an out-of-scope edit refused with the field named · a reviewer who edited cannot sign the same version · a *different* reviewer can · AI provenance still requires a human signature · the M3 publication-precondition suite green unchanged · 100% branch on the amended module

### M4-16 · `ListSubmittedForReview` — the queue's candidate source
**Objective** `ListMyDrafts` is author-scoped; nothing lists submitted work.
**Files** `application/queries/authoring-queries.ts`, `public/index.ts`, `infrastructure/item.repository.ts`
**Acceptance**
- `ListSubmittedForReview { subject?, excludeAuthorId?, limit, cursor }` returning `AuthoringItemVersionView[]` plus `stateEnteredAt`, `authoringSubject` and M3's validation counts
- **An authoring-family query**: it carries the key (a reviewer needs it), declares an authoring policy, and is reachable only under one. Learner-role access is `Authorization`, never an empty result
- `excludeAuthorId` is the **source-level** half of INV-12; M4-04 re-checks after selection
- Returns only items whose `lifecycleState` is `in_review` — a spec asserts no other state can be returned, on any argument
- Deterministic pagination with a stable cursor; a concurrent insert never duplicates or skips a row
**Tests** Integration: subject filter · author exclusion · state restriction proven exhaustively over all eight states · learner refused with `Authorization` · cursor stability under concurrent insert · key present (ADR-0009's both-direction check) · 100%

### M4-17 · Review schema migration
**Objective** The review tables, inside the `content` schema — which is DEC-M4-7's whole point.
**Files** `infra/migrations/<ts>_content_review_schema.sql`, `infrastructure/schema.ts`
**Acceptance**
- New tables: `content.review_assignment`, `content.item_fingerprint`, `content.review_escalation`, `content.review_candidate_shown`
- `content.review_decision` gains `reason_code text`, `duplicate_of_item_id uuid` — additive, and its append-only property is unchanged. A check constraint mirrors M4-06: `DUPLICATE` requires a target
- **Partial unique index: at most one live assignment per item version** (`WHERE state = 'claimed'`) — the database half of M4-02's rule
- `tenant_id`, `aggregate_version`, `created_at` per the M1 convention; UUIDv7 defaults; every JSONB column carries a `*_schema_version` sibling (§9 rule 7 / F5)
- **No cross-schema foreign key** (§9 rule 3) — and, being one schema, the review tables reference `item_version` by real FK, which is the coupling the first pass had to fake with value references
- Migration runs up, down, and up again on a clean database
**Tests** Integration: up/down/up · the partial unique index rejects a second live claim · the `DUPLICATE` constraint fires from raw SQL · F5's sibling check over the new tables · catalogue query proving no FK crosses a schema

### M4-18 · `ReviewAssignment` repository — the atomic claim
**Objective** The one piece of concurrency in this milestone that can silently be wrong.
**Files** `infrastructure/review/review-assignment.repository.ts`
**Acceptance**
- `claimNext(subject, reviewer, ordering, now)` — one statement using `FOR UPDATE SKIP LOCKED` over the candidate set, inserting the assignment in the same transaction
- **The self-review exclusion is in the predicate** (M4-04) and re-checked after selection
- **Two concurrent claims never return the same item**, proven with genuinely overlapping transactions on two connections — not with sequential calls, which prove nothing
- `releaseExpired(now)` releases every lease past expiry, returns what it released, and is idempotent
- Optimistic concurrency on `aggregate_version`; a stale write is `Conflict`
- snake_case ↔ camelCase mapping here and nowhere else
**Tests** Integration: claim/release round trip · **two overlapping transactions claim two different items** · a claimed item is invisible to a second claimant · expiry releases and is idempotent on a second run · a self-authored item is never returned, on any ordering · stale write is `Conflict` · 100% branch

### M4-19 · `review_decision` repository extended
**Objective** One decision, one transaction — which under DEC-M4-7 needs no coordination at all.
**Files** `infrastructure/review-decision.repository.ts` (extended), `infrastructure/review/review-candidate-shown.repository.ts`
**Acceptance**
- Save is transactional across `review_decision`, `review_candidate_shown` and the assignment's state change — **one transaction, one schema, one pool**
- **Append-only**: no `UPDATE` path exists in the repository, and M4-21 removes the grant that would allow one
- `findByItemVersion`, `findByReviewer(range)` — the latter is the throughput instrument's source (M4-33)
- Candidate ids shown are stored as rows, not a JSON blob, because "was this candidate shown?" is a question with an index
- **M3's existing `review-decision.repository.integration.spec.ts` passes unchanged**
**Tests** Integration: round trip with the new fields · rollback leaves neither the decision, the candidate rows nor the assignment change · no update path, asserted over the module's surface · deterministic lookup order · M3's suite green · 100% branch

### M4-20 · Fingerprint store & the trigram retrieval index
**Objective** DEC-M4-2's retrieval half, with the fallback honest.
**Files** `infrastructure/review/fingerprint.repository.ts`, `infra/migrations/<ts>_content_fingerprint_index.sql`
**Acceptance**
- `content.item_fingerprint { item_id, item_version_id, subject, exact_hash, skeleton_hash, normalized_text, computed_at }`
- B-tree indexes on `exact_hash` and `skeleton_hash` — the authoritative lookups are exact-match and therefore cheap
- `CREATE EXTENSION IF NOT EXISTS pg_trgm` and a GIN index on `normalized_text` **for candidate narrowing only**
- **If the extension is unavailable, the migration fails loudly and the repository falls back to a full scan of the subject's fingerprints** — identical results, slower. A named code path with its own test, not an exception handler that quietly changes the answer
- A spec asserts the **authoritative** verdicts (M4-09) never consult the index
**Tests** Integration: round trip · exact and skeleton lookups · trigram narrowing returns a superset of the in-repo ranking's top-N · **the fallback path returns the identical candidate set to the indexed path** over the corpus · extension absence handled by the documented path · 100% branch

### M4-21 · Review-table immutability & grants (F7/F40)
**Objective** §9 rule 11 at the database, to M0-24's standard, on the tables M4 adds.
**Files** `infra/migrations/<ts>_content_review_immutability.sql`, `apps/api/src/fitness/content-rules.integration.spec.ts` (extended)
**Acceptance**
- `review_candidate_shown` and `review_escalation` reject `UPDATE` and `DELETE` by trigger; `review_assignment` permits the state changes its machine names and nothing else, compared column-wise the way M2-19 does; `review_decision`'s existing append-only guarantee is re-asserted after the new columns land
- **No `UPDATE`/`DELETE`/`TRUNCATE` grant** for `questionbank_app` on any append-only review table, nor on `platform.audit_anchor`
- The privilege assertion is by **set equality** against the catalogue, **extending M0-24's closed table list** rather than starting a second one
**Tests** Integration: raw `psql` `UPDATE` and `DELETE` rejected per table · a permitted assignment state change succeeds · M0-24's privilege set equality extended and green · a granted `UPDATE` inside a rolled-back transaction makes the check fire

---

## Track C — Platform: the audit chain ⚠

*The one genuinely cross-cutting change M4 makes. It lands in `platform/`, covers all three contexts' audit
records, and touches no context's schema.*

### M4-22 · ⚠ platform: the audit link — canonical serialization & hash
**Objective** The pure half of DEC-M4-4, testable without a database.
**Files** `platform/persistence/audit-link.ts`
**Acceptance**
- `canonicalize(record)` — a deterministic byte serialization of an audit record's **semantic** fields in a fixed, documented order. Never `chain_seq`, never a database default, never a locale-dependent number or date format
- `linkHash(canonicalBytes, prevHash)` = SHA-256 over `prevHash ‖ canonical` via `node:crypto`
- **The genesis link uses a documented all-zero `prevHash`**, so "the first record" is not a special case in the verifier
- **Any single-field change changes the hash** — asserted field by field over every column, not once on a representative record
- The TypeScript implementation is the **specification**; M4-23's SQL implementation is asserted byte-identical against it over a shared fixture set. Two implementations of a hash is a real risk, and the mitigation is a test that compares them rather than a comment asking people to be careful
**Tests** Unit: determinism · every field's mutation changes the digest, one test per field · genesis link · a field-order change in the canonicalizer changes the digest, so the order is pinned rather than incidental · 100% branch

### M4-23 · ⚠ platform: the chain — columns, trigger, backfill — ADR-0020
**Objective** DEC-M4-4, enforced where the adversary cannot reach around it.
**Files** `infra/migrations/<ts>_platform_audit_chain.sql`, `platform/persistence/audit-chain.ts` · **plus `docs/adr/ADR-0020-the-audit-chain-is-database-enforced-and-locally-anchored.md`**
**Acceptance**
- `platform.audit_record` gains `chain_seq bigint NOT NULL`, `prev_hash bytea NOT NULL`, `record_hash bytea NOT NULL`, all set by a `BEFORE INSERT` trigger — never by the application, never by a caller
- The trigger takes `pg_advisory_xact_lock`, reads the head, and computes `record_hash` over M4-22's canonicalization
- **The SQL canonicalization is asserted byte-identical to M4-22's TypeScript** over a shared fixture set
- `chain_seq` is unique and gapless; a gap is what M4-25 detects
- **The append-only trigger and the grant revocation are unchanged**; the app role gains no `UPDATE` (DEC-M4-16 tripwire 2)
- **Backfill:** existing audit rows are chained in `audit_record_id` order in the migration, so the chain has no pre-history hole
- **ADR-0020** records where the chain lives and why platform, the database-not-application decision, and the anchor's stated limit
**Tests** Integration: every insert chains · concurrent inserts from two connections produce a gapless total order · SQL/TS canonicalization equality over fixtures · backfill leaves a verifying chain · append-only trigger still rejects `UPDATE`/`DELETE` · the app role still holds no `UPDATE` grant

### M4-24 · ⚠ platform: the daily anchor, sealed and signed
**Objective** "Daily anchor", meaning exactly what it can mean here and no more.
**Files** `infra/migrations/<ts>_platform_audit_anchor.sql`, `platform/persistence/audit-anchor.ts`, `platform/config/config.ts` (one new key)
**Acceptance**
- `platform.audit_anchor { day, first_seq, last_seq, head_hash, record_count, sealed_at, signature }`, one row per UTC day, unique on `day`, append-only
- Signature is HMAC-SHA256 over the canonicalized anchor under a **new `auditAnchorKey`** — no default, minimum 32 bytes, never `authSigningKey`; `.env.example` gains a placeholder, which M0-23's equality check covers automatically
- Sealing is **idempotent**: sealing the same day twice is a no-op returning the existing anchor, never a second row and never a re-signature
- An `AuditAnchorSealed` event is written to `platform.outbox_message` in the same transaction
- **The module header states the limit verbatim:** a key on the machine that holds the database bounds the attacker to one holding both, and this is **not notarization**. Tier-3 successor named: publish `head_hash` to an external timestamping authority or second-party witness
**Tests** Integration: seal, re-seal is a no-op · signature verifies and fails on a mutated anchor field, per field · a missing `auditAnchorKey` is a config error naming the key with no value in the message · the outbox row is written in the same transaction and absent on rollback

### M4-25 · Chain verification & tamper detection — F41
**Objective** ROADMAP's fourth acceptance criterion, and SECURITY-ARCHITECTURE's registered F41.
**Files** `platform/persistence/audit-chain-verify.ts`, `apps/api/src/fitness/audit-chain.integration.spec.ts`
**Acceptance**
- `verifyChain(from, to): { ok, firstDivergentSeq?, reason? }` — recomputes every link and reports **where** it broke, not merely that it did
- Detects, each as its own test: **a mutated field**, **a deleted link** (sequence gap), **two records swapped**, **a forged tail appended after a re-signed anchor**
- **The tamper is planted for real**: as superuser, inside a rolled-back transaction, with the append-only trigger disabled — the method that first made F7/F40 fire against a real role (M0-24)
- **F41 as registered**: a gate asserts the chain verifies over the last 24 hours **and** that it scanned a **non-zero** record count — a chain verifying over zero rows is B1's failure mode wearing new clothes
- Verification is bounded and streams; it does not load the table
**Tests** Integration: a clean chain verifies with a non-zero count · each of the four tamper classes detected with the correct `firstDivergentSeq` · anchor mismatch detected independently of link mismatch · the vacuity assertion red when the window is empty

---

## Track D — Application

*`contexts/content/application/review/`. Orchestration only, no business logic (§1). Every handler declares an
authorization policy or the module fails to boot (§9 rule 6 / F36). Handlers that decide who sees what, or
that drive a lifecycle transition, are correctness-bearing under ADR-0008 and carry a 100% threshold with the
file.*

### M4-26 · `ReviewPolicy` configuration & the review authorization policies
**Objective** The thresholds and the role gates, declared once.
**Files** `platform/config/config.ts`, `application/review/policies.ts`
**Acceptance**
- Config keys `reviewWarnAfterHours`, `reviewEscalateAfterHours`, `reviewLeaseHours`, `reviewSampleRate` — validated at load, each with its own error, defaults per DEC-M4-1
- Review policies declared beside content's existing ones (`DRAFT_OVERSIGHT_ROLES`, `CROSS_SUBJECT_ROLES` reused, not copied): `reviewer` may claim, decide and edit-in-scope; `content_ops` may reassign, sweep and read queue health; **neither may publish without the step-up content already requires**
- A spec asserts the review policies reuse content's role constants rather than declaring parallel ones — the entanglement M4-01's sub-boundary is meant to prevent
**Tests** Unit: each config key's validation failure individually · policy declarations present for every review handler · role-constant reuse asserted · 100% branch

### M4-27 · Claim, release, reassign — commands & handlers
**Objective** The queue, driven.
**Files** `application/review/commands/assignment-commands.ts`, `application/review/handlers/assignment-handlers.ts`
**Acceptance**
- `ClaimNextForReview`, `ReleaseAssignment`, `ReassignReview` (Content Ops only), `ExtendLease`
- Each declares a distinct authorization policy; **every negative path is tested** — 100% on authorization negative paths is a §5 requirement, not a target
- `ClaimNextForReview` resolves candidates **through `claimNext` (M4-18) directly**, and **re-checks self-review after selection** (M4-04)

  > **Correction, 2026-08-21 (M4-27).** This line originally read "resolves
  > candidates through `ListSubmittedForReview` (M4-16), orders through M4-03".
  > That is wrong: `ListSubmittedForReview` runs its own `SELECT` on its own
  > connection, outside `claimNext`'s transaction — routing candidate
  > resolution through it would reopen exactly the SELECT-then-INSERT race
  > M4-18's single locking statement (`SELECT … FOR UPDATE SKIP LOCKED` then
  > `INSERT`, one transaction) exists to close. Candidate resolution stays
  > inside `claimNext`, where it already lives. `ListSubmittedForReview`
  > remains the **read-only** queue listing — the Studio surface and M4-33's
  > queue-health query, never a review-write path. Original text kept above
  > rather than rewritten (M0's convention 3).
- Subject scope uses content's existing `authorizeSubjectScope`: a reviewer holding `subject:physics` cannot claim chemistry; Content Ops can claim across subjects
- Every command writes an audit record naming principal, action and target (INV-02) — now a chained record
**Tests** Integration (real Postgres): each command · claim returns the correctly ordered item · out-of-subject claim refused · self-claim refused even after a planted predicate removal (the second check catches it) · each command refused for each unauthorized role · policy-less handler fails boot · 100%

### M4-28 · `RecordReviewDecision` extended — one handler, one transaction
**Objective** The milestone's load-bearing handler. Under DEC-M4-7 it is an **ordinary intra-context handler** — no facade, no cross-context transaction.
**Files** `application/handlers/lifecycle-handlers.ts` (extended), `application/review/handlers/decision-handlers.ts`
**Acceptance**
- Writes the decision (with reason and citations), the shown-candidate rows and the assignment's state change, **and** performs the lifecycle transition — in **one transaction**, through content's own aggregates
- The publication precondition's refusal reaches the caller with **its own code, message and location** — never re-worded, never flattened
- INV-12 is checked before the transition is attempted (M4-04), so the cheap refusal happens first
- The QC sample (M4-11) is evaluated **after** the decision commits and creates a second-review assignment; **it never gates the decision**, asserted
- Every decision writes an audit record, and the test verifies that record chains
- **M3-28's existing lifecycle handler tests pass unchanged** — the extension adds fields and a sibling write, and changes no transition
**Tests** Integration: each outcome end to end against real Postgres · a publication precondition refusal surfaces with its own code · **rollback leaves nothing written**, proven by forcing a failure after the decision insert · self-review refused before the transition is attempted · sampling creates a second assignment and does not delay the first · M3-28's suite green · 100%

### M4-29 · Approve-with-edits handler
**Objective** DEC-M4-3's path, end to end.
**Files** `application/review/handlers/reviewer-edit-handlers.ts`
**Acceptance**
- Derives the edited version through M4-15's `deriveReviewerEditedVersion`, records the decision, leaves `authoredBy` untouched
- An edit outside M4-08's scope is refused **with the field named and the correct next outcome stated**
- The resulting version is publishable **by a different reviewer** and refused for the editing reviewer, proven end to end rather than in the unit test alone
- Both versions remain retrievable — the author's and the edited one — which is ROADMAP's "records both versions"
**Tests** Integration: a scoped edit publishes under a second reviewer · the editing reviewer's own signature refused · a key edit refused with `request_changes` named · both versions retrievable and distinguishable by `editedBy` · 100%

### M4-30 · `ReviewProgress` retired — W4 closed, ADR-0015 amended
**Objective** The port M3 declared **because** it assumed assignment lived in another context. Under DEC-M4-7 it has no reason to exist.
**Files** `application/ports.ts`, `application/handlers/lifecycle-handlers.ts`, `public/composition.ts`, `docs/adr/ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md` (amended in place)
**Acceptance**
- `ReviewProgress` and `InMemoryReviewProgress` are **deleted**; the withdrawal handler reads `content.review_assignment` directly for a **live** claim — an expired lease is not begun work
- **The read runs inside the withdrawal handler's own transaction**, so a withdrawal racing a claim sees the claim. This is the property no port and no projection could have promised
- **W4 is closed.** The `ports.ts` note describing "nothing claims a version, so withdrawal is always permitted" is **rewritten to describe what now exists**, never deleted (M0's convention 3)
- **ADR-0015 amended in place** (ADR-0004's pattern): its paragraph wiring `InMemoryReviewProgress` "as the production choice" is superseded, with the reason and the date
- **The M3 test asserting withdrawal is always permitted is rewritten to assert the real rule**, not removed (DEC-M4-16 tripwire 4)
**Tests** Integration: withdrawal permitted with no claim · refused with a live claim · permitted again after the lease expires · **the race** — a claim and a withdrawal in overlapping transactions resolve to exactly one winner · a spec asserts `ReviewProgress` no longer exists anywhere in the tree · 100%

### M4-31 · The ageing sweep & escalation handler (DEC-M4-15)
**Objective** FR-ADM-05, without a scheduler.
**Files** `application/review/handlers/ageing-handlers.ts`
**Acceptance**
- `SweepReviewAgeing(now)` — releases expired leases, emits `ItemReviewEscalated` for items newly past the escalation threshold, and is **idempotent**: a second sweep at the same instant emits nothing
- Escalation **does not reassign** (DEC-M4-1); it writes a `review_escalation` row Content Ops acts on
- Pure orchestration over M4-05; no threshold arithmetic lives here
- **The header names the Tier-3 successor verbatim**: an hourly scheduled invocation in a deployed environment, which does not exist (**D36**)
**Tests** Integration: expired leases released · escalation emitted once and not twice · nothing emitted below the threshold, emitted exactly at it · a sweep at a clock-skewed earlier instant is a no-op, not a negative age · 100%

### M4-32 · Duplicate candidates — refresh & query
**Objective** DEC-M4-2's operational half, with its staleness stated.
**Files** `application/review/handlers/fingerprint-handlers.ts`, `application/review/queries/duplicate-queries.ts`
**Acceptance**
- `RefreshFingerprints(since)` computes fingerprints for content changed since a watermark; `GetDuplicateCandidates(itemVersionId)` returns exact matches, skeleton matches and trigram-ranked near matches as **three labelled groups**, never one merged list
- The item being claimed has its fingerprint computed **synchronously at claim** if missing, so the reviewer never sees "not evaluated" for the item in front of them
- **Staleness is in the response**: `computedAt` and the watermark travel with the result, so "no candidates" and "no candidates as of 40 minutes ago" are distinguishable
- The result **never blocks anything** — the query is not reachable from any transition handler, asserted by import graph
**Tests** Integration: a planted constants-swapped pair appears in the skeleton group · an exact retype in the exact group · a merely similar item only in the trigram group · staleness reported · no transition handler imports this module, asserted · 100%

### M4-33 · Queue health, ageing & throughput queries (DEC-M4-13)
**Objective** FR-RPT-03, and the instrument DEC-M4-5 needs.
**Files** `application/review/queries/queue-queries.ts`
**Acceptance**
- `GetQueueHealth` — depth by subject, an age histogram in the M4-05 bands, the escalated list
- `GetReviewerThroughput(from, to)` — decisions per hour from `review_decision.decided_at`, **per reviewer and in aggregate**
- **The throughput query is the timing instrument.** Proven against synthetic timestamps (M4-44) and reporting a rate; **never described as a measurement of a real reviewer**
- Each query declares a policy; Content Ops only. A reviewer may read their **own** throughput and no one else's
- Deterministic bucketing: the same data yields the same histogram, boundaries inclusive-lower/exclusive-upper, documented
**Tests** Integration: depth and histogram over a seeded queue · the escalated list matches M4-05's pure function exactly · throughput over synthetic timestamps returns the arithmetic answer · a reviewer reading another's throughput refused · determinism · 100%

### M4-34 · `SealDailyAuditAnchor` handler
**Objective** DEC-M4-4's daily action, as a command.
**Files** `platform/persistence/anchor-handlers.ts`
**Acceptance**
- `SealDailyAuditAnchor(day)` — verifies the chain over the day's range **before** sealing, and refuses to seal a broken chain, because an anchor over a chain that does not verify certifies a lie
- Idempotent per day; declares a policy restricted to a system principal
- **Tier-3 successor named verbatim**: a daily scheduled invocation in a deployed environment (**D36**)
**Tests** Integration: seal · re-seal is a no-op · sealing refused over a tampered range, with the divergent seq reported · a non-system principal refused · 100%

### M4-35 · Barrel, composition & the M5 seam spec
**Objective** §9 rule 1 at M1/M2/M3's standard — and, since there is no new context, a smaller job than the first pass assumed.
**Files** `public/index.ts`, `public/composition.ts`, `contexts/content/m5-seam.spec.ts`, `contexts/content/m4-seam.spec.ts` (retargeted)
**Acceptance**
- Content's barrel gains the review commands, queries and events; the value-level export set asserted by **set equality**, as it already is
- `public/composition.ts` grows the review handler population and **no new parameter shape** — no facade, no fourth context (DEC-M4-7). `public/index.ts` still does not import it
- **`m4-seam.spec.ts` is retargeted, not deleted** — its job was to catch a missing export before a fourth context reached past the barrel. With no fourth context, it becomes the **Studio/contracts seam**: what the review workspace needs is reachable through `packages/contracts` and the barrel, asserted the same way
- **An M5 seam spec** written against `content/public/` only: M5 needs to enqueue generated candidates for review, read decision outcomes to compute first-pass acceptance, and read the rejection taxonomy to classify failures. A missing export is a compile failure there rather than M5 reaching past the barrel
**Tests** `boundary-rules.spec.ts` extended: the review sub-boundary in both directions · export set equality, red on an accidental export · the M5 seam spec compiles and builds a review-outcome summary from barrel types alone · all four import forms per ADR-0002

---

## Track E — API

### M4-36 · OpenAPI under `/v1/authoring/review/**` (DEC-M4-12)
**Objective** Contract first (§9 rule 15), inside ADR-0009's existing enumeration.
**Files** `packages/contracts/openapi/content.yaml` (extended), `packages/contracts/src/content-schemas.ts`, `apps/api/src/contracts/content-contract.spec.ts`
**Acceptance**
- Every review endpoint under `/v1/authoring/review/**` with an `x-handler` reconciling against the registry (F15's M1/M2/M3 pattern)
- RFC 9457 Problem Details on every error with a stable `code` and an explicit `retryable` flag (§8)
- **The key-bearing routes sit inside the existing enumerated authoring family** — asserted from **both** directions: every review route is inside the enumeration, and every non-authoring schema is scanned and carries no key
- Zod generated from the document, not hand-written; **D7 restated** — the 3.1 meta-schema is still not obtainable here and the check is named as strictly weaker, as content's already is
- Queue and decision payloads carry `authoringSubject` and `stateEnteredAt`; **no reviewer's justification text is returned on a list endpoint**
**Tests** Contract: spec/registry reconciliation · Problem Details with `retryable` on every error · the enumeration check in both directions · **a planted `/v1/review/**` route fails the enumeration check** · generated Zod compared byte for byte

### M4-37 · Review controllers
**Objective** Controllers and DTOs. No business logic (§1).
**Files** `api/review.controller.ts`, `api/content.module.ts` (extended), `api/dto/review-schemas.ts`
**Acceptance**
- Routes for claim, release, reassign, decide, edit-and-approve, duplicates, queue health
- Paths plural and kebab-case; JSON fields camelCase (§2); input validated at the boundary against the generated schemas
- Module boot fails if any handler lacks a policy (F36), proven with a planted policy-less handler
- Correlation ID on every response, error or not (§8)
- **A delivery-family route that would serialize a key fails a test, not a review** — M3-34's live-output scan extended over the review controller
**Tests** Integration: each route happy path · each error path returns Problem Details · malformed body rejected at the boundary · policy-less handler fails boot · correlation ID present · live output scanned for key material outside the authoring family

---

## Track F — Studio

*Keyboard-first, consuming the typed client only (F15). The 1280 px shell gate and the navigation model
already exist (M3-39, M0-16); M4 adds destinations, not a second shell.*

### M4-38 · Review workspace — one screen, keyboard, auto-advance
**Objective** UX §10.2's core: a reviewer in flow state, everything visible, nothing behind a click.
**Files** `apps/studio/src/features/review-workspace/ReviewWorkspace.tsx`, `review-workspace-model.ts`, `review-workspace-api.ts`
**Acceptance**
- **One item fills the screen**: stem, options, solution, tags, provenance, validation findings, duplicate candidates — all rendered, **none behind a disclosure**. A test counts zero elements requiring interaction to reveal any of the seven
- Rendered through `packages/content-renderer/` at the **mobile profile by default** (DEC-M4-12), the same renderer students get (F20)
- **Auto-advance**: a decision serves the next item with no confirmation and **no navigation** — asserted by a test that the route does not change across ten consecutive decisions
- The next item is **prefetched** while the reviewer reads the current one; a test asserts the reviewer never waits on a request between decisions
- Queue depth and pace visible; **no leaderboard, no rank, no per-reviewer comparison** anywhere (DEC-M4-13), asserted
- Focus lands on the item heading on advance; every control keyboard-operable; axe clean
**Tests** Component: zero-disclosure assertion over all seven regions · ten decisions produce zero route changes · prefetch asserted · the answer key is present (an authoring-family surface) and the surface is unreachable without an authoring policy · axe clean

### M4-39 · Decision bar, taxonomy by key, undo window (DEC-M4-10)
**Objective** Single-keystroke decisions, a fixed taxonomy, and an undo that does not lie.
**Files** `apps/studio/src/features/review-workspace/DecisionBar.tsx`, `undo-buffer.ts`
**Acceptance**
- Four single-keystroke decisions; the rejection taxonomy chosen **by key** from M4-06's list, never typed, read from the shared constant rather than duplicated
- **The undo window is a 5-second commit delay** — nothing is sent until it elapses; the countdown is visible; undo restores the item with the reviewer's in-progress state intact
- **`DUPLICATE` cannot be submitted without a selected candidate** — the affordance requires the citation the domain requires
- A justification is required on every non-approving outcome before commit, surfaced inline rather than as a rejection after the fact
- Every keystroke announced to assistive technology; no decision available by mouse only, and none by keyboard only
**Tests** Component: each outcome by its key · undo inside the window sends nothing, asserted at the client boundary · elapsing the window sends exactly one request · `DUPLICATE` without a citation unavailable · non-approving without justification unavailable · keystroke/mouse parity · axe clean

### M4-40 · Duplicate panel & edit-in-place
**Objective** The two UX §10.2 elements easiest to build wrongly.
**Files** `apps/studio/src/features/review-workspace/DuplicatePanel.tsx`, `InlineEditor.tsx`
**Acceptance**
- Candidates render side by side with the incoming item in **three labelled groups** (exact / same-question-different-constants / similar), each with its similarity and `computedAt` — a reviewer must be able to disagree with the machine, which requires seeing which machine spoke
- Selecting a candidate cites it into the decision; the citation is what M4-07 stores
- **Edit-in-place without leaving the queue**: the inline editor exposes exactly M4-08's editable fields and **cannot render a control for a forbidden one**, asserted by enumeration against the shared constant rather than by convention
- An out-of-scope edit is impossible in the UI **and** refused in the domain; the UI states why rather than disabling silently
**Tests** Component: three groups labelled and ordered · staleness rendered · citation flows into the decision payload · no control exists for any forbidden field, by enumeration · the refusal message rendered · axe clean

### M4-41 · Content Ops queue management surface
**Objective** UX §11's review-queue management.
**Files** `apps/studio/src/features/queue-management/`
**Acceptance**
- Depth by subject, the age histogram, the escalated list with a `ReassignReview` action; filters live in the URL (FRONTEND §5)
- **Aggregate throughput only; no per-reviewer ranking rendered and no sort control keyed on reviewer productivity** (DEC-M4-13), asserted
- Empty states designed, not defaulted (UX §12) — a cold queue is this product's first week
**Tests** Component: histogram matches the query · reassign reaches the handler · **no ranking affordance exists**, asserted by enumeration of sort keys · filters round-trip through the URL · empty states rendered · axe clean

---

## Track G — Gates, instruments & close-out

### M4-42 · The M4 gate module, planted fixtures & thresholds
**Objective** Every gate M4 adds, each proven with a planted violation — the M0/M1/M2/M3 standard.
**Files** `apps/api/src/fitness/content-rules.ts` (extended), `content-rules.spec.ts`, `content-rules.integration.spec.ts`, fixtures under `apps/api/src/fitness-fixtures/`, `apps/api/vitest.config.ts`, `apps/studio/vitest.config.ts`
**Acceptance** — the gate register, each with the violation that proves it can fail:

| Gate | Asserted | Planted violation |
|---|---|---|
| **F41** | The audit chain verifies over the last 24 hours, over a **non-zero** record count | A field mutated with the append-only trigger disabled, in a rolled-back transaction (M4-25) |
| **INV-12 (one function)** | Self-review is refused at claim, at decision and at publication, **through a single function with three enumerated call sites** | The claim predicate's author exclusion removed; the decision check removed; a fourth inline comparison added |
| **Review sub-boundary** | `authoring/` imports nothing from `review/`; `review/` reaches `authoring/` only through the aggregates and the shared authorization module | An import of `application/review/handlers/decision-handlers.js` from an authoring handler, and the reverse |
| **F36** | Every review handler declares a policy; the composed app rejects otherwise | A policy-less review handler registered into the real factory |
| **F7 / F40** | No `UPDATE`/`DELETE`/`TRUNCATE` grant on any append-only review table or on `platform.audit_anchor` | `GRANT UPDATE ON content.review_candidate_shown TO questionbank_app`, rolled back |
| **F6 / F35 (ADR-0009)** | Every review route is inside the enumerated authoring family; every non-authoring schema carries no key | A review route mounted at `/v1/review/**`; a key-bearing field on a delivery DTO |
| **F15** | No `fetch` outside the generated client, now including the review workspace | A `fetch('/v1/authoring/review/next')` in a workspace component |
| **F24** | No colour literal outside the token modules | A hex literal in the decision bar |
| **Edit scope closed** | `EDITABLE_UNDER_REVIEW` ∪ `FORBIDDEN_UNDER_REVIEW` covers every mutable `ItemVersion` field | A new `ItemVersion` field in neither list |
| **`ReviewProgress` is gone** | The port and its in-memory implementation exist nowhere in the tree | A re-introduced `ReviewProgress` interface |

- **F1, F2, F5, F6/F35, F9, F11, F16, F18, F20, F24, F26, F36, F39, F45–F48 and the whole M0/M1/M2/M3 set re-run green — not assumed.** M4 adds directories inside the largest context and three columns to a platform table
- **Coverage thresholds under ADR-0008** for M4-02, M4-04, M4-05, M4-07, M4-08, M4-09, M4-11, M4-18, M4-19, M4-22, M4-28, M4-29, M4-30 — each at 100%, **each verified failing before it passes**
- `content-rules.spec.ts` polices its own list, as it already does: it fails if an in-scope module has no threshold, if a threshold is below 100, or if a named module was deleted without the list being updated
**Tests** Every row green on the real tree and red on its fixture · thresholds asserted present · the full prior fitness set re-run

### M4-43 · The seeded review corpus — 200 items, planted pairs
**Objective** A queue to review, a duplicate to catch, and a tamper to detect — all deterministic.
**Files** `apps/api/src/testing/review/corpus-200.ts`, `review-corpus.integration.spec.ts`
**Acceptance**
- 200 submitted items **generated deterministically from a seeded builder** — a hand-written corpus is unreviewable and would rot (M3-45's reasoning)
- Spread across ≥ 3 subjects and ≥ 20 concepts, so batching and subject scoping have something real to do
- **Planted, each asserted by exactly one test:** a constants-swapped pair (must pair by skeleton hash), an exact retype (exact hash), a near-miss that must appear **only** in the trigram group, a self-authored item for the claiming reviewer (must never be offered), an item aged past escalation, and an expired claim
- The corpus is the fixture M4-44's instrument and M4-38's interaction-cost test both run against, so the three numbers describe the same population
- Completes within the per-commit test budget; if it cannot, the count is justified in the spec rather than quietly reduced
**Tests** Integration: the corpus builds identically across 100 runs · each planted case detected by its own assertion · **a planted failure to detect the constants-swapped pair fails the suite**

### M4-44 · The throughput instrument & the timing protocol (DEC-M4-5)
**Objective** Build the measurement, prove it, and report that it has no subject. **Tier 1 instrument · Tier 2 protocol · Tier 3 criterion.**
**Files** `apps/api/src/testing/review/throughput.spec.ts`, `apps/studio/src/features/review-workspace/interaction-cost.spec.tsx`, `docs/tasks/M4-REVIEW-TIMING-PROTOCOL.md`, `apps/api/src/fitness/timing-protocol-rules.ts` + spec
**Acceptance**
- **Tier 1 — the instrument.** `GetReviewerThroughput` (M4-33) computes items/hour from `decided_at`, proven against synthetic timestamps whose arithmetic answer is known: one reviewer, three reviewers, and a session with a gap. Reported as **`Instrument proven / no subject`**, M0-25's exact formulation
- **Tier 1 — interaction cost.** Over the M4-43 corpus in jsdom: ≤ 1 keystroke per decision on the approve path, 0 reveal-clicks, 0 navigations across 20 consecutive decisions
- **Tier 1 — machine time.** p95 of claim → payload → decide ≤ 300 ms against real Postgres over the seeded queue, with the measured number **written to a file** and not estimated (M0's bundle-size method)
- **Tier 2 — the protocol.** `M4-REVIEW-TIMING-PROTOCOL.md` states the session design (3 reviewers, the 200-item corpus, 60 minutes, warm-up excluded, the exact query, how a partial session is reported). **A spec parses it** and asserts every command, query name and file path it mentions exists — red on a planted dangling reference
- **Tier 3 — the criterion.** `≥ 40 items/hour` is **`Fail — blocked`**, missing resource: a reviewer pool. DEC-M4-5's sentence is reproduced verbatim, and **M4-45 asserts the close-out contains it**
- **The three Tier-1 numbers are never summed, averaged, or presented under the gate's name**, and the spec's header says so
**Tests** Unit + integration: the instrument's arithmetic on four synthetic sessions · interaction-cost assertions · the p95 measurement written and read back · the protocol parse, red on a planted dangling reference · **a spec asserting the phrase "40 items/hour" appears in this repository only alongside "Fail — blocked"**

### M4-45 · Traceability, ADRs, close-out & handoff
**Objective** The milestone's record, with every blocked line still blocked.
**Files** `docs/tasks/M4-TRACEABILITY.md`, `docs/tasks/M4-CLOSEOUT.md`, `docs/HANDOFF-M5.md`, `docs/adr/ADR-0018…ADR-0022`, `docs/ROADMAP.md`
**Acceptance**
- **ADR-0018** (approve-with-edits keeps the author), **ADR-0019** (the review workspace lives inside content), **ADR-0020** (the audit chain), **ADR-0021** (duplicate detection), **ADR-0022** (`ItemDefect`/`AnswerKeyChallenge` move to M5) merged
- **ADR-0009 confirmed unamended** (DEC-M4-12 is why); **ADR-0010 confirmed honoured** — M3 owns the machine, M4 owned the workspace, and the workspace's placement inside content is recorded as compatible with, not a departure from, that split; **ADR-0015 amended in place** (M4-30)
- `M4-TRACEABILITY.md` maps every acceptance criterion to the test that proves it, with a **Findings table** marking every partially-proven and blocked criterion — M0's and M3's format
- `M4-CLOSEOUT.md` carries the DoD verdict below verbatim, the five ROADMAP criteria with their honest statuses, the deliverables **deferred** with ADR-0022 named, the new debt (**D35, D36**), and the debt closed (**W4**)
- **The traceability document's criterion list is asserted equal to this document's**, so a criterion cannot be quietly dropped between the two (M0-27's method)
- `HANDOFF-M5.md` written from scratch, naming M5 as next, what M4 cleared, what it deferred **into M5's own scope**, and what it did not clear
- **ROADMAP amended**: M4's line records the corrected lifecycle split (**D20**, open since M3) and the two deferred deliverables. The ROADMAP edit follows the ADRs, as ADR-0010 said it should
- **B1 restated** — see below
**Tests** Unit: the criterion-list equality spec, red on a dropped criterion · a spec asserting the close-out contains DEC-M4-5's sentence verbatim · a spec asserting every ADR referenced by this document exists

---

## Sequencing

```
Week 1   B13→B16 (stateEnteredAt, subject, editedBy, queue query)  ║ A01→A05 (skeleton, assignment, ordering, ageing)  ║ ratification
Week 2   A06→A12 (taxonomy, decision, edits, fingerprints, events) ║ B17, B18 (schema, atomic claim)                   ║ C22, C23 (audit link, chain)
Week 3   B19→B21 (decision repo, fingerprints, grants)             ║ C24, C25 (anchor, F41)                            ║ D26→D30 (policies, claim, decide, W4)
Week 4   D31→D35 (sweep, duplicates, queries, anchor, barrel)      ║ E36, E37 (API)                                    ║ F38, F39 (workspace, decisions)
Week 5   F40, F41 (duplicates, ops surface) ║ G42, G43 (gates, corpus) ║ G44, G45 (instruments, close-out)             ║ hardening
```

**Critical path:** B13 → B16 → B18 → D27 → D28 → E37 → F38 → F39 (~17 days). The queue's candidate source
gates the claim, which gates the decision, which gates the only surface that matters.

**Second path, and it must start in week 1:** A01 → A02 → A07 → A08 → D29 (~14 days). **The content model
changes are still the milestone's real risk** — nothing about the queue is buildable until content can say
which items are waiting, since when, and in what subject. Starting Track B in week 3 makes everything late.

**Start C22/C23 in week 2, not week 4.** The audit chain is the only task with two implementations of one
hash (TypeScript and SQL); if they diverge, that is a fact worth having in week 2 rather than week 5, and
nothing else depends on it, so it can absorb the slip.

**Five weeks, not four, and not six.** ROADMAP allocates 4 weeks at 3 engineers. The first pass estimated 6
for 51 tasks; deferring `ItemDefect`/`AnswerKeyChallenge` removes four tasks, and **DEC-M4-7 removes more
than it appears to** — the facade, the cross-context adapters, a fourth context's skeleton, barrel and
composition wiring, a duplicate `Result`/error taxonomy, and a two-context transaction. **45 tasks, 5 weeks.**
If 4 weeks is fixed, the honest reduction is **M4-41** (the Content Ops surface, leaving escalations visible
only through the API) and **M4-11/M4-14's QC sampling**, which §C.6 needs but no M4 acceptance criterion
does. That is a scope decision for ratification, not one to make silently in week 4.

**Blocked, and known before we start:** the 40 items/hour gate, external notarization of the daily anchor, and
every scheduled invocation. None is on the critical path, because none is achievable at any point along it.

---

## Milestone Definition of Done

A task is done when merged with tests green. **The milestone** is done when all of the following hold.
**Six lines are marked blocked before work begins**, because their blockers are known now.

### Delivered and proven here (Tier 1)

- [ ] All 45 tasks merged
- [ ] **A reviewer claims, decides and auto-advances through the seeded 200-item queue** against the real composed application and real Postgres, every decision writing the record, the citations and the assignment closure **in one transaction**
- [ ] **Self-review is impossible at assignment, at decision and at publication** (INV-12) — through **one function with three enumerated call sites**, each proven against a planted violation
- [ ] **Every published item carries a reviewer signature** — unchanged from M3, re-proven end to end through M4's path, including approve-with-edits where the signer is not the editor
- [ ] **Audit chain verification detects a planted tampering** — a mutated field, a deleted link, a swapped pair and a forged tail, each with the correct divergent sequence, each planted as superuser inside a rolled-back transaction
- [ ] **F41 green over a non-zero record count** — a chain verifying over zero rows fails the gate
- [ ] **Duplicate detection catches same-question-different-constants** — the planted pair in the M4-43 corpus, by skeleton hash, with option re-ordering normalized away
- [ ] **Duplicate detection is advisory and reachable from no transition handler**, asserted by import graph
- [ ] **W4 closed by deleting `ReviewProgress`**, not by supplying an adapter; withdrawal after a claim is refused, permitted after lease expiry, and the claim/withdraw race resolves to exactly one winner. **ADR-0015 amended in place**; the M3 test rewritten, not removed
- [ ] **Approve-with-edits records both versions**, the author stays the author, and an out-of-scope edit is refused with the field named (ADR-0018)
- [ ] **Ageing escalates to Content Ops without reassigning; an expired lease releases automatically** — both proven at, either side of, and far from every threshold
- [ ] **The review sub-boundary holds** — `authoring/` imports nothing from `review/`, proven against a planted violation in both directions (DEC-M4-7's mitigation, and the reason co-location is not entanglement)
- [ ] **Authorization negative paths at 100%** — every review command refused for every unauthorized role, and a policy-less handler fails boot (F36)
- [ ] **Review routes sit inside ADR-0009's existing enumerated authoring family**, asserted in both directions; a planted `/v1/review/**` route fails
- [ ] **Grants hold** — no `UPDATE`/`DELETE`/`TRUNCATE` on any append-only review table or on `platform.audit_anchor`, by catalogue set equality extending M0-24's list (F7/F40)
- [ ] **F1, F2, F5, F6/F35, F9, F11, F15, F16, F18, F20, F24, F26, F36, F39, F45–F48 still green** — re-run, not assumed
- [ ] **Every M3 test that touched the review seam passes unchanged or was rewritten with its new truth** — the lifecycle matrix, the publication preconditions, `review-decision.spec.ts`, the decision repository suite
- [ ] **100% coverage on every correctness-bearing review module** per ADR-0008, each verified failing first; ≥ 80% line / ≥ 70% branch overall
- [ ] Accessibility scan clean on every M4 Studio surface; the workspace fully keyboard-operable with no mouse-only or keyboard-only decision
- [ ] **The throughput instrument is proven with synthetic sessions and reported `Instrument proven / no subject`**

### Authored and asserted, claiming nothing more (Tier 2)

- [ ] **`M4-REVIEW-TIMING-PROTOCOL.md`** — the timed-session design, with every command, query and path it names asserted to exist, red on a planted dangling reference. **It is a protocol, not a result, and its header says so**
- [ ] ADR-0018, ADR-0019, ADR-0020, ADR-0021, ADR-0022 merged; ADR-0009 confirmed unamended; ADR-0010 confirmed honoured; **ADR-0015 amended in place**; ROADMAP M4's line amended per **D20** and ADR-0022

### Blocked — marked so now, and not to be narrowed until they pass (Tier 3)

- [ ] **A reviewer sustains ≥ 40 items/hour on seeded content** — **`Fail — blocked`**: no reviewer pool exists. Nothing in M4 measures human throughput. Nearest evidence, reported under their own names and never under this one: ≤ 1 keystroke per decision, 0 reveal-clicks, 0 navigations; p95 claim→decide ≤ 300 ms; auto-advance served from prefetch. **Successor: the M4-44 protocol, run with three reviewers**
- [ ] **The daily anchor is externally witnessed** — **`Fail — blocked`**: no network, no timestamping authority, no second party. The anchor is sealed and HMAC-signed locally, which bounds an attacker to one holding both database write and process configuration. **This is not notarization and is never described as one.** Successor: publish `head_hash` to an external witness
- [ ] **The ageing sweep, the sampler and the anchor run on a schedule** — **`Fail — blocked`**: no scheduler, no deployment (**D36**). Each is a command with a handler, driven directly in tests
- [ ] **An event emitted by the review area is consumed by anything** — **`Fail — blocked`**: no outbox relay exists (**D35**). Events are written transactionally and verified in the table; nothing reads them
- [ ] **`docker compose up` ≤ 10 min · a Grafana trace · a staging deploy · CI gates blocking** — all four **still `Fail — blocked`**, unchanged from M0, restated here rather than dropped

### Deferred, carried and limited

- [ ] **`ItemDefect` intake and triage — deferred to M5 (ADR-0022)**, trigger: the first published item a reviewer or author needs to report against. ROADMAP lists it under M4; the divergence is recorded, and the ROADMAP edit follows
- [ ] **`AnswerKeyChallenge` intake and adjudication — deferred to M5 (ADR-0022)**, trigger: the first disputed key on a published item, or M9's learner-facing surface, whichever comes first
- [ ] **D25 travels with the challenge to M5** — a published item still cannot be revised, so an upheld challenge's only remedy remains `suspend`. Recorded where the work now lives, rather than as an M4 limitation nobody owns
- [ ] **"An author produces a stimulus-linked set in ≤ 20 min"** — **still `Fail — blocked on D29`**, unchanged. M4 did not pay for the Item Editor's wiring and does not claim this
- [ ] **D23 unchanged** — the queue routes on the subject the author declared, and a mistagged item reaches the wrong pool undetected. Trigger unchanged: Curriculum exposing a concept → subject lookup
- [ ] New debt recorded: **D35** (no outbox relay), **D36** (no scheduler) — each with a named trigger
- [ ] **B1 carried forward and restated** — M2-30, the golden set validated against zero real papers, remains blocked on [DECISIONS §D item 2](../DECISIONS.md) (content licensing & IP policy) and legal counsel sign-off. The decision is one sentence: *may released papers with official NTA keys be held in this repository as internal test fixtures, not served to learners?* **Do not attempt to source papers.** It appears in the M4 close-out and in every handoff until it closes

---
