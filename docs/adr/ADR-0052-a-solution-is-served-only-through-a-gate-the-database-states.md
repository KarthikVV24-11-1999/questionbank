# ADR-0052 — A solution is served only through a gate the database states

**Status** Accepted · M7 Track E, M7-36 and M7-37 · Extends [KEY-FREE.md](../KEY-FREE.md) with the `solution-delivery` surface

## Context

Content already projected a solution for delivery and no learner-facing route served one. Every existing key-free row asserts a solution is absent; this surface exists to deliver one,
which is the first time the argument is asked to hold a thing present *and* absent depending on a condition.

## Decision

**The gate is a view.** `assessment.solution_release` has one row per attempt slot and says whether it is released: the slot's own events include a `select`, a `change` or a `skip`
(a `visit` is not effort; a `clear` neither grants nor revokes it), and the attempt is submitted or pinned `feedbackMode = immediate`. Per slot, never per attempt. The rule is written once,
in SQL, over stored facts; no handler counts events or assembles a boolean.

**Mock and practice differ by the pinned delivery, not the mode.** Both are "after effort". A mock pins `deferred` and so also waits for submission; a practice run pins `immediate` and
a slot opens as it is attempted or skipped. Reading the pinned policy keeps the difference a fact on the row, true for every row (DEC-M7-17).

**It cannot be walked around.** A solution is fetched with a `ReleasedSlot`, a branded type only the repository over the view makes; the solution source takes nothing else. A fitness
rule fails a second constructor and a second caller, each proved against a planted file.

**What is served.** `GET /v1/assessment/attempts/{attemptId}/slots/{slotId}/solution`, in reading order: why the tempting wrong answers are wrong, then the method, then other
approaches — as sections, so the order is the content and not an accident of field order. The first section and the last need the full depth, which is entitled (a `basic` request is the derivation and is
not withheld, INV-08). A refused request is the same whether or not the question has a solution. Hints (AI-ARCHITECTURE's three tiers) are not this and are not here.

## Consequences

**Makes easy:** the `solution-delivery` row has two tests that run — no solution text while the gate is shut, on any slot of any attempt, and the same scan finding it once open.

**Makes hard / not claimed:** the gate is a floor on effort. A learner may skip every question to read every solution; the practice flow accepts that, and a rate limit on skipping is the lever.
