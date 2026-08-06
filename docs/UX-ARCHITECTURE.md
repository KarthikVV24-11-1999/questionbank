# UX Architecture
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) (structure) · [FRS.md](FRS.md) · [NFR.md](NFR.md) §7
**Phase:** 8 — UX Architecture

> The frontend document defines *structure*. This one defines *experience*: flows, states, and the decisions behind them. No mockups.

---

## 1. The Organizing Principle

**Every screen is judged by one question: does it shorten the distance between "I know my weakness" and "I am practising it"?**

The category's standard failure is a beautiful analytics dashboard a student opens once and never acts on. Diagnosis without conversion is decoration. The single most important number in this product's UX is the **diagnosis → remediation conversion rate** (FR-ANA-02 → FR-PRA-02), and it is the tiebreaker on every design decision below.

Three consequences:
1. **Home is not a dashboard.** A dashboard shows state; a student needs a next action.
2. **Every finding is a button.** No insight is displayed without a one-tap action attached.
3. **Analytics depth is progressive.** The top-level view answers "what now?"; drill-down answers "why?" — never the reverse.

---

## 2. Information Architecture

Students orient by **syllabus** (their textbook and coaching mental model) and act by **weakness** (our differentiation). The IA must serve both without making the student translate between them.

| Dimension | Role | Surface |
|---|---|---|
| **Syllabus** — subject → chapter → topic | Orientation. "Where am I in the course?" | The browsing spine; matches how students already think |
| **Weakness** — ranked concepts by mark impact | Action. "What do I fix?" | The recommendation spine; the product's actual value |

| Decision | Justification |
|---|---|
| **The concept map is the IA spine, not a feature** | Every drill-down and every remediation route terminates at a concept; a single anchor keeps navigation coherent. |
| Domain vocabulary is never exposed | "Concept", "taxonomy version", "item version" are our words. Students see subject, chapter, topic, question. |
| Syllabus hierarchy is presented exactly as the student's coaching material presents it | Any divergence forces a translation the student will get wrong. |
| Four content entry points only: recommendation, syllabus browse, search, error notebook | A fifth path means the first four failed. |
| Attempt history is organized by **date**, concept state by **concept** | Two different questions — "what did I do?" and "what do I know?" — deserve two different structures. |

---

## 3. Navigation Model

Five tabs (Home · Practice · Mocks · Progress · Me). Structure is in the frontend doc; the UX decisions:

| Decision | Justification |
|---|---|
| **Home is the only tab that changes daily.** The other four are stable destinations | Predictable navigation reduces cognitive load for a stressed user; novelty belongs in one place. |
| The exam runtime removes all navigation and intercepts back | Accidental exit during a three-hour attempt is unrecoverable harm. |
| Solutions, paywalls, and filters are **sheets over context**, never full-page navigations | Preserves the student's place; returning to where you were should require no thought. |
| Deep links open the thing, not the tab containing it | A shared concept link that opens "Progress" has failed. |
| No more than two levels below a tab | A third level means the IA is wrong. |
| Back always means back — no custom history stacks | Android hardware back is muscle memory. |

---

## 4. The Five Moments That Decide the Product

Everything else is supporting cast.

| # | Moment | Window | What must happen | Failure |
|---|---|---|---|---|
| **1** | First session | ≤ 10 min | Sign up → diagnostic → see own weaknesses named | Generic "welcome" content; a paywall |
| **2** | After a wrong answer | ~30 s | Understand *why this specific wrong option was tempting* | A generic worked solution |
| **3** | After a mock result | ~10 min | The highest-intent moment in the product. Score → cause → one tap into remediation | A score, a rank, and a wall of charts |
| **4** | The daily open | ~5 s | Know what to do without deciding | A dashboard requiring interpretation |
| **5** | The three-hour mock | 180 min | Complete trust; zero anxiety about the platform | Any doubt that answers are being saved |

Moments 2 and 3 are where the product differentiates. Moment 5 is where it earns the right to.

---

## 5. Onboarding & First Value

