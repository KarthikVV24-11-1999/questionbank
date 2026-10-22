# ADR-0035 — REL-06 lives in the attempt engine, and a pure package may enter a domain

**Status** Accepted · M6 Track E, M6-29 · Amends the shared-kernel clause of the F2 boundary rule (ENGINEERING-HANDBOOK §9 rule 2)

## Context

REL-06 is the rule that nothing is lost when a learner changes device: two logs are merged as a **set union by
`event_id`**, never last-writer-wins, because two devices produce disjoint event sets and a union cannot lose one
(ASSESSMENT-ENGINE §4). It already existed in `packages/attempt-engine/src/merge.ts`, with 194 tests and no consumer.
Track E builds the server side of the same merge: events from a device arrive, are de-duplicated against what is
stored, and the log that results is what scoring reads.

Two implementations of the rule that guarantees nothing is lost is the worst place in the system to have two. The
server could not simply import the engine: `apps/api` did not depend on it, and F2 lets a context's `domain/` import
exactly one package, `@questionbank/domain-types`.

## Options

1. **Admit the engine to the allowed list.** It has no framework, no I/O, no clock and no randomness, asserted by its
   own suite and by F26. REL-06 then has one implementation.
2. **Reimplement on the server** and hold both to one answer by a parity test. That is what the attempt state-shape rule
   needed — a retrofit after a third copy appeared. Choosing it before a second copy exists is choosing the worse
   option knowingly.
3. **Move the merge into `domain-types`.** Already allowed, but it drags the event and log types with it and makes the
   shared kernel the home of behaviour, which is not what a kernel is for.

## Decision

**Option 1, admitted by criterion rather than by name.** A workspace package may be imported by a context's `domain/`
when it is *pure*: all three of

1. it declares no runtime dependency (`dependencies`, `peerDependencies`, `optionalDependencies`);
2. none of its source under `src/` (specs and `testing/` excepted) imports anything but a relative module — no bare
   specifier, no `node:` builtin;
3. none of that source reads a clock, randomness, storage, the network or the host process, or touches a framework or
   the DOM — the same pattern F26 holds the engine to, imported and not restated.

The rule computes the admitted set from the tree each run (`fitness/pure-package-rules.ts`), so a package that stops
being pure stops being admitted in the same run. Today that is the attempt engine; `content-renderer` (React) and
`contracts` (zod) are not.

**The relaxed rule is proven to still bite**, one planted package per clause: one that reads the wall clock, one that
declares a dependency, one whose source imports `node:fs`. Each is refused when a domain module imports it, and a
planted workspace with a pure package shows the same domain module is accepted.

**REL-06 has one home, and a test says which.** The union is the engine's `mergeLogs`. The server's `domain/response-log.ts`
maps the server's event onto the engine's, hands the engine the stored and incoming sets, and reads from its answer which
ids are new, which are replays and which reuse an id with other content. It contains no union of its own. A fitness rule
(`REL06_SECOND_UNION_IMPLEMENTATION`) fails on a second declaration of `mergeLogs` or `logFromEvents`, and — against a
rename — on any production source that walks events by `eventId` *and* keeps a set or map of what it has seen, outside a
short list of named modules each with its reason. A planted copy under the engine's name and one under another name are
both caught.

**The server's projection is the engine's too.** `projectLog` filters to the events that counted and calls the engine's
`projectResponses`, so what a device projects locally and what the server derives cannot differ; a spec compares the two
over the same union after a device switch.

## Consequences

- `apps/api` depends on `@questionbank/attempt-engine`; the package is no longer an orphan.
- The server's `ResponseEvent` is a different shape from the engine's (it carries the pin, the receipt time, the late
  flag). The mapping is one function, and a spec asserts it leaves out exactly what only the server knows.
- One small piece of bookkeeping remains the repository's: a stored event is compared with an incoming one by the
  database's own backstop when two requests race past the merge. A parity spec holds it to the engine's answer over the
  fields both see; it differs only on `deviceRef`, which the engine does not carry, and there the database is the stricter.
- The scan for a second union is by name and by shape, and cannot be complete: a copy that avoids both would pass. What
  makes that unlikely is that the one place a union is needed is the merge, and it is the engine's.
