# System Architecture
**Product:** AI-Powered Online Examination & Question Intelligence Platform
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [DOMAIN-MODEL.md](DOMAIN-MODEL.md) · [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) · [NFR.md](NFR.md)
**Phase:** 2 — System Architecture *(delivered out of order; ratifies assumptions made in Phase 3)*

---

## 1. Architectural Style

**Modular monolith in TypeScript, with two Python satellite services and a queue-driven worker tier.**

| Considered | Verdict |
|---|---|
| Microservices per bounded context (11 services) | **Rejected.** `Attempt → ScoreRecord` and `Content → Curriculum` have strict consistency requirements. Distributing them turns one transaction into a saga, for a team of 2–5 with no platform engineer. |
| Single-process monolith, no module boundaries | **Rejected.** Boundaries erode within months; EXT-09 (extraction seams) becomes impossible. |
| **Modular monolith + enforced boundaries + outbox from day one** | **Adopted.** One deployable, eleven internal modules, cross-module calls only through published interfaces, all cross-context communication already event-shaped. Extraction later is mechanical, not archaeological. |

The outbox pattern (P4) exists in Phase 3 specifically so this choice is reversible. A module extracted into a service on day 400 changes its transport, not its contract.

**Polyglot boundary:** TypeScript owns the domain and every transactional path. Python owns AI and psychometrics — work that is asynchronous, batch, and never on a student-blocking path. The seam is a queue, not an RPC call.

---

## 2. Runtime Topology

```
                          ┌──────────────┐
    Clients ──────────────┤     CDN      │  media, form packages, static
   (PWA, later native)    └──────┬───────┘  ← B1 served entirely here
           │                     │
           ▼                     │
   ┌───────────────┐             │
   │  API Gateway  │  TLS, WAF, rate limit, request ID
   └───────┬───────┘
           │
   ┌───────▼─────────────────────────────────────┐
   │            CORE API  (TypeScript)            │   stateless, horizontally scaled
   │  ┌────────┬─────────┬─────────┬───────────┐ │
   │  │identity│curricul.│ content │assessment │ │
   │  ├────────┼─────────┼─────────┼───────────┤ │
   │  │scoring │learning │commerce │engagement │ │
   │  ├────────┴─────────┴─────────┴───────────┤ │
   │  │        trust      │      search        │ │
   │  └────────────────────────────────────────┘ │
   └───┬──────────────────────────────────┬──────┘
       │ write                            │ read
       ▼                                  ▼
   ┌────────────────┐              ┌──────────────┐
   │ PostgreSQL     │──replica────▶│ Read replica │  projections, search, reports
   │ primary        │              └──────────────┘
   │ + outbox       │
   └───┬────────────┘
       │ logical drain
       ▼
   ┌────────────────┐      ┌──────────────────────────────────┐
   │ Outbox Relay   │─────▶│           Queue                   │
   └────────────────┘      └───┬────────────┬─────────────┬───┘
                               │            │             │
                     ┌─────────▼──┐  ┌──────▼──────┐  ┌───▼────────────┐
                     │ Workers    │  │ AI Service  │  │ Psychometrics  │
                     │ (TS)       │  │ (Python)    │  │ Worker (Python)│
                     │ scoring,   │  │ generation, │  │ statistics,    │
                     │ projections│  │ embeddings, │  │ calibration    │
                     │ notif.     │  │ pre-checks  │  │                │
                     └────────────┘  └─────────────┘  └────────────────┘
                                             │
                                     ┌───────▼────────┐
                                     │ Object storage │  media, packages,
                                     └────────────────┘  analytics Parquet
```

**Five deployables.** Core API, Workers, Outbox Relay, AI Service, Psychometrics Worker. That is the entire production surface a 2–5 person team must operate.

---

## 3. Module Boundaries & Enforcement

Boundaries that are not mechanically enforced are documentation, not architecture.

