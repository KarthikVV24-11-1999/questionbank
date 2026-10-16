# ADR-0024 — Generation is TypeScript until the Python ecosystem is actually needed
Status: Accepted
Date: 2026-10-16

## Context

[TECH-STACK](../TECH-STACK.md) §1 selects **Python 3.12 + FastAPI** as the AI/ML language, on a
stated premise: *"the embeddings and psychometrics ecosystem is unavoidable, and FastAPI keeps the
queue-consumer surface thin."* M5 is the first milestone that would build against that choice.

Three facts decide this, and the first is the one that matters.

**The premise has already been tested, and the answer is in the tree.**
[AI-ARCHITECTURE](../AI-ARCHITECTURE.md) §8 specifies duplicate detection as three fused signals —
normalized-text hash, trigram similarity, and **embedding cosine**. M4 shipped two of the three, in
TypeScript (`domain/review/fingerprint.ts`, `trigram.ts`), and
[ADR-0021](ADR-0021-duplicate-detection-is-advisory-and-three-labelled-groups.md) records why: the
choice of hashes and trigrams over embeddings "is a choice about explainability — a reviewer can be
told exactly why two items paired," with the cost stated plainly (no cross-subject detection, no
semantic similarity). The one piece of M5-adjacent work that genuinely needed the embeddings
ecosystem was examined on its merits and decided against.

**Nothing else on M5's path needs it either.** Taking the pipeline check by check: the CAS
verification path is already deferred for want of a runtime (debt **D39**); semantic search
(§9) is M6/M7, not M5; difficulty priors (§7) are advisory check 9, not blocking; psychometrics is
M11, after launch. What M5 actually builds — a provider port, the pre-check battery's orchestration,
`GenerationRun`/`GenerationCandidate`, budget enforcement at enqueue, the evaluation gate, prompt and
model version pinning, and an ACL into content — is governance and orchestration. That is what this
repository's TypeScript infrastructure already does: the handler registry, the composition seam
([ADR-0015](ADR-0015-the-composition-seam-is-a-fourth-barrel-export.md)), authorization policies,
and the fitness gates.

**There is no Python here at all.** Zero `.py` files, no service, no `uv`, no container. Adopting it
now means standing up a second runtime, its packaging, its deployment, a cross-service contract, a
second test harness and a second CI job — in a repository whose *existing* Dockerfiles do not exist
either (debt **D38**). It would add a second deployment story to a project that does not yet have a
first one.

## Decision

**`apps/api/src/contexts/generation/` is TypeScript**, a fourth bounded context alongside `content`,
`curriculum` and `scoring`, following the same fixed anatomy, the same public-barrel rules and the
same composition seam.

This is a divergence from an approved document and is recorded here rather than absorbed silently —
the discipline [ADR-0010](ADR-0010-content-owns-the-lifecycle-state-machine.md) and
[ADR-0022](ADR-0022-item-defect-and-answer-key-challenge-move-to-m5.md) both applied when scope moved
between milestones.

**The reversal has a named trigger, not an open-ended "later".** Adopt the Python service at
whichever comes first:

1. **Semantic search (§9) entering a milestone's scope** — it is specified as multi-vector
   embeddings with reciprocal rank fusion, stored in `content_embedding` and versioned by embedding
   model. There is no honest TypeScript answer to that; it is the workload TECH-STACK's premise was
   actually about.
2. **Difficulty estimation (§7) moving from advisory to blocking** in the pre-check battery, which
   makes a calibrated prior load-bearing rather than informational.
3. **D39's trigger firing** — a CAS path becoming buildable — since SymPy brings the runtime with it.

A divergence from an approved document with no named trigger is how the document becomes unreliable;
[ADR-0011](ADR-0011-pnpm-workspace-stands-in-for-turborepo.md) records the same reasoning for
Turborepo, and its trigger is now armed and measurable precisely because it was written as one.

## Consequences

**Makes easy:** generation composes exactly as the other three contexts do — one `register()`
returning a `DynamicModule`, reached only through `public/composition.js`. It inherits the handler
registry, the authorization-policy boot check (F36), the audit chain, the coverage thresholds and
every fitness gate without a line of new infrastructure. The ACL into content is an ordinary
in-process call through `contexts/content/public/`, not a network hop with its own failure mode.

**Makes hard:** when the trigger does fire, the embedding or CAS workload arrives as a *new service*
rather than a feature added to one that already exists — the cross-service contract, the deployment
and the packaging all get paid for then instead of now. That is the deliberate trade: the cost is
real but it is deferred to the point where something actually needs it, and it is bounded, because
the provider port and the pre-check battery are already interfaces rather than inlined calls.

**Forecloses nothing.** Nothing in this decision writes Python out of the architecture. TECH-STACK's
selection stands; this ADR defers it with a trigger, exactly as ADR-0011 defers Turborepo.

**EXT-05 is unaffected.** Provider substitution stays a ≤ 3-person-day change behind a stable
interface, because the adapter is isolated and the domain never sees it — which is a property of the
port's shape, not of the language it is written in.

## Alternatives

**Build the Python/FastAPI service now, as TECH-STACK specifies.** Rejected: its stated premise is
the embeddings and psychometrics ecosystem, and M5 touches neither. Building the runtime before the
workload is [DEC-M0-6](../IMPLEMENTATION-DECISIONS.md)'s mistake in a different costume — three
weeks of work several milestones early, in a place a later milestone would inherit or discard.

**Split M5: orchestration in TypeScript, the pre-check battery's model calls in Python.** Rejected as
the worst of both. It pays the full cost of a second runtime — packaging, deployment, a
cross-service contract — to host work that is HTTP calls to a provider API, which TypeScript makes
no harder. The split would be drawn where the cost lands, not where a capability boundary is.

**Adopt Python but leave it empty until needed.** Rejected: an unexercised service is the
vacuous-green pattern as infrastructure. It would have a Dockerfile nobody builds, a health check
nobody polls and a contract nothing calls — and it would be indistinguishable, from the outside,
from a service that works.
