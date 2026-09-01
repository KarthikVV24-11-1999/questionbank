# Debt register

Known gaps, each with the trigger that closes it. An entry here is a decision to stop somewhere and
say so, not a thing forgotten.

**The code is the authority, not this file.** Every entry below is cited at the place it constrains —
usually a module header stating the gap in the terms that matter there. This register is the index:
it exists so a reader meeting `debt D25` in a comment can find out what D25 is. Where the two disagree,
the code is right and this file is stale, and `debt-rules.spec.ts` fails the build if an identifier is
cited without an entry here or carried here without a citation.

**`D1`–`D10` are not debt.** They are the domain-model design decisions in
[DOMAIN-MODEL.md](DOMAIN-MODEL.md) §"Decisions", which reuse the same prefix. Debt starts at `D11`.

Numbering has gaps. An identifier that never reached the code was retired before anything depended on
it, and inventing an entry to fill the hole would be recording a decision nobody made.

---

## Open

### D17 — Nothing drains the outbox

`platform.outbox_message` is written transactionally with the aggregate that produced the event, and
no relay consumes it. The payload discipline that matters is already enforced — identifiers and
version numbers only, never a stem, a key, a solution body or a reviewer's justification — precisely
because the drain target is analytics (P4).

**Trigger** The first consumer that needs events off the bus, or M7's learning loop, whichever comes
first.
**Cited** `contexts/content/domain/events/content-events.ts`, `infrastructure/outbox-emitter.ts`,
`contexts/scoring/public/composition.ts`, `platform/persistence/audit-anchor.ts`

### D19 — Chemical structures are out of the renderer's scope

Benzene rings, reaction schemes and mechanism arrows are authored as `MediaAsset` diagrams with
mandatory alt text and long descriptions, not as notation the renderer draws. A half-drawn ring tells
an author nothing; the documented affordance tells them exactly what to do (DEC-6).

**Trigger** A structural chemistry renderer worth trusting on the minimum device profile.
**Cited** `packages/content-renderer/src/chem-to-mathml.ts`, `chem-node.tsx`

### D23 — Curriculum exposes no concept → subject-domain lookup

Half closed. An in-scope author can no longer mistype their own subject: it is resolved from the
principal's subject scope where that is unambiguous. What stays open is the cross-check — nothing
compares a declared subject against the subject domain of the concepts actually tagged, so an author
scoped to more than one subject, or unscoped, can still mistag their own in-scope work. The Studio's
authoring views report `outOfScopeConceptIds: []` rather than guessing, which is honest: nothing was
found because nothing was checked.

**Trigger** Curriculum exposing a concept → subject-domain lookup through its public barrel.
**Cited** `contexts/content/domain/item.ts`, `application/authorization.ts`,
`application/queries/authoring-queries.ts`

### D25 — A published version cannot be corrected

Supersession has no producer. Publication is legal only from `approved`, and an item refuses a new
version in any state past draft, so nothing can be superseded today. The optional supersession field
is left unemitted rather than shipped as dead code pretending to be a feature.

**Trigger** Travels with the answer-key challenge to M5 (DEC-M4-6, [ADR-0022](adr/ADR-0022-item-defect-and-answer-key-challenge-move-to-m5.md)).
An upheld challenge needs a corrected published version, and this forbids exactly that — which is why
the intake was not built in M4.
**Cited** `application/handlers/lifecycle-handlers.ts`, [ADR-0018](adr/ADR-0018-approve-with-edits-keeps-the-author.md)

### D28 — A repository constraint violation can surface a raw driver message

An error crossing the repository boundary can still carry a Postgres message. Consumers defend
themselves rather than trust it: the Studio's item browser reads a transport error's own typed shape
(`ApiProblemError.problem.title`) and never `Error#message`.

**Trigger** The error taxonomy growing a constraint-violation kind that repositories map onto.
**Cited** `apps/studio/src/features/item-browser/ItemBrowser.tsx`

### D30 — The Studio route table is not a router

`use-route.ts` is a route table, not a router. The shape is already what TanStack Router consumes, so
the replacement is a swap rather than a rewrite.

**Trigger** The first nested route, or the first surface needing validated search state beyond M3-43's
URL filters.
**Cited** `apps/studio/src/shell/use-route.ts`

### D31 — No OpenTelemetry exporter

The span tree stands in for a trace and does not pretend to be one. Writing an exporter against an SDK
this repository cannot compile against would produce a file never type-checked against the API it
claims to implement, which is worse than its absence.

**Trigger** The OTel SDK becoming installable.
**Cited** `platform/observability/telemetry.ts`

