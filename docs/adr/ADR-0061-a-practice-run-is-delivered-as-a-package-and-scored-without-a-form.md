# ADR-0061 — A practice run is delivered as a package of its own, and a submission with no form is scored

**Status** Accepted · M8 Track F, M8-23 to M8-26 · Records DEC-M8-13, DEC-M8-14 and DEC-M8-15 (docs/IMPLEMENTATION-DECISIONS.md) · Closes D87 and D77 (docs/DEBT.md)

## Context

Nothing a learner did in practice changed what the product knew about them. Two gaps stood between the one tap and a concept's state. No route gave a learner a run's questions, so the app started a run it
could not show (D87). And a submission with no form was not scored: scoring marks a form, `AttemptSubmitted` named one, and a run has none, so no score record was written and no evidence reached Learning (D77).

## Decision

**A run's questions are a signed package, served by the mechanism a form's is** (DEC-M8-13). The same bytes-not-JSON discipline, the same canonical form, the same Ed25519 key, never unsigned, and the same
service worker cache. A plain JSON route would have been quicker and would have bypassed the signature, the cache and the key-free scan, leaving an offline run as a second delivery runtime with its own bugs.
The route is `GET /v1/assessment/practice-attempts/:attemptId/package`, deliberately not under `/attempts`, which the service worker never caches.

It is one learner's run, so it is private. A form's package is byte-identical for everyone entitled to the form, and this one is made from the slots of one attempt: another learner's, and one that does not
exist, are the same 404 with no bytes. The digest is still the identity of the bytes, but the bytes are the attempt's. A run that grows (`practice-items`) has more slots, so a different package and
digest; the route revalidates every time, a device holding the old digest is given the new bytes, and the service worker takes the network's copy when it has one. Serving the package is not a delivery: the
exposure ledger counts a practice item when its slot is appended (the database refuses a practice slot without its ledger row), and reading the package writes nothing.

**A form-free submission is its own event** (DEC-M8-14). `PracticeAttemptSubmitted` names no form and no section. `AttemptSubmitted` keeps its required `formId` and `schemaVersion: 1`. A nullable
`formId` was the alternative; a consumer written for papers reads that field and would dereference a null, which it cannot tell from a fault, so the distinction belongs in the relay's map from type to consumer. A
second consumer scores a run.

What scoring read the form for is the slots to mark and what each is worth. A run holds its own slots, so the first needs no form. The second does not exist for a run: a form's slot carries the marks
its blueprint gave it, and a run's has none. Nothing is invented for it. A slot is worth what the exam profile the run pinned pays per item, when every section pays the same whole number (`marksPerItem`, from
curriculum); where the sections differ there is no single answer for an item that belongs to no section, and the delivery fails loudly with `PRACTICE_MARKS_UNDEFINED` and goes to the dead letters rather than to a
zero (D110). A run has one section, ordinal 1, that stands for nothing in the profile, so the profile's best-of, which names sections of a paper, is not passed on. Rounding and the floor are. A run has no total
marks and no pass mark; the score record's total is the sum of what its slots are worth. Learning needed nothing new: it assembles evidence from what scoring says happened to each slot and what content says the
item is about, and a run's evidence arrives through that same port, as `mastery-evidence.ts` already said.

**The learner sits a run on the screen a paper is sat on** (DEC-M8-15). The session, the response log's writer, the group commit and the send-after-commit ordering are used and not rebuilt. What differs is
stated: a run has no deadline, so the session takes `null` for it, shows no clock, and nothing submits it; it can be put down and picked up. The device record gains a nullable deadline, and a run is recognised as
untimed by having no duration, so a timed attempt the server reports no deadline for is still resumed against the record's.

## Consequences

**Makes easy:** a new kind of attempt that is delivered is a package format and a handler; a new submission with a different shape is a type, a consumer and a line in the relay's map, and a rule fails the build if the line is missing.

**Makes hard:** two scoring consumers share code by convention and not by construction; a profile whose sections pay differently for an item cannot score a run until the question of what a run's item is worth is answered for it (D110).

**Not done,** and entered as debt: the screen does not show the verdict the feedback route gives, and a run cannot be grown from the app (D111 in docs/DEBT.md).
