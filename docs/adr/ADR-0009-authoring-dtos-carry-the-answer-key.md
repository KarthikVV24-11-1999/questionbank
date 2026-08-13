# ADR-0009 — Authoring DTOs carry the answer key; delivery DTOs never do
Status: Accepted
Date: 2026-08-12

## Context

[ENGINEERING-HANDBOOK](../ENGINEERING-HANDBOOK.md) §9 rule 10 says *"answer keys
and solutions absent from every client payload"*, and fitness functions **F6**
and **F35** enforce it as a blanket check: no answer-key field in any DTO,
blocking on every commit. M2 satisfied it exactly — scoring explains a mark by
naming the rule that produced it, never by showing what the answer was, and its
contract spec asserts the absence over the whole OpenAPI document.

**M3 breaks that rule, necessarily.** The Item Editor is where an answer key is
written. An author choosing which option is correct, or typing an expected value
and its tolerance, is editing key material in a browser. There is no version of
an authoring surface that does not send the key to a client.

So the blanket rule cannot survive M3 as written. It can be:

1. kept literally, and the authoring surface built some other way — there is no
   other way;
2. quietly relaxed, with the check narrowed until it passes; or
3. amended, with the exception enumerated and the enforcement made stronger
   rather than weaker.

Option 2 is the dangerous one, and it is the one that happens by default: a
gate that starts failing gets adjusted until it stops, and what remains is a
rule nobody can state. The answer key is the asset M3 introduces that can
actually harm someone if it leaks — a leaked key is an invalidated paper and a
corpus of items that have to be rewritten.

## Decision

The payload surface splits into two families, and the split is enforced
structurally rather than by care.

| Family | Routes | Carries a key? | Policy |
|---|---|---|---|
| `Authoring*` | `/v1/authoring/**` only | **Yes** — that is what an authoring surface is for | Author (own drafts), Reviewer, Content Ops. Never a learner role |
| `Delivery*` | everything else | **Never**, on any code path and for any role | As applicable |

F6/F35 are amended from *"no answer-key field in any DTO"* to *"no answer-key
field in any DTO outside the enumerated authoring family, **and** the key
present on every authoring schema that is supposed to carry one, **and** the
authoring route list asserted against the OpenAPI document."*

Three conditions bind the amendment. They were ratified with DEC-4 before M3-01
and are not negotiable at the point of enforcement:

1. **The authoring route list is enumerated and closed.** It lives in
   `packages/contracts/openapi/content.yaml` as `x-authoring-routes`. Adding to
   it is a reviewed change to a named constant, never an inference from a path
   prefix at runtime — a prefix check makes `/v1/authoring-preview/…` an
   authoring route by accident.
2. **The check asserts both directions.** Keys **absent** from every delivery
   schema, and **present** on every authoring schema that is supposed to carry
   one. A one-directional check passes when somebody silently removes the key
   from the editor, which is a broken product nobody notices, and it passes on
   a delivery schema whose key-bearing field is named something new.
3. **No `Authoring*` DTO is reachable from a delivery controller**, asserted by
   **import graph** rather than by naming convention. A rename defeats a naming
   convention; it does not defeat an import.

The key-bearing fields are named explicitly rather than inferred: `answerKey`,
`correctOptionId`, `correctOptionIds`, `isCorrect`, `expectedValue`,
`toleranceValue`, `rangeMin`, `rangeMax`, `significantFigures`, the matching
`pairs`, and a solution's `finalAnswerAssertion`.

**Two consequences of the field list are worth stating, because both look like
omissions.** A matching item's *pairing* is the key — the members may be shown,
the pairing may not, so `DeliveryItem` carries `matchingLeft` and
`matchingRight` and no `pairs`. And a delivery solution carries the derivation
but **not** the final-answer assertion: as a structured field that is a
correct-option marker or an expected value, which is the key by another name.
The steps state the answer in prose, which is what INV-08 actually grants.

## Consequences

**Makes easy.** An authoring surface that can do its job. A reviewer reading a
diff can see which family a new view joined, and a new key-bearing DTO on a
delivery route fails a test rather than a review.

**Makes hard.** Adding an authoring route is now a two-place change — the route
and the enumerated list — and the check fails until both are done. That is the
cost of the amendment and it is the point of it.

**Forecloses.** Inferring the family from a path prefix, a naming convention or
a decorator. Each is one rename or one typo away from silence.

**Does not cover.** The import-graph condition is asserted at M3-44, once there
is a controller layer to assert over (M3-34). Until then the split holds at the
document and at the view constructors, and the third condition is stated but
not yet enforced — recorded so the gap is visible rather than assumed closed.

## Alternatives

**Keep the blanket rule and render the key server-side.** The editor would
receive rendered HTML of its own form. It defeats INV-14 (structured markup,
never rendered markup), makes the editor unbuildable, and moves the key onto a
different payload rather than off one.

**Keep the blanket rule and encrypt the key in transit to the editor.** The
client still decrypts it, so the key still reaches the browser. It replaces an
enforceable rule with a ritual.

**Narrow F6/F35 to "no key on unauthenticated routes."** Authorization is not
the property being protected. A learner is authenticated, and the whole point is
that an authenticated learner must not receive a key.

**Drop the field-name list and check by type.** A structural check passes on a
field a spread carried in by accident, which is the exact way a key reaches a
payload. The list is longer to maintain and catches the case that happens.
