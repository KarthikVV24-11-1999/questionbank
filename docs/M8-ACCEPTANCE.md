# M8 — acceptance, as far as it can be earned now

Five criteria were fixed when M8 began ([ROADMAP.md](ROADMAP.md), M8). This is each one's verdict today, on the pattern of [M7-ACCEPTANCE.md](M7-ACCEPTANCE.md): the verdict the evidence earned and not the one the wording reads as, a `Partial` saying what part, and a
criterion that rests on a mechanism credited as a mechanism. M8 is not closed: its other deliverables (search, notifications, the support console, production observability, the load test) are not built, and this table is about its acceptance line only.

| # | Criterion | Verdict | What the verdict rests on | What was not, and what would unblock it |
|---|---|---|---|---|
| 1 | Signup → first named **recommendation** ≤ 10 min for ≥ 70% of beta users *(provisional; an asserted standing needs D-002's 8 responses across 2 sessions)* | **Mechanism built and timed; the criterion is not earned** | The whole path exists and is one integration test against real Postgres, the real session resolver and the real relay (`first-weakness-journey.integration.spec.ts`): register, verify the address, sign in, choose an exam, say which chapters are studied, be offered the diagnostic, sit it, submit it, open the map, read what the topic to work on first is called. The server's own time, step by step, on one run: **443 ms in all**, of which 160 ms is registering and 133 ms signing in (the password hash). The same path over HTTP against the booted Compose stack, through the address the learner app is served from (`tools/stack-journey/journey.mjs`, run by the `compose` job), is timed there; its figures are in the section after this table. The run reaches every topic before it takes a second from any, a diagnostic finished with questions left gives a partial map of the topics answered, a run left alone is finished for the learner after forty-eight hours (D116), and the topic is named, not an identifier. | **The number is a floor on the machine's share of the ten minutes and not the criterion.** The criterion is a population statistic over beta users; the test is one path, on one machine, with no person reading, thinking, typing or waiting on a network, and with a corpus of a handful of topics. The time that matters is the learner's: ten questions at about a minute each. Unblocked by: real beta users on a deployed environment, and the journey timed in a browser with a person at it. **Why the old wording was not achievable, so that nobody reads the change as a shortfall in the code.** The criterion said "first named *weakness*". A weakness the product states, as against suggests, is a standing the map calls asserted, and a standing is asserted only with D-002's eight responses on the topic (`minResponses`, seeded in `20261028100000_learning_mastery_rule_set.sql` and adopted in DECISIONS.md D-002); *strong* needs two sessions as well. A breadth-first diagnostic of ten questions (FR-STU-03 rule 1) leaves at most ⌈10 ÷ topics⌉ answers on each: two or three on the four topics of the test corpus, two or one on six, one on each of the 608 topics of the JEE syllabus. To assert a *weak* standing on every topic it covers it would need eight answers on each: 32 questions over four topics, 4,864 over the syllabus; and no one-sitting run, of any length, can state a *strong* one. So a first sitting gives a **recommendation** (a provisional starting point from the learner's own answers, said "so far" on the home screen) and the criterion now asks for that. The two alternatives were a lower confidence rule for a first baseline and a diagnostic concentrated on few topics; both are rejected in DEC-M8-23 in [IMPLEMENTATION-DECISIONS.md](IMPLEMENTATION-DECISIONS.md). |
| 2 | Mock completion rate ≥ 85% | **Blocked** | The funnel it is measured on has its start and its submit, `mock.attempt_started` against `mock.attempt_submitted`, among the events the past surfaces never emitted (D91). Nothing counts a rate yet. | Real beta users sitting real mocks on a deployed environment, and the two events emitted before they do. |
| 3 | Zero Sev-1 incidents over the beta period | **Blocked** | There is no beta period: nothing is deployed to people. | A deployed environment with 200 invited students, the incident record that goes with it, and the on-call arrangement. |
| 4 | p95 latencies within NFR §6 | **Blocked** | A latency percentile needs a load and a deployment; the nearest thing measured is one scoring path at 1.13 s on an idle local database (M7-ACCEPTANCE row 3), which says what one request costs and not what the p95 is under load. | The deployed environment, the load test at three times projected peak (an M8 deliverable not yet built), and a percentile taken over it. |
| 5 | On-call pages ≤ 2/week/person | **Blocked** | There is no on-call rotation and no paging, because there is nothing deployed to page about. | The deployed environment, production observability with burn-rate alerts (an M8 deliverable not yet built), and a rotation to count pages against. |

