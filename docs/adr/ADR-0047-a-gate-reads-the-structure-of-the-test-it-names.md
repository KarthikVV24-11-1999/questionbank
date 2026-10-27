# ADR-0047 — A gate reads the structure of the test it names

**Status** Accepted · M7 Track C, M7-17 · Amends how [KEY-FREE.md](../KEY-FREE.md)'s table is checked (M6-59)

## Context

The key-free table names, for each surface, two tests by file and by title, and `key-free-rules.ts` checked that each title *appeared in the file*. A skipped
`describe` leaves its titles where they were, so when the attempts spec was skipped (D73) the gate passed on the `attempt-responses` row while neither of its tests
ran. The one passing row of M6's acceptance table was resting, in part, on tests that did not run, and the check built to stop that argument rotting could not see it.
A text match cannot tell a test from a comment either: the learner-screens row had been passing on a sentence inside another test.

## Decision

A rule that names a test by title asserts that the test runs. The spec file is parsed with the TypeScript compiler; every `describe`/`suite`/`it`/`test` call is
read with its chain of modifiers and the calls that enclose it; and a title matches on the source of that call's title argument. A test does not run when it or an
enclosing block is `.skip` or `.todo`, is `.skipIf(...)` or `.runIf(...)` (conditional on something the gate cannot read), or when the file holds a `.only` that
neither it nor an enclosing block shares. A title that names no test at all, only words in a comment, is missing, as before. The locator is a module of its own
(`test-locator.ts`) so that the next rule that names a test uses the same reading; `key-free-rules.ts` was the only one that did.

Each form is a planted fixture (`fitness-fixtures/as-skipped-test/`), with two controls that must stay green. Vitest has no `xit` family, so none is claimed.

## Consequences

**Makes easy:** a gate that cites a test can be believed about it; moving a proof is a visible change to the table.

**Makes hard:** a test cannot be named by a row and conditionally run. That is the point.

**Found by it:** the learner-screens row's non-vacuity claim had no test of its own and now has.
