# Backend Architecture
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Extends:** [ARCHITECTURE.md](ARCHITECTURE.md) (topology) with backend detailed design
**Traces to:** [DOMAIN-MODEL.md](DOMAIN-MODEL.md) · [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) · [NFR.md](NFR.md)

> One recommendation per decision, one line of justification. No code.

---

## 1. Service Boundaries

| Decision | Justification |
|---|---|
| Five deployables: Core API, Workers, Outbox Relay, AI Service, Psychometrics Worker | The smallest surface a 2–5 person team can operate while keeping AI and batch work off student paths. |
| Core API holds all 11 bounded contexts as internal modules | `Attempt → ScoreRecord` and `Content → Curriculum` need real transactions; distributing them buys sagas and nothing else. |
| AI Service and Psychometrics Worker are separate processes in Python | Different language, different failure tolerance, different scaling curve — and they must never consume Core API capacity. |
| Outbox Relay is its own deployable, not a thread in the API | A stalled relay must be independently observable and restartable without touching request serving. |
| Workers are one deployable with per-queue concurrency caps, not one deployable per job type | Bulkheads come from queue caps; five more deployables would buy isolation we already have. |
| Services communicate only by queue; no service-to-service HTTP | Synchronous inter-service calls reintroduce the coupling the monolith was chosen to avoid. |

---

## 2. Modules

| Decision | Justification |
|---|---|
| One module per bounded context, named identically | The map from domain model to code is 1:1 or it decays. |
| Fixed internal anatomy: `api/` → `application/` → `domain/` ← `infrastructure/`, plus `public/` | A predictable shape makes boundary violations visible in a diff. |
| `domain/` depends on nothing; `infrastructure/` depends inward only | Dependency inversion is what makes the domain testable without a database. |
| Modules expose exactly three things through `public/`: commands, queries, events | Anything else is an implementation detail someone will couple to. |
| Cross-module calls go through the same interface the network version will use | Extraction then changes transport, not contracts. |
| Cross-module state change happens only via domain events, never a direct command | A direct cross-context command is a distributed transaction wearing a disguise. |
| Shared platform modules (`http`, `persistence`, `messaging`, `observability`, `config`, `auth`) are infrastructure-only and contain no domain logic | A shared module with business rules becomes the coupling point that kills extraction. |
| Shared kernel is exactly three types: `PrincipalRef`, `UserId`, `RoleSet` | Every addition to a shared kernel is a future migration. |
| Boundary rules enforced by dependency-cruiser in CI, not convention | Unenforced boundaries are documentation. |

---

## 3. API Design

| Decision | Justification |
|---|---|
| **REST + JSON over HTTP/2**, not GraphQL | Offline-first clients need cacheable, CDN-friendly, deterministic payloads; GraphQL defeats edge caching and makes the "no answer keys in payload" audit (SEC-08) impractical. |
| OpenAPI 3.1 is the source of truth; client types are generated from it | A hand-written client type is a divergence waiting to happen. |
| URI major versioning (`/v1/`), additive-only within a version, 6-month deprecation window | Clients on slow Android update cycles cannot be force-migrated. |
| **Cursor pagination**, never offset | Offset breaks under concurrent writes and degrades linearly on a 20 B-row table. |
| Filter and sort fields are allowlisted per endpoint | An unallowlisted sort field is an unplanned full scan. |
| **RFC 9457 Problem Details** for every error, with a stable machine-readable `code` | Clients must branch on a contract, not on prose. |
| `Idempotency-Key` header required on attempt submission, payment, and event batch | REL-02 is a contract, not retry logic. |
| Optimistic concurrency via `ETag` / `If-Match`, mapped to `aggregate_version` | Lost-update on a concept map or item version is silent corruption. |
| Batch endpoints return per-item results, never all-or-nothing | A single bad event must not reject a three-hour response log. |
| Form packages served as a redirect to a signed CDN URL | Bytes must never traverse the API tier during B1. |
| Rate limits per principal **and** per source, with limits exposed in response headers | A client that cannot see its budget will retry into the wall. |
| Public API (H2) is a separate surface with separate versioning | Exposing internal endpoints externally freezes them forever. |
| Consumer-driven contract tests gate every release | A breaking change should fail CI, not a student's exam. |

