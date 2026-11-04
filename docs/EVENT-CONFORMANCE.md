# Event taxonomy conformance, as M7 earned it

The acceptance line is "event taxonomy conformance ≥ 99%". One percentage cannot say that honestly: emit one event, have it conform, and it reads 100%. So there are two
numbers, and neither is given without the other.

1. **Envelope conformance** — of the events emitted during a real run of the suites, the fraction the ingestion edge admits: a complete valid envelope, a name in the
   catalog, no personal data. The denominator is the events that run emitted, not a count of emitters.
2. **Catalog coverage** — of the events M7 owns (the [taxonomy](EVENT-TAXONOMY.md)'s Owner column), how many have an emitter wired and proved at its call site. A fraction,
   never a percentage on its own.

The catalog is not all M7's. It names 79 events; M7 owns 14 of them (the surface that can know the fact is one M7 built). The rest belong to milestones that are past
and shipped nothing to capture them (D91), to milestones to come (M8: auth, onboarding, search, notifications; M9: commerce and moderation), or to none (D89). Measuring
the whole catalog at M7 would report a figure that no amount of M7 work could move.

## The measurement

`pnpm --filter @questionbank/api run event-conformance` runs the learner suite, the API's call-site specs and the built app in a real Chrome with a log marker made in the temp directory, so that every event they emit is
appended to a file, then replays that file through a fresh edge. Last run, 2026-11-04 (after M8 Track I):

| | |
|---|---|
| Events emitted by the run | 52 (41 from the learner app's screens, 8 from the server, 3 from the built app in a real Chrome) |
| Admitted by the edge | 52 of 52 |
| **Envelope conformance** | **52 / 52 = 100%** |
| **Catalog coverage** | **7 of 14** M7-owned events wired |

Nineteen of the 52 are M8's: fourteen onboarding events (`onboarding.step_completed` and `onboarding.scope_declared`, from the learner's onboarding screen, M8-22) and five `concept_map.viewed` (the map and a topic's answers, M8-29). They are measured here, in the envelope figure, because the run emits them, and each has a row in the table below, as an event that is emitted has whoever owns it. They are not in the coverage figure, which is a fraction of M7's events. `onboarding.abandoned` is in the catalog and nothing emits it (D108). Neither D91 nor D92 counted `concept_map.viewed`, which M8 owns and was never in either list, so neither is narrowed by emitting it.

Events planted on purpose, to show the check refusing them, are not logged and are not in the denominator: they are test inputs made to fail, not something the app
emitted. The tests that plant them are the second column of the table below.

The conformance figure is a property of the emitters that exist: it is 100% because the emitters build their envelopes through one shared type and the tests that
emit them also validate them, not because the catalog is covered. The coverage figure is the one that says how much of the taxonomy is captured, and it is small.

## The table

Every event M7 owns has a row, and so has every M8 event that shipped source emits (a row is what says an emitted event was proved at its call site, whoever owns it). A wired row names the test that shows the event emitted with a conforming envelope at its real call site, and the test that shows the
conformance check able to fail (a planted bad envelope the same check catches). A row that is not wired says why, and who holds it. The table is read by
`apps/api/src/fitness/event-conformance-rules.spec.ts`, which fails if a named test is renamed away or skipped, if an owned event has no row, and if the table disagrees with
the shipped source about which events are emitted.

| Event | Status | Emitted with a conforming envelope — shown by | The check can fail — shown by | Not wired: why, and who holds it |
|---|---|---|---|---|
| `mastery.gain_verified` | wired | `apps/api/src/platform/composition/learning-consumer.spec.ts` :: emits mastery.gain_verified for the learner, a valid envelope with the concept, the days it took and the responses behind it | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mastery.gain_verified | — |
| `mock.diagnostic_viewed` | wired | `apps/learn/src/ui/ReportScreen.spec.tsx` :: says the report was viewed, once, with how many findings it showed and that it has no drill-down | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mock.diagnostic_viewed | — |
| `mock.remediation_clicked` | wired | `apps/learn/src/ui/ReportScreen.spec.tsx` :: says the finding was tapped, with its rank and the hours since the score, and then that the run it made started, from a remediation | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mock.remediation_clicked | — |
| `practice.session_started` | wired | `apps/learn/src/ui/HomeScreen.spec.tsx` :: says a practice run started from the next action was a recommendation, and says nothing of a finding having been tapped | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for practice.session_started | — |
| `onboarding.step_completed` | wired | `apps/learn/src/ui/OnboardingScreen.spec.tsx` :: says a step was completed, with how long the learner was on it, and conforms to the catalog | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for onboarding.step_completed | — |
| `onboarding.scope_declared` | wired | `apps/learn/src/ui/OnboardingScreen.spec.tsx` :: says the scope was declared once the server has it, with the count and the fraction the server gave | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for onboarding.scope_declared | — |
| `concept_map.viewed` | wired | `apps/learn/src/ui/ConceptMapScreen.spec.tsx` :: says the map was viewed, once, counting the weak and the strong that are stated and not the ones that are early | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for concept_map.viewed | — |
| `practice.item_answered` | wired | `apps/learn/src/ui/PracticeScreen.spec.tsx` :: says an item was answered when the learner is told how it came out, with the outcome and what the session knows of the answer | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for practice.item_answered | — |
| `practice.session_completed` | wired | `apps/api/src/contexts/assessment/application/consumers/practice-scoring-consumer.spec.ts` :: emits practice.session_completed as a valid server envelope for the learner, with no personal data in it | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for practice.session_completed | — |
| `practice.session_abandoned` | wired | `apps/api/src/contexts/assessment/application/consumers/practice-scoring-consumer.spec.ts` :: emits practice.session_abandoned as a valid server envelope when the sweep finished the run, and not session_completed | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for practice.session_abandoned | — |
| `mock.attempt_started` | wired | `apps/api/src/contexts/assessment/application/attempt-handlers.spec.ts` :: emits mock.attempt_started as a valid server envelope for the learner, with no personal data in it | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mock.attempt_started | — |
| `mock.attempt_submitted` | wired | `apps/api/src/contexts/assessment/application/consumers/mock-attempt-events-consumer.spec.ts` :: emits mock.attempt_submitted as a valid server envelope for the learner, with the counts and the mode, and no personal data in it | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mock.attempt_submitted | — |
| `solution.viewed` | not wired | — | — | No screen shows a solution; the route serves one, and a served response is not a view (D92). M7. |
| `remediation.set_generated` | not wired | — | — | What to practise next is computed on each read and no set is stored, so there is no moment of generation (D92). M7. |
| `remediation.set_completed` | not wired | — | — | Needs a scored run to be a remediation for a concept and the concept's standing when the run began. A run is not stored with its purpose: `source` (recommendation, self, remediation) is said by the app when the run starts and kept nowhere, and a single-concept run from a report finding and one from the home screen are the same run on the server; and the baseline would be the concept's accuracy before this run, which the evidence rows can give but only for a run known to be a remediation. Emitting it for every single-concept run would state a purpose that is a guess (D112). M7. |
| `mastery.regressed` | not wired | — | — | `days_since_gain` needs the instant of the gain the concept held, which the recorder's read of a concept does not return (D92). M7. |
| `review.due_completed` | not wired | — | — | The review schedule is derived from evidence; no action of the learner completes a due review (D92). M7. |
| `review.due_skipped` | not wired | — | — | No action lets a learner skip a due review (D92). M7. |
| `error_notebook.entry_reviewed` | not wired | — | — | No route or screen marks an entry reviewed (D92). M7. |

## What the figures do not claim

- **Conformance is measured at the edge, before the sink.** The sink at M7 is a local directory and Parquet in object storage is M8's (D90). An event that conforms is not
  an event that has reached analytics.
- **The shipped app's wiring is proved for one event, and it is shared by all three.** `tools/adversarial/src/analytics.spec.ts` loads the built bundle in a real Chrome, opens the
  report screen, and requires `mock.diagnostic_viewed` to leave the page as a conforming envelope with the actor id the device keeps; that the same event is kept when the edge is down and sent
  when the network returns; and that what an earlier page left unsent is sent as the next one starts. All three client events go through the one object `main.tsx` builds, so a defect there would
  show in that test; the tap that emits `mock.remediation_clicked` and `practice.session_started` is not driven in the browser (the stand-in server has no route for a practice run), and those two are
  proved by the component tests alone.
- **The client path was never run against the API.** The events leave a real Chrome for a stand-in server that records them; they are validated against the contract in the test and admitted by the
  real edge in the measurement, and no browser has sent one to a running API.
- **A server event is emitted after the work that produced it has committed, by the relay's consumer.** If the process dies between the two, the relay redelivers, the
  recorder finds the evidence stored, and the gain is not announced again: `mastery.gain_verified` is at-most-once on that path, and the id derived from the transition
  only stops a second count. An outbox row written in the same transaction as the gain would close it (D92).
- **Server and worker events carry no `device_class` and no `network_class`.** The first version of the server emitter wrote `high` and `wifi` on every event, because §1 required both
  fields and a server has neither: values that were false, in a store that cannot be corrected afterwards. The envelope is now two shapes (the taxonomy's §1 says so in its table), a device's
  with both classes required and a server's or worker's with neither allowed, and the edge refuses a server event that carries one and a device event that lacks one. No such event was ever written
  outside a test run; the sink at M7 is a local directory (D90).
- **Events before this milestone are not recoverable**, and the four that exist begin at M7's close.
