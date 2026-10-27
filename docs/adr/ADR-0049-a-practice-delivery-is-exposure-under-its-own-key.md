# ADR-0049 — A practice delivery is exposure, under its own key

**Status** Accepted · M7 Track D, M7-30 · Applies ASSESSMENT-ENGINE §6 and §12 to practice

## Context

The exposure ledger is the one record that stops an item being burned. Each row was tied to a form slot and to the form's session by composite keys
(`exposure_ledger_matches_slot`, `exposure_ledger_matches_session`), and written once, at publication. A practice run has no form and no session, and it is the delivery
path that will carry the most volume. Exempting practice from the session key would have left the ledger silently incomplete for exactly that path.

## Decision

Practice exposure needs a different key, not an exemption. A ledger row now describes **exactly one** of a form slot or an attempt slot:

- `exposure_ledger_describes_one_slot` — `(form_id IS NULL) = (attempt_id IS NOT NULL)`, for every row;
- `exposure_ledger_form_columns_travel_together` — the session and the anchor flag are present exactly when the form is;
- `exposure_ledger_matches_attempt_slot` — a composite key onto `attempt_slot (attempt_id, slot_id, item_id, item_version_id)`, so a row cannot name a version or item its slot does
  not hold; `exposure_ledger_one_row_per_attempt_slot` — a slot is counted once;
- the existing keys fire whenever their columns are present, unchanged.

The other direction — that a practice slot cannot be delivered without its row — is a deferred constraint trigger on `attempt_slot`: at commit, every slot of an attempt with no
form has its ledger row, or the transaction fails. The attempt repository writes the slot and its row in one transaction, and the insert trigger refuses a practice row unless its
attempt has no form and is still being sat. A fitness spec names the two files that may insert into the ledger (publication, and the attempt that pins a practice slot) and fails on a third,
shown against a planted writer.

**Counted:** `countsByItemVersion` includes practice deliveries, so exposure balance and an anchor's cap see them. **Not counted:** per-session normalization (ADR-0032) joins exposure to the
attempts of a form's session; a practice run has no session, so `exposureBySession` reads form rows only. Practice selection never offers an anchor.

## Consequences

**Makes easy:** an item's total exposure is one query; a practice delivery cannot be forgotten, because the database refuses the commit.

**Makes hard:** an item that is practised heavily looks heavily exposed to form assembly, which prefers the least exposed. That is the intended pressure — an item every learner has already
practised is a poor choice for a mock — and the volume of rows is the cost; they are append-only and indexed by item version.