**Notable endpoints:** `POST /v1/attempts/{id}/events:batch` (sync, per-item results) · `POST /v1/attempts/{id}/submission` (idempotent) · `GET /v1/forms/{id}/package` (302 → signed CDN URL).

---

## 4. Authentication

| Decision | Justification |
|---|---|
| **Stateless access token (JWT, Ed25519) + opaque, server-stored refresh token** | Access tokens must verify without a database hit to meet PER-08; refresh must be revocable to meet SEC-06. |
| Access TTL 15 minutes; refresh 30 days sliding | Short enough that a stolen access token expires before it is useful. |
| Refresh rotation with reuse detection; reuse revokes the whole token family | Reuse is the only reliable signal of refresh-token theft. |
| Session validity cached in Valkey with 60-second TTL, Postgres as source of truth | Delivers SEC-06's ≤60 s revocation without a per-request database read. |
| Token claims limited to `sub` (pseudonymous), `sid`, `roles`, `tenant`, `exp` — **no PII** | Tokens land in proxy logs; PII in a claim is PII in a log. |
| **In-progress attempts carry a separate signed attempt token** | Session expiry or refresh failure must never end an exam (AVA-10). |
| Argon2id for credential hashing, tuned work factor, per-credential salt | Memory-hard hashing is the only defensible choice for a credential store. |
| TOTP MFA mandatory for Content Ops, Support, and Platform Admin | These roles can alter or expose academic records. |
| Step-up produces a short-lived elevated claim scoped to one operation class | Standing elevation is the same as no elevation. |
| Federated login (OIDC) links only after verified contact match | Unverified auto-linking is account takeover. |
| Refresh tokens bound to a device fingerprint **hash** | Binding without storing device identifiers. |

---

## 5. Authorization

| Decision | Justification |
|---|---|
| **Policy-based, deny-by-default, evaluated at the command/query handler boundary** | Controllers are the wrong place — background jobs and internal callers bypass them. |
| RBAC + scope (subject, tenant, ownership); **not** full ABAC | Scoped roles cover every case in the FRS; ABAC is complexity with no current requirement. |
| A handler without a declared policy **fails to register at boot** | Forgetting authorization must be impossible, not merely caught in review. |
| Tenant and ownership filters applied in the repository layer, not by callers | Caller-enforced scoping fails the first time someone writes a new query. |
| **Entitlement is evaluated separately from authorization** | Permission and payment are different failure modes and must produce different responses. |
| Entitlement derived at evaluation time from `Subscription` + `PlanVersion`, cached briefly | Stored entitlement drifts; drift means paid users denied access (REL-11). |
| Correctness content granted unconditionally, outside plan evaluation | INV-08 must not depend on the billing system being correct or available. |
| 100% negative-path test coverage on T0/T1 handlers | An authorization test that only tests the allowed case tests nothing. |
| Every authorization denial is logged with principal, resource, and reason | Denials are the primary signal of both attacks and broken product design. |

---

## 6. Background Jobs

| Decision | Justification |
|---|---|
| Four job classes: event-driven, scheduled, long-running batch, user-triggered async | Each has different retry, ordering, and observability needs. |
| Queue behind a narrow interface — enqueue, receive, ack, DLQ | Four operations keep SQS↔Postgres substitutable (EXT-06). |
| **At-least-once delivery with idempotent consumers**, dedupe on `event_id` | Exactly-once across a network is a fiction; idempotent consumers are real. |
| Exponential backoff with jitter, max 5 attempts, then DLQ with alarm | Unbounded retry converts a transient fault into a sustained outage. |
| FIFO ordering grouped by `attempt_id` for scoring; unordered elsewhere | Ordering is expensive; only scoring actually needs it. |
| Per-queue concurrency caps | Bulkheads: an AI backlog must not starve scoring. |
| Single leader-elected scheduler emitting to queues, not cron in every container | N containers running cron means N duplicate executions. |
| Long jobs are chunked and checkpointed, never one long transaction | A six-hour transaction is a six-hour lock and an unrecoverable failure. |
| Re-scoring is a three-stage job: dry-run → approval → chunked execution | FR-ADM-08 requires an impact preview before touching a score of record. |
| DLQ depth is a paging alert | A silently growing DLQ is data loss with a delay. |

