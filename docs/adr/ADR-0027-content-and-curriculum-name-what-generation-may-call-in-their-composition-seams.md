# ADR-0027 — Content and curriculum name what generation may call, in their composition seams

**Status** Accepted · M5 Track G, M5-37

## Context

Generation runs content's `CreateItemDraft`, `SubmitItemForReview` and
`GetDuplicateCandidatesForProposal`, and curriculum's `GetTaxonomyVersion`, and ADR-0025 says it does so
through injected ports, holding no content or curriculum code. Something has to inject them. The
composition root may import only each context's `public/composition.js` (DEC-M0-5, ADR-0015), and
neither context's `register` exposed a handler: they are built inside it and held in a module the root
never sees. Until now the tests assembled the wiring by hand, which is exactly the thing M5-37 exists
to end.

Track G's standing rule is that content, curriculum and scoring are not touched. The wiring cannot be
written without touching two of them, so the rule was put to a decision and the exception approved
for this one purpose.

## Decision

Each context's `public/composition.ts` gains **one additive export** that builds, from the same
assembly `register` uses, the handlers generation is allowed to call and nothing else:

- `contentForGeneration(deps)` returns `createDraft`, `submitForReview`, `duplicatesForProposal` and the
  pure validator `validateProposedContent`;
- `curriculumForGeneration(deps)` returns `taxonomyVersion`.

`register` itself changed only in that its repository construction moved into a shared `assemble`
function, so both exports build over identical repositories, audit recorder and idempotency store. A
draft generation creates is indistinguishable from one an author does, and content's own policies
authorize the human who accepted the candidate.

`seam-surface.spec.ts` holds each export to its exact key set and each module to its exact runtime
exports, so a fourth handler is a failing test and a reviewed edit. `fitness/composition-rules.ts`
holds the root to importing `public/composition.js` and nothing deeper — stricter than F1, which also
admits the public barrel.

## Rejected

- **Reading the module `register` returns**, finding the registry among its providers by shape. It
  touches nothing, and depends on content's private module layout, so a harmless refactor there would
  break the wiring silently.
- **Generation composing content's handlers itself.** That is generation holding content code, which is
  what ADR-0025 forbids.

## Consequences

- Content and curriculum's `public/composition.ts` are the only files outside the role vocabulary
  that Track G changed in those contexts, and the change adds; nothing a handler does is different.
- The same task found that `platform.audit_record` constrained `target_context` to content, curriculum
  and scoring, so the first generation command under the real recorder would have been rejected. No test
  met it because every generation test used a recording double. A migration widens the set; it is
  asserted by running generation's commands through the composed application against real Postgres.
- Without a provider the root composes generation with one that answers `Unavailable` (D45), and
  without pre-check configuration it composes every check as blocked, so nothing can be accepted until
  a deployment supplies them. A configuration that is supplied and cannot be right refuses boot.
