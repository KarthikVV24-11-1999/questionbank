# ADR-0050 — Immediate feedback serves a verdict on the learner's answer, and not the key

**Status** Accepted · M7 Track D, M7-29 · Extends [KEY-FREE.md](../KEY-FREE.md) with the `practice-feedback` surface

## Context

The key-free argument says no answer key, solution body or marking material reaches a learner before they submit. Practice (DOMAIN-MODEL D2, `PracticePolicy`)
has `feedbackMode: immediate`: the learner is told whether an answer was right straight after giving it, while the attempt is still open. That is the first
delivery path on which a learner sees *correctness* during an attempt, and so a surface the argument had not yet been asked about. Correctness is not the key —
but it is derived from it, and a surface that served the wrong part of the derivation would be a leak with a reasonable name.

## Decision

**Served:** one word about one answer the learner themselves gave — `correct`, `incorrect`, `unattempted` or `indeterminate` — with the attempt and slot it
is about. The response is built field by field and holds those three fields and no others.

**Withheld:** the key; the correct option or value; which option would have been right; the rule that decided and its explanation; the marks, since a practice slot
belongs to no form and carries none; the solution, which stays behind the effort gate Track E builds.

The answer judged is the one the response log's projection holds for the slot, so feedback and an eventual score cannot disagree about what was answered. The
verdict is scoring's: a handler (`JudgeSlots`) runs the same pure function that scores an attempt, writes no record and emits no event, and answers with a slot and
a word. Assessment decides nothing about correctness. Anything the judge returns that is not one of the four words is served as `indeterminate`, so a judge that
leaked could not reach the learner through this handler.

Feedback is given only for an attempt that pinned `feedbackMode: immediate`. A mock pins `deferred` and is refused, whatever is asked.

## Consequences

**Makes easy:** the surface has a row in the key-free table with two tests that run — one showing no key material in any feedback a run gives, over every verdict,
and one showing the scan finds each key field where one is held.

**Makes hard / not claimed:** a verdict on an answer is information about the key. A learner who changes their answer and asks again can learn which option was
right by elimination. That is what immediate feedback *is*, and the policy that asks for it accepts it for practice; it is not accepted for a mock, which is why
the pinned policy and not the caller decides. Rate-limiting repeated asks, and withholding the verdict on a slot until the learner has committed an answer to it
(already so: an unanswered slot is `unattempted` and nothing is asked of marking), are the levers if elimination becomes a concern.