**One is built and timed and four are blocked.** All four blocked lines carry the blocker every milestone since M6 has carried: nothing runs where real people are, so nothing that is a statement about real people can be earned ([ADR-0013](adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md); D36 in [DEBT.md](DEBT.md)).
They are marked blocked rather than partial because no part of any of them is true yet.

## The same journey, two ways

Both are one learner on one machine with nobody reading anything, so both are floors on the machine's share of the ten minutes. They differ in what they include, and the difference is the only honest basis for anything said later about the ten.

| Step | In process (`first-weakness-journey.integration.spec.ts`, server's time) | Over HTTP against the booted stack (`tools/stack-journey/journey.mjs`, client's time) |
|---|---|---|
| register | 160 ms | 223 ms |
| verify the address | 3 ms | 12 ms |
| sign in | 133 ms | 191 ms |
| choose an exam | 9 ms | 34 ms |
| say which chapters are studied | 11 ms | 111 ms |
| home decides what to offer | 14 ms | 43 ms |
| make and start the diagnostic, and serve its questions | 48 ms | 193 ms |
| send the answers | 10 ms | 37 ms |
| submit | 6 ms | 11 ms |
| score it and record what it showed | 38 ms | 643 ms |
| open the map | 4 ms | (inside the line above) |
| home names the first weakness | 8 ms | 19 ms |
| **the path** | **443 ms** | **1,516 ms** |
| the page and the service worker are served | not measured | 47 ms |

The over-HTTP column is from [CI run 41794610763](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41794610763) (the `compose` job; the figures are its annotations), through the address the learner app is served from, so each request crosses the network stack, the container and the proxy. It is about three and a half times the in-process path, and the difference is in two places. Every request pays the network and the proxy (the 20 to 100 ms the cheap steps gained). And the relay: in process the test drains the outbox by hand, and over HTTP the process drains it on
its own one-second tick, so scoring and recording takes a tick; the 643 ms is that tick plus the script's polling every 100 ms, not the cost of scoring. Passwords hash in about 160 to 220 ms either way, and are the largest single cost of the machine's share.

The stack booted, migrated and seeded in **50.7 s** on the same run (build the images 22.3 s, the database 10.5 s, the migrations 0.9 s, everything else healthy 12.1 s, the syllabus 2.4 s, the demonstration questions 2.5 s) against the ten minutes F8 allows. The over-HTTP run also checks that a practice run's signed package reaches the client intact through the proxy: its digest header, its ETag and its signature all agree with the bytes received, and its media type is kept.

What neither is: a person with a browser. The learner app has no sign-in screen (D119), so the journey cannot be driven through it, and the time a learner spends reading and answering ten questions, about eight to ten minutes, is the largest part of the ten and is not measured here.

## What this table found

The brief for the track that built row 1 assumed three things that were not so, and the table records them rather than build around them. Evidence is not recorded per response: it is recorded when a submitted run is scored, so a run answered and never submitted leaves nothing
(D116). A diagnostic of one item for each topic cannot state any standing, so the map it produces says "too early to say" for every topic; the home screen now says "so far" for the topic it names first (D117 is closed). And "high-leverage" in FR-STU-03's first rule has no data to honour it (D115).

## What the first row's measurement is, and is not

It is a measurement, in the sense that the numbers are the server's own clock over a real path; it is not evidence about users. What would make it evidence is the same path timed in a real browser by people who are not us. That is the first thing to do with the first beta learner, and the
steps are already named in the test so the two can be set side by side.