| Rule | Enforcement |
|---|---|
| A module may import only from another module's `public/` barrel | Dependency-cruiser rule, CI-blocking |
| No module may query another module's database schema | Migration-file lint + per-schema DB roles |
| Cross-context state change happens only via domain events | Code review + no cross-module command handlers exported |
| No cross-schema foreign keys | CI check on migration files (R9) |
| Shared kernel is exactly one thing: `PrincipalRef`, `UserId`, `RoleSet` | Explicit allowlist in the lint config |

Modules expose three things and nothing else: **commands** (write intent), **queries** (read intent), and **events** (facts). In-process calls go through the same interface the network version will use, so extraction changes the transport and nothing else.

---

## 4. Synchronous vs Asynchronous

The single most consequential runtime decision set. Anything on a student-blocking path is synchronous and cheap; everything else is queued.

| Operation | Mode | Rationale |
|---|---|---|
| Authentication, entitlement evaluation | **Sync** | Sub-200 ms, no external dependency |
| Form package request (B1) | **Sync, CDN-served** | App servers issue a signed URL; bytes never traverse the API |
| Response capture during attempt | **Client-local only** | Zero server involvement for three hours |
| Attempt submission (B2) | **Sync ack, async processing** | Persist events + outbox in one transaction, acknowledge in < 1.5 s. Scoring follows |
| **Single-item evaluation (practice feedback)** | **Sync, pure function** | Deterministic, no I/O beyond the item's answer spec. Immediate feedback (FR-PRA-04) |
| **Full-attempt scoring** | **Async worker** | PER-13 allows 60 s. Decoupling absorbs the entire B2 storm |
| Result read (B3) | **Sync from projection + cache** | Never computed on read |
| Concept map update | **Async** | Eventually consistent; UI shows freshness |
| Projection rebuilds, search indexing, embeddings | **Async** | — |
| AI generation, pre-checks, difficulty estimation | **Async** | Never on any student path (AI-12) |
| AI tutor | **Sync streaming** *(H1)* | The one AI feature that is interactive; degrades to unavailable, never blocks |
| Notifications | **Async** | — |
| Psychometrics, calibration | **Batch** | — |

**The rule:** no student-blocking path may make a network call to a third party. Payments are the sole exception, and they are isolated behind a circuit breaker.

---

## 5. Offline-First Client Architecture

The most important subsystem, and the one that makes REL-01, DRC-06, and the entire cost model work. Undesigned until now.

### 5.1 Form Package
A signed, versioned, immutable bundle produced at form publication and served from CDN.

- Contains: item content bodies, stimuli, media derivatives (mobile variant), render specs, item version IDs, `attempt_pin` template.
- **Never contains:** answer keys, solutions, numeric specs, marking rules (SEC-08 — verified by a blocking payload-inspection test every release).
- Compressed to ≤ 3 MB (PER-22). Integrity-checked by manifest hash on the client.
- Pre-warmed on the CDN before a scheduled window opens.

### 5.2 Client Storage
Append-only local event log — IndexedDB on web, SQLite on native. Survives app termination and device restart (REL-01). No update or delete operation is defined on the log, mirroring the server-side guarantee (P5).

### 5.3 Timer Integrity
1. At attempt start, the server issues a **signed deadline** plus the server timestamp.
2. The client computes clock offset once and enforces locally against monotonic time — never wall-clock, which is user-settable.
3. At submission, the server re-validates against its own clock. **The stricter of the two governs** (FR-MOCK-05).

### 5.4 Sync Protocol
- Client generates `response_event_id` as UUIDv7 — server-side dedup is therefore free.
- Batched upload with an `idempotency_key` per submission (P9).
- Server unions events by ID and **never discards a client event** (REL-06). Conflict resolution is set-union, not last-writer-wins — which is why the log is append-only rather than a mutable answer map.
- Server acknowledges a watermark; the client retains events past it until acknowledged.
- Device change mid-attempt: both devices' logs union on the server. No merge conflict is possible by construction.

### 5.5 What a Total Backend Outage Looks Like
The student notices nothing until submission, which then queues and completes on recovery. This is DRC-06, and it is worth more than a hot standby while costing nothing.

---

## 6. Burst Handling

