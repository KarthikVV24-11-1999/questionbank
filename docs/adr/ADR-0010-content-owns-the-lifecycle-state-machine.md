# ADR-0010 — Content owns the lifecycle state machine; M4 owns the workspace
Status: Accepted
Date: 2026-08-09
Relates to: M3-10, M3-11, M3-28 · FR-QM-01, INV-07, INV-12 · [ROADMAP.md](../ROADMAP.md) M3/M4
Ratified as: [M3-CONTENT-MODEL.md](../tasks/M3-CONTENT-MODEL.md) DEC-1

## Context

[ROADMAP.md](../ROADMAP.md) lists **"Lifecycle state machine (FR-QM-01) with all
transitions permission-gated"** as an **M4** deliverable.

The same document lists, as an **M3** acceptance criterion, **"Publication
blocked without tags, provenance, resolved licensing, or a solution."**

Those cannot both hold as written. The thing being blocked *is* a lifecycle
transition. M3 cannot block a transition that does not exist yet, and the two
ways of proceeding without the state machine are both worse than the
divergence:

- **Enforce the preconditions in the Studio surface M3 ships.** This is
  forbidden outright — publication preconditions are enforced in the domain,
  not in the UI. It also fails the moment anything publishes through the API,
  an import, or a script, which M3 itself delivers at M3-30.
- **Ship M3 with an unguarded publication path and add the guard in M4.** For
  the intervening milestone, "published" means whatever the caller asserted.
  INV-07 and INV-12 would be documented rather than enforced, and content
  authored during M4's own build-out — which is when human authoring is
  scheduled to begin — would be the content least protected by them.

There is a real M3/M4 boundary here; it is just drawn in a different place than
the ROADMAP put it.

## Decision

**M3 owns the lifecycle state machine and every publication precondition, in
the domain. M4 owns the workspace that drives them.**

| M3 (`contexts/content/domain/`) | M4 |
|---|---|
| The eight states and thirteen legal transitions | `ReviewAssignment` — routing, queue mechanics, subject scope |
| Refusal of every transition the table does not name | Ageing and escalation to Content Ops |
| Publication preconditions: tags, provenance, resolved licensing, a solution, a reviewer signature, a valid answer specification, a passing render check | The reviewer's screen, batching, auto-advance, undo window |
| INV-12 self-review, checked at the transition | INV-12 checked again at *assignment*, which is where it is cheap |
| INV-01: a human signature required on AI-sourced provenance | `ReviewDecision` capture, the rejection taxonomy, approve-with-edits |
| An authorization policy on every transition handler (F36) | Duplicate detection, `ItemDefect`, `AnswerKeyChallenge` |

The split is a **risk boundary rather than a convenience one**. The state
machine is where an invariant becomes structural; the workspace is where
throughput is won. They have different failure modes: a defect in the machine
publishes something that should not exist, and a defect in the workspace makes
a reviewer slower.

M4's ROADMAP line is amended in effect to "**Review workspace** with all
transitions permission-gated" — the permission gating is M4's, because the roles
and the assignment model are M4's; the transitions themselves are already here.

## Consequences

**INV-07 and INV-12 are enforceable from M3 onward**, on every path — HTTP,
import, script, test — because they sit in the aggregate rather than in a
surface. The publication precondition is not something a caller can forget to
call: `transitionItem` refuses `publish` outright and directs the caller to
`publishVersion`, which will not proceed on an unsatisfied verdict.

**M4 gets a smaller, better-defined job.** It builds against a machine that
already exists and is exhaustively tested, instead of designing the machine
under the time pressure of also hitting 40 items/hour.

> **Correction note, 2026-08-26 (M4-44).** The sentence above is unchanged and
> still describes the decision correctly. Recording alongside it what M4
> established: that rate is **`Fail — blocked`** — no reviewer pool exists
> (DEC-M4-5), so the time pressure this ADR anticipated never materialised in
> the form it expected. The phrase is left in place rather than edited,
> because the ADR is a record of what was decided and why, not of what later
> turned out to be measurable.

**The exhaustive matrix is the proof.** `item-lifecycle.spec.ts` sweeps all
8 × 9 = 72 state/transition pairs against a legal-transition list written out
independently of the implementation table. Thirteen are permitted; the other
fifty-nine each return `RuleViolation` naming what was attempted. A transition
added to the table without being added to the list fails, and so does the
reverse.

Makes easy: enforcing a publication rule once, where every caller meets it.

Makes hard: nothing in M4. The workspace still has to be built; it simply has
something to drive.

Foregoes: nothing. If M4 finds the state machine wrong, changing it is a change
to one table with 72 tests over it.

## Alternatives

**Follow the ROADMAP literally and defer to M4.** Rejected: it makes M3's own
headline acceptance criterion unsatisfiable, and the only way to appear to
satisfy it is to put publication rules in the Studio UI, which is prohibited.

**Split the machine — M3 owns `publish`, M4 owns the rest.** Rejected: a state
machine with two owners is a state machine with no owner. The illegal
transitions are the valuable part, and they are only meaningful as a complete
table.

**Amend the ROADMAP instead of writing an ADR.** Worth doing, and recorded as
debt — the ROADMAP should show the corrected split so the next reader does not
rediscover this. But the ROADMAP is an approved document, and a task breakdown
that silently contradicts one is how the next reader learns approved documents
are unreliable. The ADR is the record; the ROADMAP edit follows it.