**Scheduled jobs:** partition create/detach · archive export to Parquet · statistics recompute · spaced-repetition due sweep · payment reconciliation · backup verification · consistency check on read models · certificate and secret rotation checks.

---

## 7. Search

| Decision | Justification |
|---|---|
| **Postgres FTS + pgvector**, served from the R1 replica | Removes an entire system from the operational surface at Year-1 corpus size. |
| **Hybrid ranking** — reciprocal rank fusion of lexical and semantic results | Neither alone works for math content: lexical misses paraphrase, semantic misses exact notation. |
| Symbolic notation extracted into a dedicated lexeme field | `∫x²dx` must be findable as a term, not as a rendering artifact. |
| Scoping filter applied **inside** the query, never as a post-filter | Post-filtering leaks the existence of unpermitted content through result counts (SRCH-05). |
| Search reads the `published_item` projection, never authoring tables | Authoring tables are optimized for governance; students must not pay that cost. |
| Embeddings versioned by model, dual-indexed during transition | A model change must not blank search for the duration of a backfill. |
| HNSW index partitioned by embedding model version | Lets the old index be dropped atomically after cutover. |
| Documented escape hatch to OpenSearch with numeric triggers | An escape hatch without a trigger is never used until it is too late. |

---

## 8. Caching

| Decision | Justification |
|---|---|
| Four layers: CDN → HTTP → Valkey → in-process | Each absorbs a different traffic shape; B1/B3 never reach the database. |
| **Cache keys embed the version or content hash of the underlying entity** | Version-keyed caching makes most invalidation unnecessary — the key simply changes. |
| Explicit invalidation only for genuinely mutable state: entitlement, concept map, session | Three invalidation paths can be reasoned about; three hundred cannot. |
| Immutable content served with far-future TTL and content-hashed URLs | Published item versions never change (INV-03), so revalidation is pure waste. |
| In-process cache for exam profiles and taxonomy versions | Small, immutable, read on nearly every request — a network hop for these is indefensible. |
| Single-flight per key on miss | Otherwise a cold cache during B3 becomes a self-inflicted thundering herd. |
| Negative caching on content lookups | Prevents enumeration attempts from amplifying into database scans. |
| **Never cached:** anything answer-key bearing, anything during an active attempt | SEC-08 has no acceptable cache-related exception. |
| Cache is never a system of record; every entry is reconstructible | A cache flush must be a latency event, not a correctness event. |

---

## 9. Notifications

| Decision | Justification |
|---|---|
| Pipeline: trigger event → eligibility → render → dispatch → track → inbox write | Eligibility must be a distinct stage so suppression is auditable rather than accidental. |
| Eligibility evaluates consent, preference, frequency cap, quiet hours, and **in-progress-attempt check** | An interrupting notification during a three-hour mock is a product failure with real consequences. |
| Transactional messages bypass preference but **not** the in-progress-attempt suppression | The one exemption that is never justified. |
| In-app inbox is always written, regardless of external delivery outcome | Push delivery is unreliable; the durable record must not be. |
| Idempotent on `(template, user, trigger_event)` | Queue retries must not double-send. |
| Suppression reasons recorded, not silently dropped | "Why didn't I get my result?" must be answerable. |
| Provider abstraction per channel with independent circuit breakers | An SMS outage must not stop push notifications. |
| SMS reserved for transactional messages only | Per-message cost is incompatible with the ARPU model. |