**Goal: name the student's weaknesses before asking for anything.**

1. **Sign up** — mobile or email, minimum fields. No plan selection.
2. **Target** — exam, year, current class. Three taps.
3. **Scope** — "which chapters have you covered?" Chapter-level, coaching-material vocabulary, generous default (all).
4. **Diagnostic** — ~20 items, breadth-first across high-leverage concepts. Progress shown as concepts assessed, not questions remaining.
5. **The reveal** — the concept strength map. Named weaknesses, ranked by mark impact.
6. **First action** — one recommended practice set, pre-loaded.

| Decision | Justification |
|---|---|
| **No paywall anywhere in onboarding** | The map *is* the acquisition mechanism; gating it destroys the funnel. |
| Diagnostic is skippable, resumable, and produces a partial map on abandonment | A student who bails at item 12 has still told us something. |
| Scope declaration is chapter-level, never topic-level | Topic-level is a 200-checkbox form nobody completes honestly. |
| The reveal names concepts in the student's own vocabulary, worst first | "You're losing marks in Rotational Motion" lands; "Concept mastery: 34%" does not. |
| Confidence is shown honestly — "based on 3 questions" | Overclaiming from thin evidence destroys trust in the map permanently. |

---

## 6. Home — The Next-Action Surface

**Not a dashboard.** One primary recommendation, its reason, and escape hatches.

**Structure, top to bottom:**
1. **One recommended action** with a stated reason ("8 questions on Thermodynamics — your weakest high-weight chapter")
2. **Overdue reviews**, if any — these outrank new material
3. **Continue** — any unfinished session
4. **Upcoming mock**, if scheduled
5. **Two alternates** — for the student who disagrees with the recommendation
6. Streak / goal state, quietly

| Decision | Justification |
|---|---|
| **Exactly one primary action** | Three equal options is a decision; a student with 40 minutes wants a start, not a menu. |
| Every recommendation states *why* | An unexplained recommendation is ignored; an explained one is trusted or corrected. |
| The student can always override, and overrides are remembered | Recommendation is advice, not instruction. |
| Gated recommendations are marked before the tap, not after | A paywall discovered after committing feels like a trap. |
| No score, rank, or countdown-to-exam on Home | Anxiety on open reduces the odds the student starts. |

---

## 7. Practice Flow

```
Entry → Setup → Session → [per item: attempt → feedback → next] → Summary → Next action
```

| Step | Design |
|---|---|
| **Entry** | From recommendation (pre-configured, zero setup) or self-directed (Setup screen). Recommendation entry is the default and skips step 2 entirely. |
| **Setup** *(self-directed only)* | Subject → chapter → optional difficulty. Scope-filtered by default with a visible override. Count or duration, not both. |
| **Attempt** | Item fills the screen. No timer by default. Flag and skip always available. |
| **Feedback** | Immediate. Correctness → **the chosen distractor's specific misconception first** → correct approach → concept link. |
| **Between items** | Auto-advance after feedback is dismissed; no confirmation. |
| **Summary** | Accuracy, time, concepts touched, and — the point — *what changed in the map*. |
| **Next action** | One tap: continue, or move to the next weakest concept. |

| Decision | Justification |
|---|---|
| **Distractor-specific explanation leads the feedback** | This is the differentiated content; burying it under a generic solution wastes it (Moment 2). |
| Solutions unlock after attempt or explicit skip — never before | The effort gate is what makes the solution land. |
| No timer in practice unless requested | Practice is for learning; timing pressure belongs in mocks. |
| Sessions pause indefinitely and resume on any device | Practice happens in 10-minute fragments on a commute. |
| Abandonment keeps every answered response | Partial work is still evidence. |
| Quota exhaustion never interrupts a running session | Ending a session mid-flow to sell something is the worst possible moment to sell. |
| The summary reports **map movement**, not just accuracy | "Rotational Motion: weak → developing" is the reward; "you got 6/8" is a scoreboard. |

---

## 8. Mock Exam Flow

