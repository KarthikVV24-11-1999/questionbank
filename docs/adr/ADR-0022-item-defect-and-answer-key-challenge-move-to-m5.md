# ADR-0022 — `ItemDefect` and `AnswerKeyChallenge` move to M5
Status: Accepted
Date: 2026-08-26

## Context

[ROADMAP.md](../ROADMAP.md) lists **"`ItemDefect` intake and triage"** among M4's deliverables,
and M3's scope table assigns **`AnswerKeyChallenge`** to M4 as well. M4 shipped neither.

That is a divergence from an approved document, and it is recorded here rather than absorbed
silently. A task breakdown that quietly drops an approved deliverable is how the next reader
learns the roadmap cannot be trusted — the same reasoning [ADR-0010](./ADR-0010-content-owns-the-lifecycle-state-machine.md)
applied when the lifecycle machine moved from M4 to M3.

The decision itself was taken at ratification (DEC-M4-6, `M4's plan`), before any
M4 code was written. This ADR is that decision's permanent record.

## Decision

**Both aggregates, their intake commands and their triage surfaces move to M5, with named
triggers.**

Three reasons, in order of weight.

**1. Nothing in M4 needs them.** M4's five acceptance criteria are reviewer throughput,
self-review impossibility, the reviewer signature, audit-chain tamper detection, and duplicate
detection. None mentions a defect record. A reviewer rejecting a draft uses the **rejection
taxonomy** (DEC-M4-11, ten reasons chosen by keystroke) — defects are about *published* items,
which is a different loop with a different actor.

**2. `AnswerKeyChallenge`'s remedy is blocked regardless.** An upheld challenge needs a corrected
published version, and **D25** forbids exactly that. Building the intake in M4 would have shipped
a record whose only available resolution is `suspend` — a loop that does not close, delivered
under the impression that it does. That is worse than not shipping it: it looks like a feature.

**3. M4 produces the precondition for both.** Neither can be exercised against real content until
M4's review loop has published something internally. Building intake before the thing it takes
intake *of* is the vacuous-green pattern under another name — a suite that passes because nothing
it describes has happened yet.

## Triggers

Stated so the deferral is not open-ended ([ADR-0011](./ADR-0011-pnpm-workspace-stands-in-for-turborepo.md)'s
discipline):

| Deferred | Trigger |
|---|---|
| **`ItemDefect`** intake and triage | The first published item a reviewer or author needs to report against. |
| **`AnswerKeyChallenge`** intake and adjudication | The first disputed key on a published item, **or** M9's learner-facing challenge surface, whichever comes first. |

**D25's trigger moves with the challenge.** The two are one piece of work: an adjudication path
with no way to publish the correction is not an adjudication path.

## Alternatives considered

**A stub `ItemDefect` "so the shape exists".** Rejected. A modeled aggregate that no command
writes and no surface reads is half-shipped work that rots — field names drift out from under it,
and nobody notices because nothing exercises it. M3-16 got away with `LocaleVariant` only because
it asserted, as a test, that nothing accepts one; that assertion is the entire reason it was
defensible, and it is not a pattern to reach for twice.

**Building `ItemDefect` but not `AnswerKeyChallenge`.** Rejected. The two share a triage surface
and an actor. Splitting them delivers half a screen and defers the half that carries the harder
question.

## Consequences

**ROADMAP is amended, and the amendment follows this ADR** — recorded in M4's ROADMAP line
alongside **D20** at M4-45. The order matters: the decision is the record, the roadmap edit is
its consequence.

**M4's scope shrank by four tasks**, which is part of how a 51-task first draft became 46.

**M5 inherits two deliverables it did not plan for**, and inherits them with their triggers
already stated, which is the difference between deferred work and forgotten work. `HANDOFF-M5.md`
names both.

**Nothing in the shipped tree references either aggregate.** There is no stub, no table, no
enum member and no TODO — so there is nothing to mistake for a partial implementation.
