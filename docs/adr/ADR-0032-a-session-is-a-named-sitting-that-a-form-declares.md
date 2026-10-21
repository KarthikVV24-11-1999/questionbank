# ADR-0032 — A session is a named sitting, and a form declares which ones it is published for

**Status** Accepted · M6 Track D, M6-21 · Clarifies ASSESSMENT-ENGINE §10 and §12

## Context

ASSESSMENT-ENGINE §12 captures two things for multi-shift normalization — *per-item exposure with form and
session identity*, and *attempt-level session and shift identity* — and §10 says the normalization is "raw →
within-session percentile", supported by the same anchor data. That computation groups attempts by session
and reads the exposure recorded for that same session.

Track C captured both halves and nothing related them. The form's session was free text that the ledger
copied; the attempt carried a `uuid` its caller supplied; `shift_id` was a third free-text label. No table in
any context defined a session, so nothing could say the three named the same sitting — and the type difference
meant the composite foreign key that would have forced it could not even be written. The capability both
rows were captured for did not exist, and §12 is explicit that the data cannot be rebuilt later.

## Options

1. **A session becomes an entity**: a table that forms and attempts both reference. Honest, and a new
   aggregate nobody has asked for, with a lifecycle, an owner and a place in the context map to argue about.
2. **Session identity becomes one type carried by the form**, and everything else is tied to it by composite
   foreign key, exactly as the attempt's mode, the attempt's window and the ledger's session already are.

## Decision

**Option 2, with one refinement: a form declares a *set* of sessions, not one.**

A session is **a named sitting**, and its identity is a canonical text key — trimmed, non-empty, never the
`unassigned:` placeholder. It has no table of its own. It exists because a form says so:
`assessment.form_session (form_id, session_ref)` lists the sittings a form is published for.

- The ledger's `session_ref` is keyed to `form_session`. A form published for two sessions writes a row per
  slot **per session**: the same item sat in two sittings was exposed twice, and the sittings are what
  normalization groups by.
- The attempt's `session_ref` is keyed to the same row by a composite foreign key. An attempt **cannot
  name a session its form was not published for**, and the database says so; the domain copies the session
  from the form's list and refuses one it does not hold.
- Publication refuses a form with no session, and refuses one whose ledger does not cover every slot in every
  session.

### Why a set

§287 describes multi-shift normalization as the case "if scheduled mocks ever run in multiple sessions" — one
paper, several sittings. A single session per form would make that case unrepresentable, and the join the
whole exercise exists for ("exposure for this session, attempts in this session") needs more than one session
to mean anything.

### Where `shift_id` sits

**Beside the session, not inside the key.** It stays a caller-supplied, non-blank label *within* a session
and is carried on the attempt, not joined to anything. Making it part of the key would invent a second
dimension the documents have not defined; leaving it a label records what §12 asks for ("shift identity")
without pretending it is enforced. If shifts turn out to need their own identity — their own windows, their
own papers — that is the moment for option 1, and this decision makes it a migration of one table rather than
of every row.

### What goes

The attempt's `session_id` (a `uuid`) is dropped. It was meant to be the authentication session, which never
ended an attempt (§5: "session expiry never ends an attempt") and is not what §12 means. The form's single
`session_ref` column is dropped for the set.

### The `unassigned:` placeholders

M6-18 backfilled `unassigned:<form_id>` onto forms that predated the column. Those are not sessions. The
migration therefore: leaves a **draft** carrying one with no session, so it must declare real ones before it
can be published; and **refuses to run** if a form past draft carries one, because such a form cannot be edited
and inventing a session for a sitting that may already have been sat would be wrong. There are none outside a
test database — the repository holds no production data — which is exactly why this is cheap now and
impossible after real sittings exist.

## Consequences

- Sessions of one form share its schedule window. That is a limitation, not a decision: per-session windows
  would need the window on `form_session`. D56 records it with its trigger.
- Per-session reads are one query: `ExposureLedger.exposureBySession` joins ledger rows to the attempts that
  sat them, by the shared key.
- DOMAIN-MODEL's `Attempt` and `Form` key attributes and ASSESSMENT-ENGINE's §12 rows read true afterwards.