The highest-stakes flow. Trust is the entire design goal.

### 8.1 Pre-flight

1. **Rules** — duration, marking scheme, navigation rules. Acknowledged explicitly.
2. **Readiness** — package downloading with visible progress; storage and connectivity checked.
3. **Commitment** — "Start" is deliberate and clearly irreversible.

| Decision | Justification |
|---|---|
| The full package downloads **before** the timer starts; incomplete download blocks the start with a remedy | Failing at minute 90 is unacceptable; failing at minute 0 is merely inconvenient. |
| The marking scheme is shown before every mock, including repeats | Negative marking strategy is what the mock is meant to train. |
| Pre-flight explicitly states **"you can finish this without internet"** | This is the product's strongest reliability claim and students will not assume it. |

### 8.2 During

Chrome-less. Exam-accurate. Nothing that isn't in the real exam.

| Element | Design |
|---|---|
| **Timer** | Always visible. Calm until thresholds; announced at 30/10/5/1 min. |
| **Palette** | Per-item state: unvisited · answered · unanswered · marked · answered-and-marked. Bottom sheet on mobile, sidebar on desktop. |
| **Navigation** | Free across sections (JEE/NEET pattern). Next/previous plus palette jump. |
| **Sync indicator** | Persistent, calm. **"Saved on this device"** — never an error, never a warning. |
| **Nothing else** | No notifications, no analytics, no A/B code, no chat, no help beyond exam rules. |

| Decision | Justification |
|---|---|
| **Connectivity loss is a status, not an error** | The student is mid-exam. An alarming message costs marks even though nothing is wrong. |
| No feedback, hints, or correctness during the attempt | Exam fidelity is the whole point of a mock. |
| Exit requires deliberate confirmation naming the consequence | Accidental exit is the failure this flow exists to prevent. |
| Auto-submit at expiry is silent and complete — never framed as a failure | Running out of time is a normal exam outcome. |
| Submission confirmation is unambiguous and shows the sync state | "Did it save?" is the single most anxiety-producing question in the product. |

### 8.3 Interruption recovery

Re-entry restores full state with elapsed time correctly accounted, and says so plainly: *"You have 47 minutes remaining. All your answers are here."* No blame, no explanation of what went wrong, no data loss.

---

## 9. Post-Mock Diagnostic — The Product

Moment 3. The highest-intent ten minutes in the entire experience.

**Sequence:**
1. **Score** — total and sectional. Immediate. Nothing else on screen.
2. **The one thing** — the single largest cause of lost marks, stated in a sentence.
3. **Ranked findings** — three to five, ordered by *estimated mark impact*, each with:
   - what happened, in plain language
   - the evidence, drillable
   - **one tap to fix it**
4. **Full report** — everything else, below the fold.

| Decision | Justification |
|---|---|
| **Findings ranked by mark impact, not by count** | Five careless errors matter less than one missing chapter; sorting by frequency inverts the priority. |
| **Every finding has a one-tap remediation** | This is the conversion the product is measured on. |
| Findings are causes, not statistics | "You lost 24 marks to negative marking on questions you were unsure about" — not "accuracy: 61%." |
| Rank and percentile are opt-in and never the first screen | Rank motivates a few and demoralizes the rest; the diagnosis helps everyone. |
| Time analytics distinguish **slow-and-correct** from **slow-and-wrong** | Opposite problems requiring opposite interventions; conflating them gives useless advice. |
| Free tier sees the top findings in full, not a teaser | A truncated diagnosis is worse than none and poisons the upgrade decision. |
| Item-by-item review is a separate destination | Two different jobs: understanding the pattern, and understanding question 47. |

---

## 10. Teacher Flows

### 10.1 Authoring

```
Concept → Draft → Structure → Validate → Submit
```

