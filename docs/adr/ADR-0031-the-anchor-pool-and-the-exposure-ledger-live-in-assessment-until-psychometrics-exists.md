# ADR-0031 — The anchor pool and the exposure ledger live in assessment until Psychometrics exists

**Status** Accepted · M6 Track C, M6-15 and M6-18 · Diverges from DOMAIN-MODEL's context map

## Context

DOMAIN-MODEL's context map gives exposure and anchoring to **Psychometrics**, context 6: `ExposureLedger` is
there, and the equating machinery that consumes anchors is there. ROADMAP lists both as M6 deliverables —
every form carries 15% anchor items from a stable pool, and assembly writes an exposure ledger — and
Psychometrics is M11's. Nothing in M6 may wait five milestones for a context.

Form assembly needs both *now*. Assembling a form without knowing what has been over-exposed is assembling it
blind, and ASSESSMENT-ENGINE §10 is blunt that anchors cannot be retrofitted: a form assembled without them
can never be equated to anything. Building a whole Psychometrics context to hold one table and one
designation, five milestones early, is the mistake the project already made once with a context it did not
yet need.

## Decision

**Both live in `contexts/assessment/` and move when Psychometrics lands.**

- **The anchor pool** is `assessment.anchor_pool_member`: a stored fact that an item *version* is a member,
  when it joined, how many forms it may anchor, and when it left. Membership is never derived.
- **The exposure ledger** is `assessment.exposure_ledger_entry`: one row per slot of a published form,
  keyed on the form, the slot's item version and the session the form was published for. It is written at
  publication, in the transaction that publishes, and by nothing else.

Each is reached through a port the assessment domain declares, so the move is a change of adapter and a
migration of rows, not a change to anything that assembles or publishes.

### The trigger for moving them

**Whichever comes first:** the Psychometrics context existing, or a second consumer of exposure or anchor
data appearing. A second consumer is the signal that the data has stopped being assembly's private
bookkeeping and become something other contexts depend on — which is what a context boundary is for.

## What the divergence does not change

- Neither table has a foreign key out of `assessment` (§9 rule 3). Item versions are identifiers carried, not
  joined.
- The ledger is append-only at the database, and cannot be written once the form is published, so no
  attempt-time path can write it even by mistake.
- Publication checks the anchor floor against the pool, in the same transaction that writes the ledger and
  changes the form's state, or none of the three happens.

## Consequences

- Psychometrics, when it arrives, inherits two tables with their history intact; it does not have to
  reconstruct what was anchored or exposed, which §12 says it could not.
- Until then a reader looking for exposure under Psychometrics in the context map will not find it, which is
  why this record exists and is cited from the code that holds them.
