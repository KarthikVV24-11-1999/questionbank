# ADR-0019 — The review workspace lives inside the content context
Status: Accepted
Date: 2026-08-26

## Context

M4 builds a review workspace: a claim, a lease, an assignment, an ageing sweep, duplicate
detection, a decision, and the Studio screen a reviewer works in. The first shape proposed for
this was a **separate bounded context** — `contexts/review/` beside `contexts/content/`, with its
own aggregates, its own repositories, its own composition root and its own barrel.

That reading is defensible on the surface. Review has its own vocabulary (assignment, lease,
escalation, duplicate candidate), its own actors (reviewer, Content Ops), and its own lifecycle
that is not the item's lifecycle. It looks like a context.

It is not one, and the reason is specific rather than stylistic. A separate context would have
had to reach into content for the thing every one of its operations is *about*:

- the claim's candidate predicate reads `content.item`, `content.item_version` and
  `content.item_taxonomy_tag`, and must exclude the version's author — INV-12, which is a
  content invariant
- a decision transitions the **item's** lifecycle state, which [ADR-0010](./ADR-0010-content-owns-the-lifecycle-state-machine.md)
  places squarely inside content and proves with an exhaustive 72-pair matrix
- `approve_with_edits` derives a new `ItemVersion` ([ADR-0018](./ADR-0018-approve-with-edits-keeps-the-author.md)),
  which is content's aggregate and content's constructor
- duplicate detection hashes the item's own stem and options through content's
  `projectContentBody`

Every one of those is a write to a content aggregate, in the same transaction as the review-side
write. A separate context would therefore have needed either a distributed transaction across two
contexts, or a "context" that shares content's tables and repositories — which is a directory
rename, not a boundary.

Against that sits a real concern the separate-context proposal was right about: **review must not
become a second, tangled half of content**. If review handlers reach into authoring queries and
authoring handlers reach into review repositories, the two grow together and neither can ever be
extracted.

## Decision

**The review workspace lives inside `contexts/content/`, as ordinary content plumbing, with a
sub-boundary that keeps it extractable.**

Concretely:

1. Review code lives at `contexts/content/{application,infrastructure}/review/**` and
   `contexts/content/domain/review/**`. It is content's code, in content's transaction, using
   content's repositories.

2. **A sub-boundary is enforced by a gate**, not by convention (`fitness/content-rules.ts`,
   rules `M4_01_REVIEW_REACHES_AUTHORING` and `M4_01_AUTHORING_REACHES_REVIEW`):

   - `authoring/` imports **nothing** from `review/`
   - `review/` reaches authoring only through `domain/**` and a **named, capped category** of
     context-wide shared contracts

3. **The sub-boundary governs `application/` and `infrastructure/` only, never `api/`**
   (amendment of 2026-08-26, recorded in the plan under DEC-M4-7). The HTTP edge is request and
   response translation; the coupling that blocks extraction lives in the write path, and that is
   where the gate applies. Narrowing what a ratified decision covers is recorded here rather than
   done quietly.

4. **The HTTP surface mounts inside the existing authoring family** — `/v1/authoring/review/**`,
   not `/v1/review/**` (DEC-M4-12). This is what keeps [ADR-0009](./ADR-0009-authoring-dtos-carry-the-answer-key.md)
   unamended: the review screen carries the answer key, because a reviewer verifying correctness
   must see which option is correct, and ADR-0009's enumerated key-bearing route list already
   covers `/v1/authoring/**`. A `/v1/review/**` prefix would have forced a second key-bearing
   family and a second enumeration to keep honest.

## Consequences

**What this buys.** One transaction for a decision and the lifecycle transition it drives, with
no distributed-transaction machinery and no eventual consistency between "the decision was
recorded" and "the item moved". One set of repositories. One composition root. ADR-0009 and
ADR-0010 both stand unamended.

**What it costs.** `contexts/content/` is now the largest context by a wide margin, and it holds
two families of code that a casual reader could mistake for one. The sub-boundary gate is what
stops that mistake becoming structural, and it is only as good as its planted violations — four
`M4_01_REVIEW_REACHES_AUTHORING` fixtures plus one for the reverse direction, each committed and
each proven red.

**The extraction path, if it is ever wanted.** Because `application/review/**` and
`infrastructure/review/**` cannot reach authoring's queries, handlers or repositories, and
authoring cannot reach theirs, moving them out is a directory move plus a new composition root —
not an untangling. That is the whole point of the sub-boundary, and it is the claim the gate
exists to keep true.

**Carried debt.** The shared-contract exemption list is **enumerated, not path-enforced** —
four named members, recorded in `content-rules.ts`'s own header. Its trigger is a proposed fifth
member: at that point the category is doing more work than a list should, and it needs a rule
rather than an enumeration.