Mapping NFR §1.1 onto this topology.

| Burst | Path | Scaling lever |
|---|---|---|
| **B1** — form pre-download | CDN only. API issues signed URLs at ~1 req/student | CDN capacity; pre-warm on schedule publication. **App tier is uninvolved.** |
| **B2** — submission storm | Write-optimized endpoint → single transaction (events + outbox) → fast ack. Scoring drains asynchronously | Pre-scale API + primary write capacity; queue absorbs the tail. `response_event` carries no secondary indexes (A3) |
| **B3** — result rush | `mock_result_summary` projection + cache. Zero computation on read | Cache + read replicas |

**Scheduled mocks are known in advance.** Pre-scaling is mandatory (SCA-02/03); reactive autoscaling alone cannot meet a five-minute burst. The scheduler emits a capacity-reservation event at form publication.

---

## 7. Data Layer Topology

| Concern | Decision |
|---|---|
| Primary | Single PostgreSQL writer, multi-AZ |
| Replicas | Two: **R1** for projections, search, and reports; **R2** for analytics export. T0 reads never touch a replica (REL/AVA — replica lag must never affect an exam) |
| Connection pooling | Transaction-mode pooler in front of the primary. Non-negotiable: Fargate task scaling would otherwise exhaust connections during B2 |
| Cache | Valkey for sessions, entitlement evaluation, result summaries. **Never a system of record**; every cached value is reconstructible |
| Archive | Detached partitions → Parquet on object storage; federated query layer fails loudly on hot/cold boundary crossing (R14) |

---

## 8. AI Service Integration

- **Queue-separated, never RPC from a student path.** The Core API publishes a generation request; the AI Service consumes, works, and publishes results back through the outbox-equivalent on its side.
- **Provider abstraction is narrow and owned by the AI Service**, not leaked into the domain (EXT-05). Model and prompt versions are pinned data (`model_version`, `prompt_version`), never configuration constants.
- **Budget enforcement happens before dispatch,** not after billing. `AIBudget` is checked at enqueue time.
- **Anti-corruption layer:** the AI Service emits `GenerationCandidate` rows in the `ai` schema. A Content-side handler translates accepted candidates into draft items. There is no code path from the AI Service to `content.item_version` (D8, INV-01).
- **Local development uses a fixture provider** replaying recorded responses — no API key required to run the stack, and AI-dependent tests are deterministic.

---

## 9. Local ↔ AWS Parity

MNT-01 is the enforcement mechanism for cloud-agnosticism: **if it cannot run in Compose, it is a lock-in candidate and requires a recorded exception.**

| Capability | Local (Compose) | AWS target | Portability |
|---|---|---|---|
| Compute | Node/Python containers | ECS Fargate | Containers — portable |
| Database | `postgres:16` | RDS PostgreSQL | Standard PG only, no Aurora features |
| Object storage | MinIO | S3 | S3 API — portable |
| Cache | Valkey | ElastiCache | Redis protocol — portable |
| Queue | Postgres-backed queue | SQS | **Narrow interface**: enqueue, receive, ack, DLQ. Nothing else |
| CDN | Nginx | CloudFront | Standard HTTP caching semantics |
| Secrets | `.env` file | Secrets Manager | Interface-wrapped |
| AI provider | Fixture replay | Anthropic API | Provider interface (EXT-05) |
| Analytics | DuckDB over MinIO | Athena over S3 | Parquet — portable |

**One command brings the full stack up in under 10 minutes with no cloud account** (MNT-02). Seeded with a demo exam profile, taxonomy, and ~200 items so the system is immediately exercisable.

**Recorded exceptions:** none at present. Any future exception requires an ADR naming the migration cost.

---

## 10. Environments & Delivery

| Environment | Purpose | Cost posture |
|---|---|---|
| **Local** | Primary development surface | ₹0 |
| **CI** | Ephemeral containers per run | Free tier |
| **Staging** | One shared instance; production-shaped, minimum size | ~₹8,000/mo |
| **Production** | From M2 only | Per CST-02 |

