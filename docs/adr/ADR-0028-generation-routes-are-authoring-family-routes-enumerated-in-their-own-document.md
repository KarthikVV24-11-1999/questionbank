# ADR-0028 — Generation's routes are authoring-family routes, enumerated in their own document

**Status** Accepted · M5 Track G, M5-38

## Context

ADR-0009 splits the payload surface into an authoring family, which may carry an answer key, and
everything else, which never does. The family is `/v1/authoring/**`, enumerated and closed in
`x-authoring-routes` in `content.yaml`, and the list is held against the document in both directions.

A generation candidate carries a proposed item, and a proposed item carries its answer key: the
context's own query handlers say so ("the proposal carries its own answer key, so these are
authoring-surface reads"). Reading a candidate over HTTP is therefore an authoring read, and the
routes that do it belong to the family. They cannot go in `content.yaml`: that document is content's
contract, and generation is downstream of content (ADR-0025).

## Decision

Generation's three routes live in `packages/contracts/openapi/generation.yaml` under `/v1/authoring/`,
and that document carries its **own** closed `x-authoring-routes`, held against its paths in both
directions by `generation-contract.spec.ts` with planted drift in each direction. This extends
ADR-0009 condition 1 to a second document; it does not loosen it. The family is still enumerated, a
path is still never inferred from a prefix, and a lookalike (`/v1/authoring-preview/…`) is still
refused.

Two further assertions keep the family closed across documents: no other document (curriculum,
scoring) declares a `/v1/authoring` path, and no generation path appears in content's list.

The routes are an operator starting a run and reading what it produced:

| Route | Handler | Who |
|---|---|---|
| `POST /v1/authoring/generation-runs` | `StartGenerationRun` | `content_ops`, `generation_pipeline` |
| `GET /v1/authoring/generation-runs/{runId}/candidates` | `ListRunCandidates` | `content_ops` |
| `GET /v1/authoring/generation-candidates/{candidateId}` | `GetCandidate` | `content_ops` |

**The five handlers without a route are named, as a set.** `ProposeCandidate` and `RunPrecheckBattery`
reach a model, and a request path that reached one would put live inference behind an HTTP call (F33);
`RecordPrecheckVerdict` is the battery's write and a route to it would be a route to write the result
one wanted; `SweepReviewAgeing` set the precedent that a command only a scheduler would call has no route
(DEC-M4-15). `AcceptCandidate` and `RejectCandidate` are the human's decision and are not yet on the
surface. The contract spec asserts the unrouted set against the declared handlers, so a ninth handler
cannot arrive without a routing decision.

F33 is enforced by `fitness/generation-rules.ts`: nothing in the context's `api/` may import a provider
adapter or name the handlers that reach one, proven red against a planted controller.

## Consequences

- Adding a generation route is a two-place change — the controller and `x-authoring-routes` — and fails
  until both are done, the cost ADR-0009 already accepted for content.
- Accept and reject have no HTTP route. Until they do, the only caller of those handlers is code that
  holds the registry; whether a decision is made through this API or through the review workspace is a
  product decision recorded for Track H.
