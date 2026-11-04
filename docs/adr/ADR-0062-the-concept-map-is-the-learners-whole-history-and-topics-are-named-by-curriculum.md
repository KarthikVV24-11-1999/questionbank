# ADR-0062 — The concept map is the learner's whole history, and topics are named by Curriculum through the seam

**Status** Accepted · M8 Track G, M8-27 to M8-30 · Records DEC-M8-16, DEC-M8-17 and DEC-M8-18 (docs/IMPLEMENTATION-DECISIONS.md) · Closes D88; registers D113 and D114 (docs/DEBT.md)

## Context

The domain for FR-STU-04 was built in M7: four states, a confidence, an evidence count, `lowConfidence`, decay at read, and a map rebuilt from the evidence rows. Nothing served it. The only reader in the
application layer was the evidence recorder, and the home screen named a weakness `Concept 3f2a9c10` because no route gave a learner a topic's name (D88). UX-ARCHITECTURE §2 says domain vocabulary is
never exposed, and nothing held it.

## Decision

**Curriculum names concepts, through the seam it already offers Learning** (DEC-M8-16). `curriculumForLearning` gains one read, `nameConcepts`: concept identities in one published taxonomy version to their
names and the names above them, outermost first (subject, chapter, topic), by walking up the version's own hierarchy. It is the system's alone, all-or-nothing and names what it cannot resolve, as the reads beside it are. Its
bound is stated once, on the seam (`batchBound`, DEC-M7-28), the query refuses one identifier more, and the adapter in the composition root pages at it; Learning learns no number. No Curriculum type crosses: Learning's port
(`CurriculumSource.conceptNames`) speaks in Learning's shapes.

**The map is a read, served as two routes and a names route** (DEC-M8-17). `GET /v1/learning/concept-map` is the caller's own map of the taxonomy version their exam resolved to, read at the instant of the call so decay shows
without anything having been scheduled. Each topic carries its name and path, its evidence count, and a `standing` that is a union and not a flag: `asserted` has a state and a confidence; `tentative` (below the
evidence threshold, FR-STU-04 rule 2) has only what the few answers lean towards and *no state field*, so a screen that reads `standing.state` without having looked at `standing.kind` has nothing to read and does not
compile. A boolean beside a state is a state a caller can read and ignore the boolean of. Rule 1, explainability, is a read: the evidence rows carry the attempt, and `GET /v1/learning/concept-map/{id}/evidence`
serves the answers behind one topic, newest first, a page at a time, while the map carries only the count (a whole map with every answer inline grows with everything the learner has ever done). A third route,
`GET /v1/learning/concept-names`, names the topics the other screens hold by identifier: the home screen's next action, a report's findings, the pace. No mastery rule was written; the standing is a presentation of a state the
domain had already decided.

**The declared scope does not filter the map.** This is the decision the opposite of which looks tidier and is wrong. The map is what the learner knows. A learner who declared they have studied mechanics and then
answered optics questions has evidence about optics, and a map that hid it would tell them something false about their own history, and would hide the very weakness they went and found. Scope steers what to *practise next*
(M8-21, already done: practice, the review plan and remediation read it; mocks never do). The map instead says, per topic, whether it is inside the declared syllabus (`inDeclaredScope`, `null` when none was declared),
and the screen may use that to present it. The two pieces of work have different questions: what do I know, and what should I do.

**The screens take the exam from the profile, and names from the server** (DEC-M8-18). The app asks the learner's profile for the exam profile version and the taxonomy version instead of reading them off the
address, so `?profile=` and `?taxonomy=` are gone, and `conceptLabel` is deleted. A topic whose name could not be read is called "This topic" and never by what it is filed under. `screenHref` now carries which screen and
which thing (a run, a report, onboarding, the map, a topic and its page of answers) and nothing about the learner; it is a builder of screen addresses and no longer a carrier of context.

**The vocabulary rule has two gates because it has two halves.** A source scan (`vocabulary-rules.ts`) refuses our words (`concept`, `taxonomy`, `item version`) and a bare identifier in any string a learner could read; it
cannot see a label built at run time out of an identifier, which is what D88 was. So each screen's spec also reads the *rendered* screen, text and the attributes that are spoken, and fails on the same words and on any
identifier. Neither would have caught `Concept 3f2a9c10` alone: the scan catches the word in the source and the render catches the identifier that was only ever made at run time.

## Consequences

- A free learner and a paid learner see the same map and drill-down today. FR-STU-04 rule 4 (free sees the map; paid sees full drill-down and history) needs entitlements, which are M9: registered, not half-built (D113).
- The map is of the taxonomy version the learner's exam resolved to when they chose it, and lists the topics they have answered on; the topics they have not are a count. Evidence under another version, and a list of every
  topic of the syllabus, are registered (D114).
- Naming is all-or-nothing within the map: a topic the version cannot name fails the read and is named. That is deliberate and it is strict; the alternative shows a learner a gap where a topic should be.
- The names route answers any signed-in learner for any published version. The syllabus is the same for every learner (onboarding lists the same chapters), so it reads nobody's data.
