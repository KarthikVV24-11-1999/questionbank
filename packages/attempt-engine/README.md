# @questionbank/attempt-engine

The offline attempt engine: what happens on a learner's device between "start" and "submitted", with
nothing else in the room. An append-only response log, the projection that derives answers from it, the
attempt state machine, a timer driven by monotonic readings, and the queue that decides what still has to
be sent. The design is `docs/ASSESSMENT-ENGINE.md` §4 and §5.

It is pure. The package imports no framework (no React, no Nest, no DOM), performs no I/O (no `fetch`, no
storage, no filesystem) and reads no clock — time arrives as a parameter, because the wall clock is
user-settable and the engine enforces against monotonic readings instead. Something outside decides when to
ask the time and how to send what the queue hands back. Those rules are fitness functions, not intentions:
F26 scans this package for framework imports, and a companion rule scans it for ambient clock, randomness
and I/O.

## How to run it

A library with nothing to start. The runtime that embeds it lives elsewhere.

## How to test it

```bash
corepack pnpm typecheck
corepack pnpm test   # vitest, with coverage
```

Every module here decides what a learner's responses are, how long they have left, or what is still unsent,
so the coverage threshold is 100% on lines, branches, functions and statements for the whole package. The
tests need no DOM and no network; if one ever does, the engine has been contaminated.
