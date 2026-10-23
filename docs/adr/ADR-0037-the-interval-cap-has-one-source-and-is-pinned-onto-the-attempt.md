# ADR-0037 — The interval cap has one source, and is pinned onto the attempt

**Status** Accepted · M6 Track F, M6-37 · Resolves ASSESSMENT-ENGINE §14 item 5 as far as it can be resolved without data

## Context

Time on item is the sum of the visit → leave intervals of a slot, each capped, to discard time the learner was not actually on the
question (the app backgrounded). §4 and §14 say a per-interval cap exists and never say its value. `intervalCapMs` was therefore a
*required option* on the engine's `projectAttempt` and the server's `projectLog`, with nothing behind it: no configuration, no
debt entry, and four different literals (`5_000`, `60_000`, `120_000`, `600_000`) in the tree, each written by a test that wanted a
number.

That is the session defect again: two sides of one computation with nothing forcing them to agree. `timeOnItemMs` is psychometric
data, and a device and a server projecting one log under two caps produce two different answers for it. The M6-35 assertion that the
server derives what the device derived held only because the test handed both the same literal. The learner app (Track G) would
have been the second guesser.

## Decision

**One source: `TIME_ON_ITEM_INTERVAL_CAP_MS`**, in configuration (`timeOnItemIntervalCapMs`), default 120 seconds, validated as a positive
whole number of milliseconds. It is not per exam profile: nothing says it should vary by exam, and a profile field would be a
guess about a requirement nobody has stated. If one is ever wanted it belongs where profiles live, and the attempt's pin is already
the place it would be read from.

**Pinned onto the attempt when it is created** (`attempt.interval_cap_ms`, immutable like the duration), because a configuration
value read at projection time would let a later change make the server project an attempt already begun under a cap the device never
saw. The attempt's own value is what `projectLog` reads — it takes the attempt, not an option — so the server *cannot* choose one.

**The client is told it, on a path that already exists**: the attempt response (`intervalCapMs`, on create, start and read). Not the
form package: that is signed, byte-identical for a form and meant to be cached, and a value from configuration would change its bytes
(and its signature) whenever an operator changed a setting.

**A rule keeps it that way** (`M6_37_INTERVAL_CAP_LITERAL`): no source file, specs included, assigns a numeric literal to a name
ending `intervalCapMs` or declares a `*INTERVAL_CAP_MS` constant, except configuration (which defines the value) and the engine's own
package (whose tests exercise the cap as the parameter it is). Specs that need a value take it from the configured default or from the
attempt. A planted literal written as a property, and one assigned to a variable, are both caught.

## Consequences

- The 120-second default is a guess. It is recorded as one (D61), with the data that would settle it as the trigger.
- The M6-35 equality assertion now passes because both sides read one value: the device uses the cap it was told, the server the one
  pinned on the attempt, and a spec checks the two are the same number.
- An attempt created under one configuration keeps its cap when the configuration changes; a new attempt gets the new one. A spec
  shows both with two applications over one database.
