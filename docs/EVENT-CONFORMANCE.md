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

`pnpm --filter @questionbank/api run event-conformance` runs the learner suite and the API's call-site specs with a log marker made in the temp directory, so that every event they emit is
appended to a file, then replays that file through a fresh edge. Last run, 2026-10-29:

| | |
|---|---|
| Events emitted by the run | 14 (10 from the learner app's screens, 4 from the server) |
| Admitted by the edge | 14 of 14 |
| **Envelope conformance** | **14 / 14 = 100%** |
| **Catalog coverage** | **4 of 14** M7-owned events wired |

Events planted on purpose, to show the check refusing them, are not logged and are not in the denominator: they are test inputs made to fail, not something the app
emitted. The tests that plant them are the second column of the table below.

The conformance figure is a property of the emitters that exist: it is 100% because the four emitters build their envelopes through one shared type and the tests that
emit them also validate them, not because the catalog is covered. The coverage figure is the one that says how much of the taxonomy is captured, and it is small.

## The table

Every event M7 owns has a row. A wired row names the test that shows the event emitted with a conforming envelope at its real call site, and the test that shows the
conformance check able to fail (a planted bad envelope the same check catches). A row that is not wired says why, and who holds it. The table is read by
`apps/api/src/fitness/event-conformance-rules.spec.ts`, which fails if a named test is renamed away or skipped, if an owned event has no row, and if the table disagrees with
the shipped source about which events are emitted.

| Event | Status | Emitted with a conforming envelope — shown by | The check can fail — shown by | Not wired: why, and who holds it |
|---|---|---|---|---|
| `mastery.gain_verified` | wired | `apps/api/src/platform/composition/learning-consumer.spec.ts` :: emits mastery.gain_verified for the learner, a valid envelope with the concept, the days it took and the responses behind it | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mastery.gain_verified | — |
| `mock.diagnostic_viewed` | wired | `apps/learn/src/ui/ReportScreen.spec.tsx` :: says the report was viewed, once, with how many findings it showed and that it has no drill-down | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mock.diagnostic_viewed | — |
| `mock.remediation_clicked` | wired | `apps/learn/src/ui/ReportScreen.spec.tsx` :: says the finding was tapped, with its rank and the hours since the score, and then that the run it made started, from a remediation | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for mock.remediation_clicked | — |
| `practice.session_started` | wired | `apps/learn/src/ui/HomeScreen.spec.tsx` :: says a practice run started from the next action was a recommendation, and says nothing of a finding having been tapped | `apps/api/src/fitness/event-conformance-rules.spec.ts` :: catches a planted bad envelope for practice.session_started | — |
| `practice.item_answered` | not wired | — | — | No route serves a run's questions, so no learner answers a practice item in the app (D87). M7. |
| `practice.session_completed` | not wired | — | — | A practice submission is not scored and a run has no completion (D77). M7. |
| `practice.session_abandoned` | not wired | — | — | A run is put down and picked up with no deadline; nothing says it was abandoned (D92). M7. |
| `solution.viewed` | not wired | — | — | No screen shows a solution; the route serves one, and a served response is not a view (D92). M7. |
| `remediation.set_generated` | not wired | — | — | What to practise next is computed on each read and no set is stored, so there is no moment of generation (D92). M7. |
| `remediation.set_completed` | not wired | — | — | Needs a practice run completed and scored against a baseline (D77). M7. |
| `mastery.regressed` | not wired | — | — | `days_since_gain` needs the instant of the gain the concept held, which the recorder's read of a concept does not return (D92). M7. |
| `review.due_completed` | not wired | — | — | The review schedule is derived from evidence; no action of the learner completes a due review (D92). M7. |
| `review.due_skipped` | not wired | — | — | No action lets a learner skip a due review (D92). M7. |
| `error_notebook.entry_reviewed` | not wired | — | — | No route or screen marks an entry reviewed (D92). M7. |

## What the figures do not claim

- **Conformance is measured at the edge, before the sink.** The sink at M7 is a local directory and Parquet in object storage is M8's (D90). An event that conforms is not
  an event that has reached analytics.
- **The wiring in `main.tsx` is covered by no test.** The screens, the emitter and the call to the edge are each tested; the entry point that joins them to the real device, clock and network is
  excluded from coverage like the rest of that file, and is exercised only by the adversarial suite's runs of the built app, which do not open a screen that emits.
- **The client path was never run against a deployment.** The learner app's events are validated and admitted in tests that replay them through the real edge; no
  browser has sent one over a network to a running API in this repository's suites.
- **A server event is emitted after the work that produced it has committed, by the relay's consumer.** If the process dies between the two, the relay redelivers, the
  recorder finds the evidence stored, and the gain is not announced again: `mastery.gain_verified` is at-most-once on that path, and the id derived from the transition
  only stops a second count. An outbox row written in the same transaction as the gain would close it (D92).
- **Server events carry nominal `device_class` and `network_class`** (`high`, `wifi`), because the envelope requires them and a server has neither. Analysis filters on
  `surface`.
- **Events before this milestone are not recoverable**, and the four that exist begin at M7's close.
