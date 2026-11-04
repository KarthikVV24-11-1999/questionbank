# ADR-0063 — The diagnostic is a selection strategy, and a run tells the learner how an answer came out

**Status** Accepted · M8 Track H, M8-31 to M8-35 · Records DEC-M8-19, DEC-M8-20 and DEC-M8-21 (docs/IMPLEMENTATION-DECISIONS.md) · Closes D111; narrows D112; registers D115, D116 and D117 (docs/DEBT.md)

## Context

After Track G a learner could be told what a weakness is called, but a learner who had answered nothing was shown an empty home. The path from sign-up to a first named weakness (M8's first acceptance criterion) needed a first run that
reaches every topic they have studied, a screen that tells them how they are doing as they answer, and a measurement of the whole path. The practice events that waited on those surfaces (D112) also had places to be said from.

## Decision

**The diagnostic is the `breadth` strategy** (DEC-M8-19). One item for each concept in force before a second for any, the concepts in identifier order, the items within a concept in the order every other run uses. It lives inside `selectPracticeItems`, which decides eligibility
already, so that what a diagnostic may be given is what any run may be given. An item about several concepts is taken once and counts for the concept whose turn took it. "High-leverage" has no data behind it and nothing here pretends otherwise (D115).
The server makes no distinction between a diagnostic and any breadth run. The app offers it to a learner who has declared what they have studied and has nothing on the map of their exam's syllabus.

**A run tells the learner one word and can grow** (DEC-M8-20, closes D111). After an answer has reached the server the screen shows right or wrong, from the route that serves nothing more. Offline there is no verdict and the screen says so in words: the answer is saved and will be marked. Adding questions reopens the run by address, which fetches the package it now has and verifies it as the first was.

**The events are said where the fact is known** (DEC-M8-21). The server says a run was completed once it is scored; the device says an item was answered when it is told the outcome. `remediation.set_completed` stays unwired: a run is not stored with its purpose (D112).

## What the measurement is, and is not

The journey from register to a named weakness is one integration test against real Postgres, timed step by step on the server (`first-weakness-journey.integration.spec.ts`). It is one path on one machine with nobody reading anything; it is a floor on the machine's share of
the ten minutes. The criterion is a share of real people over a real network, and cannot be earned without them (docs/M8-ACCEPTANCE.md).

## Consequences

- With one to three answers behind each topic, every standing the diagnostic produces is "too early to say", and the home screen's next action still names a weakest topic from those standings (D117).
- A run left without being finished records nothing (D116): the track's brief assumed evidence is recorded per response, and it is recorded per scored run.
