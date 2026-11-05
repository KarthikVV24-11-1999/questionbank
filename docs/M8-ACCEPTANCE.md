# M8 — acceptance, as far as it can be earned now

Five criteria were fixed when M8 began ([ROADMAP.md](ROADMAP.md), M8). This is each one's verdict today, on the pattern of [M7-ACCEPTANCE.md](M7-ACCEPTANCE.md): the verdict the evidence earned and not the one the wording reads as, a `Partial` saying what part, and a
criterion that rests on a mechanism credited as a mechanism. M8 is not closed: its other deliverables (search, notifications, the support console, production observability, the load test) are not built, and this table is about its acceptance line only.

| # | Criterion | Verdict | What the verdict rests on | What was not, and what would unblock it |
|---|---|---|---|---|
| 1 | Signup → first named **recommendation** ≤ 10 min for ≥ 70% of beta users *(provisional; a standing is asserted only with D-002's eight responses on a topic, and promoted to strong only with two sessions as well)* | **Mechanism built and timed; the criterion is not earned** | The whole path exists and is one integration test against real Postgres, the real session resolver and the real relay (`first-weakness-journey.integration.spec.ts`): register, verify the address, sign in, choose an exam, say which chapters are studied, be offered the diagnostic, sit it, submit it, open the map, read what the topic to work on first is called. The server's own time, step by step, on one run: **443 ms in all**, of which 160 ms is registering and 133 ms signing in (the password hash). The same path over HTTP against the booted Compose stack, through the address the learner app is served from (`tools/stack-journey/journey.mjs`, run by the `compose` job), is timed there, and so is a stranger's path through the learner app's own screens in a real Chrome (`tools/adversarial/src/stack-journey.ts`): **8.0 s** against 1.75 s over HTTP on the same run, each client's time; the figures are in the sections after this table. The run reaches every topic before it takes a second from any, a diagnostic finished with questions left gives a partial map of the topics answered, a run left alone is finished for the learner after forty-eight hours (D116), and the topic is named, not an identifier. | **The number is a floor on the machine's share of the ten minutes and not the criterion.** The criterion is a population statistic over beta users; the test is one path, on one machine, with no person reading, thinking, typing or waiting on a network, and with a corpus of a handful of topics. The time that matters is the learner's: ten questions at about a minute each. Unblocked by: real beta users on a deployed environment, and the journey timed in a browser with a person at it. **Why the old wording was not achievable, so that nobody reads the change as a shortfall in the code.** The criterion said "first named *weakness*". A weakness the product states, as against suggests, is a standing the map calls asserted, and a standing is asserted only with D-002's eight responses on the topic (`minResponses`, seeded in `20261028100000_learning_mastery_rule_set.sql` and adopted in DECISIONS.md D-002); *strong* needs two sessions as well. A breadth-first diagnostic of ten questions (FR-STU-03 rule 1) leaves at most ⌈10 ÷ topics⌉ answers on each: two or three on the four topics of the test corpus, two or one on six, one on each of the 608 topics of the JEE syllabus. To assert a *weak* standing on every topic it covers it would need eight answers on each: 32 questions over four topics, 4,864 over the syllabus; and no one-sitting run, of any length, can state a *strong* one. So a first sitting gives a **recommendation** (a provisional starting point from the learner's own answers, said "so far" on the home screen) and the criterion now asks for that. The two alternatives were a lower confidence rule for a first baseline and a diagnostic concentrated on few topics; both are rejected in DEC-M8-23 in [IMPLEMENTATION-DECISIONS.md](IMPLEMENTATION-DECISIONS.md). |
| 2 | Mock completion rate ≥ 85% | **Blocked** | The two events the rate is counted from, `mock.attempt_started` and `mock.attempt_submitted`, are now emitted by the server (M8-54, DEC-M8-31), each conforming to the taxonomy and the PII rules; the other twenty-nine of D91 are not. Nothing counts a rate, because nothing has been sat: there are no beta users. The start is said just after the save, so a process dying in between loses it and the rate would read slightly high. | Real beta users sitting real mocks on a deployed environment. |
| 3 | Zero Sev-1 incidents over the beta period | **Blocked** | There is no beta period: nothing is deployed to people. | A deployed environment with 200 invited students, the incident record that goes with it, and the on-call arrangement. |
| 4 | p95 latencies within NFR §6 | **Partial** | **The part that is measured:** at 3x the beta's own derived peak (200 students: day-one sign-in, B1, B2, B3), on a two-vCPU CI runner with the generator on the same box, the 95th percentile is inside the target for PER-08 (reads: 47 ms for a package, 22 ms for the profile), PER-09 (writes: 206 ms for sign-in, 35 ms for the answers, 13 ms for a submission), PER-16 (the concept map: 31 ms) and PER-13 (a result in the map 1.6 s after submission), with no failed operation ([run 41938442874](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41938442874)). **What it is not:** a production percentile (the runner is pessimistic on latency and a ceiling on throughput, and a 90-second run is about 900 operations), and **PER-10, PER-11 and PER-12 are not measured at all**: a 75-item form cannot be assembled on a stack seeded with 18 questions. **A finding:** 200 students signing in in the same instant are not all served: 170 were and 30 were refused as busy, the slowest after 15.5 s (D129). | A published 75-item form and an operator to publish it; the load run against the host from another machine; a percentile over real traffic. |
| 5 | On-call pages ≤ 2/week/person | **Blocked** | There is no on-call rotation and no paging, because there is nothing deployed to page about. What exists is Tier 2 and has never run: `GET /metrics`, six objectives, the burn-rate alert rules rendered from them and a synthetic probe (M8-53, M8-55, D132). A file of alert rules is not an alert that fired. | The deployed environment, a monitoring system that loads the rules, a receiver for a page, and a rotation to count pages against. |

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

What neither is: a person. The learner app has a sign-in (ADR-0065), and the same journey is driven through its screens in a real Chrome by the `compose` job (`tools/adversarial/src/stack-journey.ts`, M8-44): that run is in the next section. It is still a script: the time a learner spends reading and answering ten questions, about eight to ten minutes, is the largest part of the ten and is not measured here.

## In a real browser

Row 1's path, run in a headless Chrome by the `compose` job against the booted stack, through the learner app's own controls ([CI run 41809494453](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41809494453); the figures are its annotations). A stranger creates an account, reads the link from the message the stack wrote, opens it, is taken on to the questions about the exam (not to an empty home), says which exam, class and chapters, signs out and in again, sits the ten-question diagnostic, finishes it, and reads the first topic home tells them to work on. The same run also checks that the session cookie is not readable by script and that nothing about a session is in `localStorage`.

| Step | Over HTTP, no browser (`journey.mjs`) | In Chrome, through the screens (`stack-journey.ts`) |
|---|---|---|
| open the app, be shown where to sign in | 50 ms (the page and the service worker are served) | 1,289 ms |
| go to creating an account | not a step | 548 ms |
| create the account (and be signed in) | 227 ms | 1,554 ms |
| read the link from the message | not a step (the code is read) | 1 ms |
| open the link, address confirmed | 10 ms | 345 ms |
| on to the questions about the exam | not a step | 134 ms |
| exam, class, chapters | 32 ms + 131 ms (exam and chapters) | 47 ms + 298 ms + 569 ms |
| sign out, sign in | 192 ms (sign in) | 255 ms + 539 ms |
| home decides what to offer, start the diagnostic and have its questions | 45 ms + 211 ms | 597 ms |
| answer ten questions and finish the run | 47 ms + 10 ms (the answers sent as events, then submitted) | 651 ms + 142 ms |
| score it and record what it showed (waiting for the relay) | 775 ms | 777 ms |
| home names the first topic | 21 ms | 256 ms |
| **the path** | **1,751 ms** | **8,001 ms** |

The three figures for row 1 and what each is: **443 ms in process**, the server's own clock, one learner, no network (`first-weakness-journey.integration.spec.ts`); **1,516 ms over HTTP** on [run 41794610763](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41794610763) (1,751 ms on the run above), the client's clock through the proxy, no browser; **8,001 ms in a real Chrome** on the run above, the client's clock including every page load, render, form fill and tap. The extra six seconds are the browser: loading the page cold (1.3 s), the bundle and its screens, and three password-hashing requests on a shared runner (the account is made, signed in with the same password, and signed in once more after signing out).

What it is not: a person. Nobody reads, thinks, hesitates or mistypes, a click costs milliseconds, and the ten questions are answered by taking the first option. The time that matters to the criterion, about a minute a question for ten questions, is still the largest part of the ten minutes and is still not measured. **The headless Chrome on a CI runner is not a student's phone**: the page loads over `localhost`, on a fast CPU, with a warm network stack. It is a floor on the machine's share and a check that the whole path works in a browser, which until this track it could not.

## What this table found

The brief for the track that built row 1 assumed three things that were not so, and the table records them rather than build around them. Evidence is not recorded per response: it is recorded when a submitted run is scored, so a run answered and never submitted leaves nothing
(D116). A diagnostic of one item for each topic cannot state any standing, so the map it produces says "too early to say" for every topic; the home screen now says "so far" for the topic it names first (D117 is closed). And "high-leverage" in FR-STU-03's first rule has no data to honour it (D115).

## What the first row's measurement is, and is not

It is a measurement, in the sense that the numbers are the server's own clock over a real path; it is not evidence about users. What would make it evidence is the same path timed in a real browser by people who are not us. That is the first thing to do with the first beta learner, and the
steps are already named in the test so the two can be set side by side.

## What cannot be checked here (ADR-0013, Tier 3)

| What | Result | Command | What is missing |
|---|---|---|---|
| SES takes a message sent from the application's own settings (M8-41, D120) | `Fail — blocked` | `MAIL_SES_REGION=… MAIL_SENDER=… AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… DATABASE_URL=… AUTH_SIGNING_KEY=… AUDIT_ANCHOR_KEY=… pnpm --filter @questionbank/api mail-smoke <a verified address>`; exit 0 and a message in that inbox is a pass | An AWS account with SES in the region, a sender address or domain SES has verified, an access key for it, and (while the account is in the sandbox) a verified recipient; production access removes the last. |

What is proved without them: the request SES would receive (endpoint, sender, one recipient, subject and body) and its signature, the last against AWS's published test vector; that a refusal, an unreadable answer, a timeout and an unreachable provider each fail the send with a reason that holds neither the address nor the code; that a process with all four settings sends through SES, one with none writes a file (development) or refuses every send (production), and one with some does not start and names the missing ones; that the composed application carries the settings, the app's address and a failed send's one log line to the adapter; and that none of it changes what a stranger is told when a send fails (DEC-M8-25). **The `compose` job boots the stack in development mode, where mail is a file; a green boot says nothing about SES.**

## Before a host exists (M8 Track K)

What was checked by a machine, what it found, and what stays open. None of this is a statement about real people.

| What | Result | What it is worth |
|---|---|---|
| Dependency audit of the lockfile (`tools/security/scan.mjs`, the `security` job) | The first run found **52 advisories: 3 critical, 21 high, 23 moderate, 5 low**. Overrides to the patched releases (DEC-M8-29) leave **5 moderate**, all in the test runner (D126). The job fails at high. | Published advisories about this lockfile, and nothing about this code. The manual security review and M9's penetration test are not done (D125). |
| Credential-shaped text in tracked files | None, apart from two files planted on purpose so that F39 can be seen to find them. The scan's own test was the first thing it found. | Shapes, not secrets (D125). |
| Learner screens against WCAG 2.2 AA (`accessibility.spec.ts`, axe in a real Chrome) | 44 screens and states; **one finding: controls 21 pixels high**, under the 24 WCAG 2.2 asks for. They are 44 now. | About a third of what a person would find. Reading order, announcements, focus, a screen-reader pass of the diagnostic and the unstyled colour tokens are not checked (D127). |
| A learner signed out by a login elsewhere (D122) | Told so on the sign-in screen, from a route that says why the session ended. | One reason, in one sentence; no list of devices. |
| The database and the API reachable from outside the host (D123) | Published on `127.0.0.1` only, enforced by the `fitness` job; the database asks for a password. | Not a firewall: 8080 is meant to be reached. |
| Backup and restore | The drill ran in the `compose` job on [CI run 41926051358](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41926051358): 82 tables and 2,034 rows backed up (430 kB) in 0.4 s, the database dropped, restored in 1 s, every table counted the same, the learner from before signed in and found their exam, chapters and answers, and a new learner ran the journey. The stack took 12 s to start again. | The stack's volume, not a host, and not kept off it (D128). |

## Load and soak (M8 Track L)

What `tools/load/load.mjs` measures, against what, and what it cannot ([DEC-M8-32](IMPLEMENTATION-DECISIONS.md), DEC-M8-33; the limits are D131). The load is the beta's own share of NFR §1.1 (200 students: day-one sign-in in five minutes, B1 80% pulling a package in fifteen, B2 60% submitting in five, B3 everyone reading a result in thirty) multiplied by 3 (SCA-01), played as rates for 90 seconds on four streams at once, with every student signing in at the same instant as a fifth, reported measure. The source tiers of three rate limits are raised for the run and the subject tiers are not. Paths that need a published 75-item form (PER-10, PER-11, PER-12) and the ceiling-sized scenarios (SCA-02, SCA-03, SCA-04) are blocked and are not simulated. The sign-in stampede is D129; the outbox messages nothing consumes are D130.

### The load, at 3x, for 90 seconds ([CI run 41938442874](https://github.com/KarthikVV24-11-1999/questionbank/actions/runs/41938442874), the `compose` job's annotation)

Client time through the learner app's proxy, on the CI runner: two vCPUs, with the load generator, the API, the database and the proxy on them. Latency is pessimistic, throughput a ceiling, and none of it is the host's.

| Operation | Target (p95) | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| sign in (a write and a password hash) | PER-09, 300 ms | 180 | 188 ms | 206 ms | 220 ms | 221 ms |
| a practice run's package (a read) | PER-08, 200 ms | 48 | 27 ms | 47 ms | 58 ms | 58 ms |
| the answers of a run sent (a write) | PER-09, 300 ms | 108 | 27 ms | 35 ms | 51 ms | 59 ms |
| a run submitted (a write) | PER-09, 300 ms | 108 | 7 ms | 13 ms | 20 ms | 23 ms |
| the concept map | PER-16, 500 ms | 30 | 25 ms | 31 ms | 36 ms | 36 ms |
| the learner's profile (a read) | PER-08, 200 ms | 30 | 9 ms | 22 ms | 23 ms | 23 ms |
| a run's submission to its result in the map | PER-13, 60 s | 108 | 812 ms | 1.6 s | 2.1 s | 2.2 s |

The rates are the NFR's shares worked out for 200 students and multiplied by 3 (the arithmetic is printed at the head of every run and written in `tools/load/model.mjs`): sign-in 2 a second, package pulls 0.53, submissions 1.2, result reads 0.33. No operation failed, the pool never had a client waiting, the outbox ended empty and nothing was refused. **The stampede**, every student signing in in the same instant, has no target and is reported: 170 signed in (median wait 7.9 s, 95th percentile 14.8 s), 30 were refused as busy after the full 15-second wait, and all 200 were answered in 15.5 s; the server was ready afterwards (D129). Not measured, because the stack cannot serve them: PER-10, PER-11, PER-12 (a 75-item form), SCA-02, SCA-03, SCA-04.


