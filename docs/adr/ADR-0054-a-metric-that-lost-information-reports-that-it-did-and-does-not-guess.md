# ADR-0054 — A metric that lost information reports that it did, and the analytic gives it a bucket of its own

**Status** Accepted · M7 Track G, M7-45 and M7-46 · Extends the interval cap of [ADR-0037](ADR-0037-the-interval-cap-has-one-source-and-is-pinned-onto-the-attempt.md); the cap's value stays open (ASSESSMENT-ENGINE section 14)

## Context

The response log's time on item caps every visit → leave interval, because a tab left open overnight is not thinking. The cap is right and has a cost nobody had to face until time analytics
existed: the learner the metric is for, one who thinks hard for longer than the cap, is recorded as exactly the cap, the same as one who walked away and came back. At the pinned default a
five-minute think reads as two minutes. The number is not wrong; it is lossy in the region the metric exists to measure, and nothing in it said so. A visit that never closed was lost the same
way, as zero.

## Decision

**The projection reports its loss beside the number** (DEC-M7-22): the intervals cut, the milliseconds cut, and the visits that never closed. This is a change to a pure function and its type, with
no clock and no I/O, so the shared kernel stays pure. The cap's value is not decided here.

**The analytic reads a slot as a pair of bounds** (DEC-M7-23). The time counted is a lower bound, because truncation only subtracts. The time counted plus what was cut is an upper bound, unless
a visit never closed, when there is none. A response is *slow* if the lower bound is above the line for its band, *fast* if the upper bound is at or below it, and *not known* otherwise.
Slow-and-correct and slow-and-wrong are kept apart, because they lead to different remediation, and *not known* is split by outcome as well.

**Not known is a result and is never rounded.** Rounding a truncated slot into fast would put the slowest learners in the fastest bucket, and no test would fail. A reader of the analytic is
told "we could not tell" and by how much (`atLeastMs`, `atMostMs`).

## Consequences

- Where the line for slow is at or below the cap, truncation cannot make a slot not known: any truncated slot already counted at least the cap, so it is slow. Not known arises for bands whose line is above the cap, and for slots with an unclosed visit. The platform default has one band above the 120 s cap for this reason to be real, not a rounding case.
- A rule set published before the pace values existed draws no line, and the analytic refuses it rather than read it against a default in source.
- The same pattern is the one to follow for any later metric that is computed on a truncated or partial input: say what was dropped, and give "not known" a name.
