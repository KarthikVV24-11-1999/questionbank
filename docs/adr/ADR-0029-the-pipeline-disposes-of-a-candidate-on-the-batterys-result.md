# ADR-0029 — The pipeline disposes of a candidate on the battery's result, and an operator does not accept each one

**Status** Accepted · M5 Track H, M5-40 · Reverses a Track C decision

## Context

Track C made `AcceptCandidate` a `content_ops` act. The reasoning was that deciding is a human act and
the pipeline holds no capability to decide, so a person accepts each candidate before it becomes a
draft. That is right about *deciding* and wrong about *accepting*, and Track G showed the consequence:
accept and reject had no route, so in a composed deployment no candidate could ever be accepted at all.

Before adding the missing routes the question is what the architecture wants, and it answers plainly.

- **AI-ARCHITECTURE §13** puts one human stage in the pipeline: the **reviewer** sees, on one screen,
  the candidate, its solution, the pre-check results with rationale, the duplicate candidates and the
  grounding exemplars, and *anything requiring a second screen or a click costs seconds that multiply by
  60/hour*. An operator accepting each candidate before a reviewer sees it is a second human touch on
  every item.
- **AI-ARCHITECTURE §16** says that per-item human time dominates the economics M5 exists to prove. A
  second touch on every item is the cost the milestone is trying to remove.
- **§11** says a candidate that fails a blocking check never reaches a reviewer, and the ones that pass
  do. Nothing in it puts an operator between the two.

## Decision

**Disposition is the pipeline's, on the battery's result.**

- Every blocking check passed → the candidate is **accepted**: content's own handlers create a draft and
  put it into review.
- Any blocking check failed → the candidate is **rejected**, terminally.
- A blocking check has not run (a provider failure, a blocked check) → **nothing is decided**. A check
  that did not run is not a pass.

This is one function, `dispositionOf`, in the candidate's domain, built on the same `failedBlockingChecks`
that acceptance and the listing already use, so the three cannot disagree about what "failed" means.

**`DisposeCandidate` is the handler, and the battery calls it.** `RunPrecheckBattery` records the
verdicts and then disposes; its report gains a `disposition` (`accepted`, `rejected`, `undecided` or
`failed`). A disposition that fails does not undo the verdicts, which are the audit trail; the report
carries the error and a retry picks the disposition up, since verdicts already recorded are not run
again. Accepting and rejecting are the same two code paths the operator's override uses, so
`acceptCandidate`'s preconditions stand between the pipeline and any acceptance the verdicts do not
support.

**The operator's accept and reject remain, as a manual override, and now get routes**
(`POST …/generation-candidates/{id}/acceptance` and `…/rejection`, `content_ops` only). The pipeline path
is the default, not the only one.

### Why the pipeline's accept capability is not a decision capability

`DISPOSE_CANDIDATE_POLICY` admits `generation_pipeline` and says why: the handler carries out a result
the verdicts already hold. It forms no judgement. It cannot accept what `acceptCandidate` would refuse,
and it can reject only a candidate that failed a blocking check. The pipeline gets no `AcceptCandidate`
or `RejectCandidate` — admitting it to those would let it reject anything — and no read of a candidate.

### Why this does not weaken INV-01, D8 or F27

Content's own handlers perform every write, under content's own policies, and what they write is a
**draft awaiting review**, not published content. F27 — no code path writes a `content.*` table from the
AI Service — is satisfied as before. M5's criterion is zero AI content **published** without a recorded
human approval, and publication still requires the reviewer's signature, which M3's publication
preconditions enforce and nothing here touches. The end-to-end test shows a candidate arriving
`in_review`, with no review decision recorded against it.

### What content had to admit, and the one gap that closes with it

"No human before the review queue" requires the pipeline to be admitted to two of content's handlers:
`CreateItemDraft` and `SubmitItemForReview`. A spec over content's whole composed registry holds the set
of handlers that admit `generation_pipeline` to exactly those two and the duplicates query M5-33 already
admitted (precedent: ADR-0027, M5-35). Authoring is scoped by subject (FR-TCH-01 rule 1) and the pipeline
is not cross-subject, so **the pipeline's token must carry the `subject:<x>` scopes it generates for**;
a pipeline without one is refused by content and the disposition fails closed.

Admitting a machine to submit exposed an existing gap: `SubmitItemForReview` checked the role but, unlike
update, derive and delete, not the draft's owner (FR-TCH-06 rule 1). That was harmless while only humans
were admitted and is not once a machine is: it would have been able to push any author's unfinished draft
into the queue. The handler now carries the same ownership check, with a spec that fails without it.

## Consequences

- D46 closes: a candidate that failed a blocking check is rejected terminally, so M5-39's listing filter
  guards a state the normal path no longer reaches.
- **D40 widens.** Accepting is not atomic across the context boundary, and it is now automatic: a failed
  save after content took the draft leaves a `proposed` candidate that the next battery run would dispose
  of again, creating a second draft. D40 records the exposure; the trigger it names is now the likelier.
- The battery refuses a candidate that is no longer `proposed`, so a run after a disposition is not a
  second chance at a draft.
- `AcceptCandidate`/`RejectCandidate` routes are authoring-family routes (ADR-0028), added to
  `x-authoring-routes`; `DisposeCandidate` has none, as the pipeline's act off any request path.
