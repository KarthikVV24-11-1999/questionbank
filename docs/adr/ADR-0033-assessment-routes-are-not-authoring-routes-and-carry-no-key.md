# ADR-0033 — Assessment's routes are not authoring routes, and carry no key

**Status** Accepted · M6 Track D, M6-23

## Context

ADR-0009 splits the payload surface into an authoring family, which may carry an answer key, and
everything else, which never does. ADR-0028 put generation's routes in the family because a generation
candidate carries a proposed item and a proposed item carries its key.

Assessment's operator routes — assemble a draft form, read it, publish it, schedule it — are the same kind
of act (an operator's, `content_ops`), and it would be easy to file them with generation's. They are not the
same kind of *payload*. A form pins item **versions by id** and holds no stem, option, key or solution.

## Decision

Assessment's routes live in `packages/contracts/openapi/assessment.yaml` under `/v1/assessment/`, with their
own closed `x-assessment-routes`, held against the document's paths in both directions by
`assessment-contract.spec.ts` with planted drift in each direction. **They are outside the authoring family,
and so inside the rule that applies to everything outside it: no key.** The contract spec asserts the document
declares no `/v1/authoring/` path and no key-bearing schema field; the HTTP integration spec serializes real
responses from a real catalogue and scans them for key material and for the texts the solutions carry; and
the controller, its validators and the form view are named delivery surfaces in F6/F35's enumerated list, so
a key field added to any of them fails the gate.

The four routes:

| Route | Handler | Who |
|---|---|---|
| `POST /v1/assessment/forms` | `AssembleDraftForm` | `content_ops`, `system` |
| `GET /v1/assessment/forms/{formId}` | `GetForm` | `content_ops`, `system` |
| `POST /v1/assessment/forms/{formId}/publication` | `PublishForm` | `content_ops`, with step-up |
| `POST /v1/assessment/forms/{formId}/schedule` | `ScheduleForm` | `content_ops` |

`SweepWindows` has no route: it applies the clock to stored state and only a scheduler would call it (D36;
DEC-M4-15's precedent). The contract spec asserts the unrouted set, so a sixth handler cannot arrive without
a routing decision.

**An impossible blueprint and an exhausted search are different responses**: `ASSEMBLY_INFEASIBLE` is a `422`
that asking again will not change, `ASSEMBLY_SEARCH_EXHAUSTED` a retryable `503`; both name the blocking
constraint. Problem Details gains two RFC 9457 extension members for this, `reason` (the specific refusal;
`code` stays the platform's kind) and `constraint`.

## Consequences

- The route that serves a form's *package* to a student is a third thing — a delivery route with content in
  it — and is held to the same key-free rule by a stronger proof (a byte scan, M6-25).
- Step-up on publication is read from the `X-Step-Up` header exactly as content's publication does. That is
  content's existing convention and not a decision made here.