**No per-PR preview environments** — they are the single largest avoidable cost at this stage. Isolation is achieved with ephemeral database schemas inside the shared staging instance instead.

Pipeline: commit → lint + dependency-boundary check + SAST + secret scan → unit → integration (Compose-based, real Postgres) → **golden-set scoring regression (blocking)** → performance budget check → **answer-key payload inspection (blocking)** → accessibility scan → build → staging → smoke → production.

Deployments are rolling with health gating. **Release freeze during any scheduled mock window** (AVA-07), enforced as a CI gate reading the mock schedule — not a calendar reminder.

---

## 11. Failure Isolation

| Boundary | Mechanism |
|---|---|
| Third-party providers | Circuit breaker + timeout + fallback per §17 degradation matrix |
| AI Service | Separate deployable, separate queue, own budget. Cannot consume Core API capacity |
| Analytics | Dedicated replica. A runaway query cannot touch T0 |
| Workers | Per-queue concurrency caps; poison messages to DLQ after bounded retries |
| Payments | Isolated; failure never interrupts an in-progress attempt (FR-PAY-05) |
| Client | Offline-first — the strongest isolation boundary in the system |

Bulkheads are per-queue rather than per-tenant; tenancy-level isolation arrives with organizations (P7).

---

## 12. Extraction Seams

Ordered by independence. Each has a measurable trigger; none is extracted before its trigger fires.

| Order | Module | Trigger |
|---|---|---|
| 1 | **AI Service** | Already separate |
| 2 | **Psychometrics** | Already separate |
| 3 | **Search** | Corpus > 2 M items, or vector index maintenance degrades OLTP writes (§8.3) |
| 4 | **Engagement** | Notification volume > 1 M/day |
| 5 | **Trust & Safety** | Moderation volume warrants a dedicated team |
| 6 | **Commerce** | B2B/institute launch introduces a second billing model |
| — | Content + Curriculum | **Keep together.** Coupling is intrinsic |
| — | Assessment + Scoring | **Keep together.** Consistency requirements are strict |

Extraction is a transport change, not a redesign — that is the entire return on the modular-monolith investment.

---

## 13. Technology Register

| Layer | Selection | Why not the alternative |
|---|---|---|
| Core language | TypeScript (Node 22 LTS) | Type-safe domain modeling; types shared with clients |
| Core framework | NestJS | Module system maps 1:1 to bounded contexts and makes boundary enforcement mechanical |
| AI/ML language | Python 3.12 | Ecosystem is unavoidable for embeddings and psychometrics |
| Database | PostgreSQL 16+ | §1 of Data Architecture |
| Cache | Valkey | Redis-compatible, permissively licensed |
| Queue | SQS (prod) / Postgres (local) behind a narrow interface | Kafka is unjustified operational weight at this scale |
| Object storage | S3 / MinIO | — |
| Client | PWA first (installable, offline-capable) | Native apps in H1; one offline engine, two shells |
| Client storage | IndexedDB (web) / SQLite (native) | — |
| Content rendering | Structured markup → MathML-first pipeline | Required by ACC-02; image-based rendering is disqualified |
| IaC | Terraform | Provider-portable; matches the cloud-agnostic constraint |
| Compute | ECS Fargate | EKS is unjustified ops burden for five deployables |

---

## 14. Architecture Fitness Functions

Automated checks that fail the build when the architecture erodes.

| # | Check |
|---|---|
| F1 | No cross-module import outside `public/` barrels |
| F2 | No cross-schema foreign key in any migration |
| F3 | No secondary index added to `response_event` without an ADR |
| F4 | No synchronous third-party call reachable from a T0 route |
| F5 | Every JSONB column has a sibling `*_schema_version` |
| F6 | Answer keys and solutions absent from every client payload (SEC-08) |
| F7 | Every append-only table lacks UPDATE/DELETE grants for the app role (P5) |
| F8 | Full stack boots in Compose within 10 minutes |
| F9 | Golden-set scoring regression passes 100% |
| F10 | No PII string pattern in any log or telemetry output |

---
