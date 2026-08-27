# ADR-0018 — Approve-with-edits keeps the author
Status: Accepted
Date: 2026-08-20

## Context

FR-QM-03 and UX §10.2 both name `approve_with_edits` as a review outcome: a reviewer fixes a
small problem — a typo, a difficulty band that's obviously wrong, an ambiguous phrase — and
approves in the same action, rather than sending the item back for a second round-trip through
the author. M3's lifecycle machine and `ReviewDecision` (M3-11) already support the outcome as a
name; nothing yet produces the version it approves.

The obvious implementation is wrong, and DEC-M4-3 (`M4's plan`) already worked out
why, before this task: M3's `checkPublishable` refuses publication when
`signature.reviewer === version.authoredBy` (INV-12). If `approve_with_edits` produced a new
`ItemVersion` **authored by the reviewer** — the obvious reading of "the reviewer wrote this
version now" — that version could never be published by the reviewer who just approved it. The
feature would defeat itself at the last step: the one reviewer who has the context to sign off
immediately is the one INV-12 forbids from doing so, because the derivation itself made them the
author.

A second question sits underneath the first: what is a reviewer allowed to change under this
outcome, and what happens when they try to change more? UX §10.2 requires the edit to be
"bounded," but the milestone's own decisions record (DEC-M4-3) is not self-enforcing — a
sentence in a markdown file does not stop a handler from accepting a `responseSpec` change.

## Decision

**The edit produces a new version, never a mutation.** `deriveReviewerEditedVersion(from,
props)` follows the same shape `deriveDraft` already established for the ordinary edit path —
INV-03 (published versions never change) and the audit chain both forbid amending a version in
place regardless of who is doing the amending.

**`authoredBy` is carried over from `from`, untouched. `editedBy` is a new, distinct field on
`ItemVersion`, set only by this function.** `authoredBy` answers *whose subject-matter work is
this* — the question INV-12 actually needs answered — and a reviewer who fixes a typo does not
become the author of the item any more than a copy editor becomes a novel's author. The version's
provenance stays honest: it still says who wrote the physics, chemistry, or mathematics: the
reviewer's contribution is recorded, not substituted in as if it were the whole thing.

**The edit scope is closed, shared, and enforced by one function — not duplicated.**
`domain/review/edit-scope.ts` (M4-08) already defines `EDITABLE_UNDER_REVIEW` (`stem`, solution
prose, accessibility text, taxonomy tags, difficulty estimate) and `FORBIDDEN_UNDER_REVIEW` (the
response spec, item type, provenance), plus `diffWithinScope`, the one function that checks a set
of changed field names against that vocabulary. `deriveReviewerEditedVersion` calls it directly
rather than re-deriving the same bound: whichever of `stem`, `taxonomyTags` and
`difficultyEstimate` a caller actually supplies is checked; `responseSpec` is accepted as a
parameter only so a caller who supplies one is refused by name
(`KEY_EDIT_REQUIRES_CHANGES_REQUESTED`, naming `request_changes` as the correct outcome instead)
rather than silently ignored; `itemType` and `provenance` have no parameter at all — the closed
half of the bound a runtime check could not make any more closed.

**INV-12 is extended through the one function that already enforces it, not a second
implementation.** `isSelfReview` (M4-04, `domain/review/self-review.ts`) already checks a
principal against both `authoredBy` and an (until now, always-absent) `editedBy`. Once
`ItemVersion.editedBy` is real, `checkPublishable`'s existing call —
`isSelfReview(version, signature.reviewer)` — refuses a reviewer who edited a version from also
signing it, with **no change to `publication-preconditions.ts` at all**. That absence of a diff
is the proof the milestone's own rule ("one shared function, three call sites, a second
implementation fails the milestone") held under real pressure rather than merely being stated.

**No second reviewer is required.** Requiring one would halve throughput for the commonest case
approve-with-edits exists to speed up, and the edit-scope bound — closed, shared, enforced — is
what makes a second signature unnecessary: nothing a reviewer can change under this outcome is
consequential enough to need independent verification the way the key or the provenance would.

**D25 is not on this path, and its trigger does not move because of this task.** `addVersion`
(and, by the same reasoning, `deriveReviewerEditedVersion`) operates on an item still in
`in_review`, whose version is pre-publication — exactly what `addVersion` already permits.
Correcting a version that has **already published** is a different problem, blocked on D25, whose
trigger travels with the answer-key challenge to M5 (DEC-M4-6). `editedBy` and the edit-scope
check are ordinary content work this task does now; revising a published item stays exactly where
it was.

## Consequences

**Makes easy:** the decision handler (M4-27+) can call `deriveReviewerEditedVersion` and
`checkPublishable` in sequence with no coordination between them — the self-review refusal a
reviewer-edited-and-signed version would need is already there, inherited rather than added.

**Makes hard:** nothing new. The edit surface is deliberately small; a reviewer who needs to
change more than `EDITABLE_UNDER_REVIEW` allows is already using the right outcome
(`request_changes`), not fighting a limitation.

**Forecloses nothing new.** `ReviewOutcome`, `REVIEW_OUTCOMES` and `toReviewerSignature` (M3) are
untouched — `approve_with_edits` was already a named outcome; this task gives it something to
produce.

## Alternatives

**The reviewer becomes the author of the derived version.** Rejected — this is the design DEC-M4-3
already rejected, restated here because it is the one every naive implementation reaches first:
it makes `approve_with_edits` self-defeating under INV-12, and it is a provenance lie in the
other direction — the reviewer did not write the item, they adjusted it.

**A second reviewer signs off on every edited version.** Rejected — see DEC-M4-3 point 4. Halves
throughput on the case the outcome exists to speed up, for a bound that closed edit scope already
makes unnecessary.

**A fresh, ad hoc scope check inside `deriveReviewerEditedVersion` instead of calling
`diffWithinScope`.** Rejected outright, not merely as an inferior option: M4's own rule is that a
second implementation of one bound anywhere fails the milestone, and edit scope is exactly the
kind of rule that drifts silently between two copies — one gains a field, the other doesn't, and
nobody notices until a reviewer edits the key.
