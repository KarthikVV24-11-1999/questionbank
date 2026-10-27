# ADR-0043 — Learning reads scoring and content through two seams, and the root joins them

**Status** Accepted · M7 Track A, M7-02 to M7-06 · Carries DEC-M7-1, DEC-M7-5; extends [ADR-0015](ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md)

## Context

Mastery is defined on per-slot outcome, item version, concept and difficulty. `AttemptSubmitted` and `AttemptScored` carry none of them, by
design: scoring's header says Learning reads the owning context rather than trusting a copy. Nothing existed to read through. Content holds
the tags and the authored difficulty and offered them to nobody; scoring held the outcomes and offered them to nobody.

## Decision

Each owning context offers one read through its `public/composition.ts`, as content offers its catalogue to assessment:

- `scoringForLearning` — `outcomesForAttempt`: for the attempt's current score record, `{ slotRef, itemVersionId, outcome, marksAwarded,
  marksAvailable }` per slot, marks as decimal text. The system's alone, no route.
- `contentForLearning` — `taxonomyForItemVersions`: for a set of version ids, `{ itemVersionId, conceptIdentityId, taxonomyVersionId,
  difficultyEstimate }`, batched, the **primary** tag only. A version is found if it has *been* published (`published_at`), so one since
  superseded or retired still resolves, as for `PostgresPublishedVersions`. The system's alone, no route.

`platform/composition/learning-evidence.ts` implements Learning's `MasteryEvidenceSource` port by joining the two on item version. It is
all-or-nothing: an attempt with a version content cannot resolve fails whole and names it. Only a `correct` or an `incorrect` outcome is
evidence; unattempted, dropped, bonus and indeterminate say nothing about what the learner knows.

**One response is one piece of evidence for the item's primary concept** (DEC-M7-5). The weights are never read. The evidence rows keep the item
version so a calibrated rule recomputes from history (D70).

`learning-rules.ts` holds the boundary: `contexts/learning/` has no production import of `contexts/scoring/` or `contexts/content/`, and
neither imports learning. It is stricter than F1, which admits a barrel import, and covers type-only imports and non-relative specifiers.

## Consequences

**Makes easy:** adding a source of evidence (a practice run) is another adapter in the root, with no change to Learning.

**Makes hard:** Learning cannot reach for a table. The evidence's `occurredAt` is the instant the score was written, not the instant each
response was given; the per-response time lives in assessment's log and no seam to it exists yet.

**Does not change** the composition-root rule (M5-37): the root imports only each context's `public/composition.js`, so Learning's composition
module re-exports the port and the one constructor the root needs.