### D32 — No S3 media store adapter

`@aws-sdk/client-s3` is not in the offline store, so the filesystem adapter is the only implementation.
It refuses to be selected when `NODE_ENV` is production — a boot failure, not a warning — so the
absence cannot quietly become the production configuration.

**Trigger** The SDK becoming installable.
**Cited** `platform/persistence/filesystem-media-store.ts`

### D33 — `subject` has no source on the authoring item view

Content attaches a concept, not a subject name, to a version's taxonomy tags, and resolving one to the
other is D23's lookup. The Studio's subject filter is therefore a no-op and the field is returned
empty rather than fabricated.

**Trigger** D23 closing, or content exposing a subject on the authoring query directly.
**Cited** `apps/studio/src/features/item-browser/item-browser-api.ts`,
`features/queue-management/queue-management-api.ts`

### D34 — One integration spec bypasses the typed client

The generated client's create-response type diverges from what the authoring command handler actually
returns, so that spec sets up through a plain `fetch`. Recorded rather than papered over, because the
divergence is the defect, not the workaround.

**Trigger** The next authoring command handler the divergence affects, or a client that needs the
create response's shape for more than the created `itemId`.
**Cited** `contexts/content/item-browser-live.integration.spec.ts`

### D35 — No atomicity across an event boundary

Nothing available today makes a cross-context reaction atomic with the fact that caused it. No relay
or outbox pattern in this repository supplies it, which is why the review domain's open questions are
stated as questions rather than answered with a mechanism that does not exist.

**Trigger** A relay with a delivery guarantee strong enough to answer it (see D17).
**Cited** `contexts/content/domain/review/index.ts`

### D36 — No scheduler, so the ageing sweep is never invoked

The sweep handler is built and tested; nothing calls it on a schedule, because no scheduler and no
deployment exist. Its scheduled invocation is `Fail — blocked` under
[ADR-0013](adr/ADR-0013-unrunnable-infrastructure-is-proven-by-parsing.md) — the handler is what M4
ships, and calling it hourly is the successor. Consequences are stated where they bite: queue health
derives overdue items from `ageState` rather than from `review_escalation`, which only the unscheduled
sweep populates, and `notifiedAt` absent means "not yet swept", never "not overdue".

**Trigger** A deployed environment with a scheduler.
**Cited** `application/review/handlers/ageing-handlers.ts`, `application/review/queries/queue-queries.ts`,
`contexts/content/domain/repository-ports.ts`, `fitness/platform-rules.ts`

### D37 — The review workspace cannot show a solution

The solution region reports `not_available` on every claim. No authoring-side query returns a
draft or in-review solution's content by item version id — only by a `solutionId` the workspace does
not hold. Named in the model rather than faked with an empty body.

**Trigger** An authoring query returning solution content by item version id.
**Cited** `apps/studio/src/features/review-workspace/review-workspace-model.ts`,
`review-workspace-api.ts`

---

## Closed

### D18 — Hand-written contract schemas *(closed for content)*

`packages/contracts/src/content-schemas.ts` is generated from `openapi/content.yaml` by
`scripts/generate-zod.mjs`, and the contract spec regenerates it and fails on any difference — so an
edit to the generated file is caught rather than merged. One contract has one description, and a
mismatch is fixed in the document, never in the copy. Curriculum and scoring have not been brought
onto the same footing.

### D20 — Lifecycle state machine attributed to the wrong milestone *(closed at M4-45)*

Delivered by M3, not M4. The machine lives in content's domain with an exhaustive 72-pair transition
matrix, and M4 built the workspace against it. ROADMAP amended;
[ADR-0010](adr/ADR-0010-content-owns-the-lifecycle-state-machine.md) records the divergence.

### D22 — Process-local idempotency store *(closed at M0-08)*

`PostgresIdempotencyStore` implements content's `IdempotencyStore` port unchanged — a port that had to
move to get a durable adapter would have been the wrong port. A key remembered by one instance is seen
by a new instance against the same database, which a process-local `Set` cannot do.

### D27 — No production `RenderValidator` adapter *(closed at M0-09)*

`RenderValidatorAdapter` maps `ItemVersion` onto what `validateRender` expects and maps the verdict
back, so M3-11's publication precondition runs against a real render rather than a test-supplied fact.
The original note called this "a composition gap rather than a design one" and undersold one
consequence: the API's own compiler must type-check the renderer's `.tsx`, which
[ADR-0016](adr/ADR-0016-the-api-type-checks-the-renderer-package.md) records and bounds.