| Decision | Justification |
|---|---|
| **Dual-mode notation input**: LaTeX for fluent authors, visual palette for everyone else, switchable mid-item | Forcing LaTeX excludes most subject experts; forcing a palette insults the fluent ones. |
| **Live preview renders exactly what the student sees**, at mobile width by default | Authoring on desktop for a mobile audience without a mobile preview guarantees broken items. |
| Stimulus is created and attached as a first-class object, not pasted per item | Pasting a passage five times creates five divergent passages. |
| Validation is continuous and inline, blocking only at submit | Late-surfaced errors waste the whole authoring session. |
| Autosave, always; drafts recoverable | Losing 40 minutes of equation authoring ends the relationship with that author. |
| Blocking errors state what is missing and where — never "invalid item" | An author who can't find the problem submits nothing. |
| Distractor authoring prompts for the *misconception*, not just the wrong value | It gets the highest-value content authored while the author still has the item in their head. |

### 10.2 Review — designed for 60 items/hour

**A reviewer in flow state, one item at a time, everything on one screen.**

| Element | Design |
|---|---|
| **One item fills the screen** | Item, solution, tags, provenance, pre-check results with rationale, duplicate candidates side by side |
| **Single-keystroke decisions** | Approve · approve-with-edits · request changes · reject |
| **Fixed rejection taxonomy** | Chosen by key, never typed |
| **Auto-advance** | Decision → next item, no confirmation, no page transition |
| **Batched by concept** | Consecutive items share context |
| **Confidence-ordered** | Easy approvals first, building rhythm |

| Decision | Justification |
|---|---|
| **Nothing requires a click to reveal** | A click is two seconds; sixty items an hour makes that two minutes of pure loss. |
| Pre-check *rationale* is shown, not just a verdict | A reviewer must be able to disagree with the machine, which requires seeing its reasoning. |
| Edit-in-place without leaving the queue | Exiting to an editor breaks the flow state that makes the throughput possible. |
| Queue depth and pace are visible but never gamified | Reviewers respond to context; leaderboards produce rubber-stamping. |
| Undo window on every decision | Keyboard speed produces keyboard mistakes. |

---

## 11. Admin Flows

| Flow | Primary surface | Design decision |
|---|---|---|
| **Content operations** | Coverage dashboard — gaps ranked by exam weight × student demand | The daily question is "what's missing?", not "what exists?" |
| **Review queue management** | Depth, ageing, per-reviewer throughput | Capacity planning, never individual ranking |
| **AI generation** | Target concept → run → candidate dispositions → cost | Every run states cost before launch, not after |
| **Taxonomy migration** | Mapping with mandatory dry-run and exception list | Preview is not optional; the failure mode is silent and permanent |
| **Answer-key challenge** | Grouped per item, with empirical response data alongside | The adjudicator needs to see that strong students chose option C |
| **Re-scoring** | Mandatory dry-run: attempts affected, score deltas, rank movement | The highest-consequence action in the product |
| **Support console** | Account, subscription, sync state — read-only on academic records | Support cannot alter a score, and the UI must make that obvious |

| Decision | Justification |
|---|---|
| **Destructive actions require typed confirmation**, not a button | Re-scoring 40,000 attempts should feel heavy, because it is. |
| Impact preview precedes every bulk operation | "How bad would this be?" must be answerable before, not after. |
| Every admin action shows who will be notified | Silent changes to student records are a trust failure. |
| Ops surfaces are dense and keyboard-driven | These are professional tools used daily; spacious consumer layouts waste expert time. |

---

## 12. Empty, Error & Degraded States

A cold-start product spends its first weeks in empty states. They are designed, not defaulted.

| State | Design |
|---|---|
| **New user, no data** | The diagnostic invitation — the only genuinely useful thing to offer |
| **Concept map, insufficient evidence** | "Not enough data yet — answer 5 more" with the action attached. Never a hollow chart. |
| **No content for a filter** | Nearest available alternative offered, never a dead end |
| **Offline** | A first-class state, not an error. What still works is stated plainly. |
| **Sync pending** | Calm and explicit: "Saved on this device. Will sync when you're online." |
| **Quota exhausted** | Names precisely what is gated and what upgrading provides. Never mid-session. |
| **Item retired** | Bookmarks and history preserved, marked, with a replacement offered where one exists |
| **Result embargoed** | The release time, stated |
| **AI unavailable** | The feature is marked unavailable; nothing else changes |

