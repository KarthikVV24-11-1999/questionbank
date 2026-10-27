# ADR-0044 — Evidence names its difficulty an estimate, and carries its concept

**Status** Accepted · M7 Track A, M7-04 · Departs from [DOMAIN-MODEL](../DOMAIN-MODEL.md) §9 `MasteryEvidence`; carries DEC-M7-3

## Context

DOMAIN-MODEL §9 gives `MasteryEvidence` as `{ attemptRef, slotRef, itemVersionRef, outcome, itemDifficulty, occurredAt }`, held inline under
a `ConceptState`. Two things in it do not survive M7. `itemDifficulty` is a Psychometrics fact, and context 6 does not exist, so what is
available is the item's *authored* band. And a standalone evidence row, which is what the port yields, does not sit under a concept, so the
concept it is evidence for has to be on the row.

## Decision

The value Learning defines is `{ attemptRef, slotRef, itemVersionRef, conceptIdentityId, taxonomyVersionId, outcome, difficultyEstimate,
occurredAt }`. `difficultyEstimate` replaces `itemDifficulty` and takes one of the four authored bands; it is an author's judgement and not a
measured p-value, and the name carries that so no later reader has to infer it (D71). `conceptIdentityId` and `taxonomyVersionId` are added.
`ConceptState.difficultyBandDemonstrated` will be the highest authored band answered correctly, and is named the same way when built.

DOMAIN-MODEL §9 is left as written; this ADR is the record of the departure. When Psychometrics produces item statistics the field becomes
`itemDifficulty` as the document has it, and the states recompute from retained evidence.

## Consequences

The document and the code disagree on one field name until D71 closes. The disagreement is intended and is held by a vocabulary spec against
content's band list.

The same section says ConceptMap consumes `ScorePublished`; the event the system emits is `AttemptScored`, which is what Learning consumes.