---

## 10. Analytics

| Decision | Justification |
|---|---|
| Events validated against the registry at the ingestion edge; unregistered names rejected | An ad-hoc event name is an event nobody can query in six months. |
| Written directly to date-partitioned Parquet on object storage — **never to the OLTP database** | Analytics volume must not compete with submission-storm write throughput. |
| Server-side events emitted from domain event handlers, not controllers | Controller-scattered instrumentation misses every non-HTTP path. |
| Client events batched and uploaded alongside the response log | One sync mechanism, already proven offline-durable. |
| Nightly rollups materialized into small Postgres aggregate tables for dashboards | Dashboards need milliseconds; the lake needs no always-on cluster. |
| Query with DuckDB/Athena over Parquet; no warehouse cluster at launch | An idle warehouse is disqualifying at CST-01's budget. |
| Minor-account events filtered at query time by an enforced predicate | INV-10 must not depend on every analyst remembering. |

---

## 11. AI Pipeline

| Decision | Justification |
|---|---|
| Flow: request → **budget check at enqueue** → grounding retrieval → generation → independent answer verification → pre-check battery → candidate persisted → ACL → Content draft | Budget checked before spend, verification independent of generation, human review unavoidable. |
| Answer verification uses a derivation path independent of generation | A model checking its own work agrees with itself. |
| Pre-checks are **blocking** for AI content, advisory for human content | Reviewer time is the scarcest resource in the pipeline (R12). |
| Model and prompt versions are pinned **data**, never configuration constants | "Which prompt produced this item?" must be an index scan (FR-AI-08). |
| Promotion of any model or prompt version gated by an evaluation run | Regression must block, not warn (FR-AI-10). |
| Provider adapter isolated inside the AI Service; the domain never sees it | EXT-05: provider substitution in ≤3 person-days. |
| Streaming only for the tutor; everything else is batch | Only one AI feature is interactive, and it is allowed to be unavailable. |
| Cost recorded per run in an append-only ledger at completion | CST-05 must be measurable daily, not reconstructed monthly. |
| Circuit breaker with defined degradation; no student path depends on AI availability | AI-12 — AI unavailability must be cosmetic. |
| Local development uses a fixture provider replaying recorded responses | The stack must boot without an API key, and AI tests must be deterministic. |

---

## 12. Logging

| Decision | Justification |
|---|---|
| Structured JSON, one event per line | Human-readable logs are machine-hostile and this system is debugged by query. |
| `correlation_id` assigned at the gateway; `causation_id` propagated **through queue messages into workers** | A trace that stops at the queue boundary is useless for the async paths that matter most. |
| **PII exclusion by serializer allowlist, not redaction regex** | Denylist redaction fails open; the first unanticipated field leaks. |
| Log identifiers, never content — `item_version_id`, never the item | Logging item content leaks answer keys into a lower-security store. |
| Levels: `error` = actionable, `warn` = degradation, `info` = state transitions only, `debug` off in production | An `info` log per request is a cost line, not an observability strategy. |
| **Application log and audit log are separate systems** | Audit is append-only, retained 3 years, and legally significant; application logs are ephemeral debugging. |
| 30 days hot, 1 year cold | Matches OBS-14 and the realistic investigation window. |

---

## 13. Monitoring

| Decision | Justification |
|---|---|
| RED per endpoint, USE per resource, SLO burn-rate alerting | Symptom-based alerting pages on user impact rather than on machine noise. |
| **Multi-window burn-rate alerts** (fast: 2% budget in 1 h; slow: 5% in 6 h) | Single-threshold alerts either page constantly or miss slow degradation. |
| OpenTelemetry tracing, 1% sampled, 100% on error, propagated through queues | Sampling everything is unaffordable; sampling errors at 100% is where the value is. |
| Synthetic probes on login, start mock, submit mock, view result — every 60 s, two regions | These four journeys are the product; everything else is supporting cast. |
| Business metrics instrumented as first-class series alongside technical ones | Mastery gains and AI acceptance rate are health metrics, not reporting artifacts. |
| **Only SLO burn and Sev-triggering conditions page**; everything else creates a ticket | ≤2 pages/week/person is binding (OBS-09) — alert fatigue is an availability risk at this team size. |
| Every alert maps to a runbook or it is deleted | An alert without a response is a notification. |
| Elevated monitoring posture pre-scheduled for every mock window | The one time the system must not fail is known in advance. |
| Cost per MAU tracked as a first-class SLO with the same review cadence as availability | At this ARPU, cost overrun kills the product as surely as downtime. |