**Rule: an empty state either offers an action or explains what will fill it. Never both blank and silent.**

---

## 13. Accessibility as Experience

Mechanics are in the frontend doc. The experience decisions:

| Decision | Justification |
|---|---|
| **A screen-reader user must complete a full mock in standard time** — the acceptance test | Everything else is a proxy for this. |
| Mathematical notation carries an authored reading, not a generated one | Auto-generated readings of dense notation are technically compliant and practically unusable. |
| The timer announces at thresholds only | A live-region timer reading every second makes the exam impossible with a screen reader. |
| Mastery states carry **shape and label**, not colour alone | Weak/developing/strong appear on a dozen screens; colour-only encoding fails a meaningful share of a 2M-student cohort. |
| Extended time is applied silently, without visual markers | Accommodation must not be visible to anyone but the student. |
| Every diagram has an authored description written by the item's author | The author knows what the diagram means; nobody downstream does. |
| The full flow works at 200% text scaling | Indian Android users scale text far more than Western defaults assume. |

---

## 14. Responsive Behaviour

| Surface | Mobile (360–767) | Tablet (768–1023) | Desktop (1024+) |
|---|---|---|---|
| **Learn** | Primary. Bottom tabs, sheets, single column | Wider reading measure, same structure | Centred column — **not a redesign** |
| **Exam runtime** | Palette as bottom sheet | Palette as sidebar | Palette as sidebar |
| **Concept map** | Ranked list | List + detail | List + detail + trend |
| **Diagnostic report** | Stacked, one finding at a time | Two-column | Two-column with persistent drill-down |
| **Studio** | ❌ Gated | ❌ Gated | Primary, ≥ 1280px |

| Decision | Justification |
|---|---|
| **Item presentation is identical at every size** | It is exam fidelity; layout must not change what a question looks like. |
| Learn on desktop is a wider column, not a bespoke layout | Students overwhelmingly use phones; a desktop redesign is cost without return. |
| Studio is hard-gated below 1280px with an explicit message | An authoring tool on a phone is a fiction; pretending otherwise costs real engineering. |
| Long equations and wide tables scroll **inside their container** | The page must never scroll horizontally. |
| Safe-area insets honoured everywhere | Losing the submit button to a home indicator is a real, expensive failure. |

---

## 15. Tone & Microcopy

The audience is 16–19, under sustained pressure, often at 1 a.m.

| Principle | Example |
|---|---|
| **Name the problem, don't soften it** | "You're losing 20 marks a paper to careless errors in Organic Chemistry" — not "there's room to improve!" |
| **Never congratulate on nothing** | No confetti for opening the app. |
| **Failure is information, not judgement** | "That's a common trap — here's why it's tempting" — not "Incorrect." |
| **The system takes blame for system problems** | "We couldn't reach the server" — not "Your connection failed." |
| **No urgency manufacturing** | The exam date is pressure enough; we never add to it. |
| **Every gate states the trade** | "See step-by-step solutions for every question — ₹1,299/year" — not "Unlock premium!" |
| **Errors are actionable** | What happened, what to do, and a way out. Always all three. |

---

## 16. UX Success Metrics

| Metric | Target | Moment |
|---|---|---|
| Signup → first diagnostic complete | ≥ 70% | 1 |
| Time to first weakness named | ≤ 10 min | 1 |
| Distractor explanation viewed on wrong answers | ≥ 60% | 2 |
| **Mock result → remediation tap within 48 h** | **≥ 50%** | 3 — the product's core conversion |
| Home recommendation accepted (vs. overridden) | ≥ 40% | 4 |
| Mock completion rate (started → submitted) | ≥ 85% | 5 |
| Mock abandonment attributable to platform | ~0% | 5 |
| Screen-reader mock completion in standard time | 100% | — |

---
