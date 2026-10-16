# ADR-0025 — Generation depends on Content, never the reverse
Status: Accepted
Date: 2026-10-16

## Context

M5 introduces `contexts/generation/`. Before a line of it exists, the direction of the coupling
between it and `content` has to be settled, because it is the one thing that cannot be changed later
without rewriting both.

**Two approved sources say different things.**

[ARCHITECTURE](../ARCHITECTURE.md) §8 describes the anti-corruption layer as content-side: *"the AI
Service emits `GenerationCandidate` rows in the `ai` schema. A **Content-side handler** translates
accepted candidates into draft items."* Read literally, `content` reaches into `ai.*`, which means
content knows generation's schema, its candidate lifecycle, and when a candidate is accepted.

`contexts/content/m5-seam.spec.ts`, written at M4-35 and green ever since, builds the opposite and
is executable rather than descriptive. It asserts that content's barrel exposes exactly three things
**for M5 to consume**: `SubmitItemForReview` (the same command a human author's draft goes through),
`ReviewOutcome`/`REVIEW_OUTCOMES`, and `RejectionReasonCode`/`REJECTION_REASONS`. Its header states
the intent plainly — *"A missing export here is a compile failure in this file, not something M5
discovers by reaching past the barrel."* That is a contract written from generation's side, pointing
inward at content.

Both cannot be true. One of them has to be recorded as the loser rather than left for whoever writes
the first handler to resolve by accident.

## Decision

**`generation` depends on `content`, through `content/public/` only. `content` does not know
`generation` exists.**

An accepted candidate becomes a draft by generation issuing content's **existing** authoring command
across the barrel. There is no content-side reader of `ai.*`, no content import of a generation
module, and no second review queue — the generated candidate joins the same queue a human author's
draft joins, which is what `m5-seam.spec.ts` already set up and what DEC-M4-7 means by reviewing
being content's own authoring surface.

Four reasons, in order of weight.

**1. One side is shipped and executable; the other is prose.** `m5-seam.spec.ts` has been green since
M4-35 and fails to compile if the contract breaks. ARCHITECTURE §8's sentence has never been
executed by anything. Where a document and the shipped tree disagree, the tree is the finding.

**2. The content-side reading inverts the dependency and makes content undeployable alone.** A
handler in `content` that reads `ai.generation_candidate` needs generation's schema, its acceptance
semantics and its migration order. `content` is M3/M4's core and is deployed today with no AI
anywhere; coupling it to a context that does not yet exist, to serve a feature it does not have,
costs it its independence permanently.

**3. It is strictly more faithful to F27.** F27 reads *"no code path writes a `content.*` table from
the AI Service."* Generation issuing `SubmitItemForReview` means generation writes **nothing** —
content's own handler performs every write, under content's own authorization and invariants, exactly
as it does for a human author. The content-side reading satisfies F27 too, but only by moving the
write; this satisfies it by never granting generation the capability in the first place, which is
what SEC-20 relies on: *"the AI Service holds no capability to write Content aggregates, so a
successful injection has nothing to reach."*

**4. The boundary is already policed in this direction.** F1 permits and checks
`generation → content/public/`. The reverse needs a new permission and a new coupling.

**ARCHITECTURE §8's "Content-side handler" is superseded by this ADR.** The paragraph's other claims
— queue separation, no RPC from a student path, provider abstraction owned by the AI service, the
`ai` schema, no code path to `content.item_version` — all stand unchanged.

## Consequences

**Makes easy:** `content` needs no change at all for M5 — not an import, not a handler, not a
migration. The seam it already exposes is the whole interface. Generated items inherit content's
authorization, its publication preconditions, its review queue, its audit trail and its lifecycle
machine without any of it being re-specified or re-implemented for AI content.

**Makes hard:** generation cannot hand content anything content's commands do not already accept. A
candidate carrying a field the authoring command has no slot for requires a change to content's
command, reviewed on content's terms — which is the cost of the barrier and also the point of it.

**Enforced, not stated.** `checkGenerationIsDownstreamOnly` (`fitness/generation-rules.ts`) fails the
build if any other bounded context imports `contexts/generation/`, by any path including its barrel.
It is proven against a committed planted violation. Until `contexts/generation/` exists, its status
is `Pass (rule proven) / no subject` — the same honest posture F26 takes for the attempt engine, and
the reason the gate is written **before** the context rather than retrofitted after it.

**Forecloses:** a future where content reads generation's output directly. If that is ever wanted —
say, a content-side dashboard over candidate quality — it goes through a query on generation's
barrel and this ADR gets superseded, deliberately, rather than eroded by one import.

## Alternatives

**Follow ARCHITECTURE §8 literally: a content-side handler reading `ai.*`.** Rejected on reasons 2
and 3 above. It also strands `m5-seam.spec.ts`, which would become a contract nobody consumes —
green, meaningless, and exactly the vacuous-green pattern this repository keeps naming.

**Both directions, through an events seam: generation publishes, content subscribes.** Rejected as
premature. It is the shape the outbox would eventually give for free, but nothing drains the outbox
today (debt **D17**), so "content subscribes" would mean content polling a table generation owns —
the content-side reading with extra steps and a worse failure mode.

**Leave it undecided and let the first handler settle it.** Rejected: that is how the two sources
came to disagree in the first place, and the cost of getting it wrong is not a refactor but a
re-architecture of a context's dependency direction.