---

## 14. Error Handling

| Decision | Justification |
|---|---|
| **Domain and application layers return typed results; only infrastructure faults throw** | Expected outcomes (invalid input, insufficient entitlement) are not exceptional and should not use exception control flow. |
| Fixed error taxonomy: Validation, Authentication, Authorization, Entitlement, NotFound, Conflict, PreconditionFailed, RuleViolation, RateLimited, Unavailable | Clients branch on a closed set; a new error class is a deliberate API change. |
| Entitlement failures are distinct from authorization failures | "Upgrade to access" and "you are not permitted" need different UX and different metrics. |
| Responses carry an explicit `retryable` flag | Clients must not infer retry semantics from a status code. |
| Correlation ID returned in every error response | The user reports a code; support finds the trace. |
| No stack traces, internal identifiers, or dependency names in responses | Error responses are an information-disclosure surface. |
| **Fail closed** on authorization, entitlement, and scoring | The safe default when uncertain is refusal. |
| **Fail open** on recommendations, AI enrichment, and analytics | A recommendation engine failure must not block practice. |
| Unhandled worker errors go to DLQ with alarm — never a silent drop | Silent job loss is the hardest class of bug to detect. |
| Client-visible messages are actionable and localizable; diagnostics go to logs | "Something went wrong" is not an error message. |

---

## 15. Configuration

| Decision | Justification |
|---|---|
| **Three categories, deliberately separated: infrastructure config, feature flags, domain policy** | Conflating them is a top source of production incidents — a "config change" must never silently alter a marking rule. |
| Infrastructure config from environment and secret store; hierarchy is code default → file → env → secrets | Standard precedence, no surprises. |
| **Domain policy lives in the database, versioned and audited** — marking rules, tolerances, mastery thresholds, quotas | These are data with history and audit requirements, not settings (D-001, D-002, D6). |
| Feature flags are runtime and targetable but **may not alter scoring or content governance** | FR-ADM-09 — a flag must never change the meaning of a score. |
| Configuration is typed and validated at boot; the process **refuses to start** on invalid config | A misconfigured tolerance must fail at deploy, not in an exam. |
| No configuration lookup on a hot path — resolved at boot or cached in-process, version-keyed | A per-request config read is a per-request failure mode. |
| Secrets injected at runtime from the secret store, rotation ≤90 days, never in images or committed files | SEC-07, verified by blocking secret scanning in CI. |
| Every environment runs the same artifact; only configuration differs | "Works in staging" must mean something. |
| Configuration changes are audited with actor and prior value | A change nobody can attribute is a change nobody can reverse. |

---

## 16. Cross-Cutting Fitness Functions

Additions to [ARCHITECTURE.md](ARCHITECTURE.md) §14, enforced in CI.

| # | Check |
|---|---|
| F11 | Every command/query handler declares an authorization policy — boot fails otherwise |
| F12 | No handler returns an unmapped error type |
| F13 | No log statement serializes an object outside the field allowlist |
| F14 | Every queue consumer is idempotent — verified by a duplicate-delivery test |
| F15 | Every public endpoint appears in the OpenAPI spec and has a contract test |
| F16 | No configuration key is read outside the typed config module |
| F17 | No `SELECT` in a T0 path targets a read replica |
| F18 | Every domain event has a registered analytics counterpart or an explicit exemption |

---
