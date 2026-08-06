# Production Technology Stack
**Version:** 1.0 · **Date:** 2026-08-05 · **Status:** Recommended
**Consolidates:** [ARCHITECTURE.md](ARCHITECTURE.md) §13 · [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) §1 · [FRONTEND-ARCHITECTURE.md](FRONTEND-ARCHITECTURE.md) · [AI-ARCHITECTURE.md](AI-ARCHITECTURE.md) §2

> One recommendation per line, one sentence of justification. Selections previously made are restated here so the stack exists in one place; genuinely new decisions are marked **NEW**.

**Three constraints govern every choice:** cloud-agnostic where practical, must run fully in Docker Compose (MNT-01), and blended infrastructure cost ≤ ₹3/MAU/month (CST-03).

---

## 1. Frontend

| Layer | Selection | Why |
|---|---|---|
| Language | **TypeScript** | Shares generated types with the NestJS backend, eliminating the client/server contract drift that causes most integration bugs. |
| Framework | **React 19** | Deepest talent pool in the target market and the only ecosystem where the offline, math-rendering, and accessibility pieces all exist. |
| Build | **Vite** | The product is auth-gated and offline-first, so SSR buys one first paint while adding a permanent server tier and fighting the service worker. |
| Router | **TanStack Router** | End-to-end type-safe params and validated search state, composing with TanStack Query rather than duplicating it. |
| Server state | **TanStack Query** | Solves caching, staleness, retry, and offline persistence once instead of per-feature. |
| Client state | **Zustand** | The global slice is small and synchronous, and Redux boilerplate buys nothing at that size. |
| Forms | **React Hook Form + Zod** | Uncontrolled inputs cost far less on a 2GB Android device, and one schema definition prevents client/server validation drift. |
| Styling | **Tailwind CSS** | Compiled at build time, so there is no runtime style computation on low-end devices. |
| Primitives | **Radix UI** | Correct accessibility semantics at near-zero bundle weight, where MUI or AntD alone would exceed the 250KB budget. |
| **Math rendering** **NEW** | **Temml** (LaTeX → MathML) | Outputs real MathML at ~50KB, where KaTeX emits inaccessible HTML+CSS and MathJax is too heavy for the bundle budget. |
| **Chemistry rendering** **NEW** | **Server-side SVG at publication** | Pre-rendering removes a heavy client library entirely and makes structure rendering deterministic across surfaces (INV-14). |
| Charts | **Visx** or hand-authored SVG | Chart libraries ship far more than the four visualizations this product needs. |
| Client storage | **IndexedDB** (web) / **SQLite** (native, H1) | The only durable browser store that survives termination and holds a full response log. |
| Monorepo | **Turborepo + pnpm** | Three apps and shared packages need caching and workspace linking, not the configuration surface of Nx. |
| Testing | **Vitest · Testing Library · Playwright** | Playwright is the only one of these that can simulate the network loss and process kill that REL-01 requires proving. |

---

## 2. Backend

| Layer | Selection | Why |
|---|---|---|
| Core language | **TypeScript, Node 22 LTS** | Type-safe domain modeling with types shared to the clients, and the team's existing stack. |
| Core framework | **NestJS** | Its module system maps 1:1 onto bounded contexts, making boundary enforcement mechanical rather than aspirational. |
| ORM / query | **Drizzle** **NEW** | SQL-first with full type inference, and it does not hide the partitioning, index, and raw-SQL control that Phase 3 depends on. |
| Migrations | **Drizzle Kit**, expand-contract only | Backward-compatible migrations are a hard requirement (MNT-14) and reversibility must be the default. |
| Validation | **Zod**, shared with the frontend | One schema, generated both ways from OpenAPI, so validation cannot drift between tiers. |
| API contract | **OpenAPI 3.1**, types generated for clients | A hand-written client type is a divergence waiting to ship. |
| AI/ML language | **Python 3.12 + FastAPI** | The embeddings and psychometrics ecosystem is unavoidable, and FastAPI keeps the queue-consumer surface thin. |
| Python tooling | **uv** **NEW** | An order of magnitude faster than pip in CI, which matters against the 10-minute feedback budget. |
| **Authentication** **NEW** | **Built in-house** per Backend §4 | Identity SaaS priced per MAU is disqualifying at 1M users — Clerk or Auth0 alone would exceed the entire infrastructure budget several times over — and the token design is already fully specified. |
| **Feature flags** **NEW** | **In-house, database-backed** | Domain policy already lives in the database with audit, and a third-party SDK on a request path is a dependency we decline. |
| Boundary enforcement | **dependency-cruiser** in CI | Unenforced module boundaries are documentation, not architecture. |

---

## 3. Database

| Layer | Selection | Why |
|---|---|---|
| Primary store | **PostgreSQL 16+**, schema-per-context | One instance with eleven logical schemas is the only topology a 2–5 person team can operate while keeping extraction seams intact. |
| Managed as | **Amazon RDS**, standard PostgreSQL only | Aurora is API-compatible so moving *to* it later is trivial, while moving *off* it is not. |
| Extensions | **pgvector · pg_trgm · pg_partman** | Vector search, trigram duplicate detection, and partition maintenance in-database removes three separate systems from the operational surface. |
| Connection pooling | **PgBouncer**, transaction mode | Fargate task scaling would otherwise exhaust connections during the submission storm. |
| Partitioning | **Native declarative** | Reaches the 20B-row ceiling with a bounded hot window, without the lock-in or ops burden of Citus or Timescale. |
| Analytics query | **DuckDB** (local) / **Athena** (production) over Parquet | An idle warehouse is disqualifying at CST-01's pre-revenue budget, and Parquet costs nothing when not queried. |
| Local equivalent | `postgres:16` + extensions | Identical engine locally, which is what makes MNT-01 an enforcement mechanism rather than a claim. |

---

## 4. Search

| Layer | Selection | Why |
|---|---|---|
| Engine | **PostgreSQL FTS + pgvector**, served from a read replica | At the Year-1 corpus size this removes an entire distributed system from the surface a small team must operate. |
| Lexical index | **GIN over `tsvector`** | Handles the structured-notation lexeme field alongside natural language in one index. |
| Vector index | **HNSW**, partitioned by embedding model version | Lets the previous index be dropped atomically after a model cutover rather than during a backfill. |
| Ranking | **Reciprocal rank fusion** | Lexical misses paraphrase and semantic misses exact notation — math content needs both. |
| Escape hatch | **OpenSearch**, at defined triggers | An escape hatch without a numeric trigger is never used until it is too late. |

---

## 5. Cache

| Layer | Selection | Why |
|---|---|---|
| Engine | **Valkey** | Redis-protocol compatible under a permissive licence, avoiding the Redis relicensing risk entirely. |
| Managed as | **ElastiCache for Valkey** | Managed failover is worth more than the marginal cost saving of self-operating a cache. |
| Strategy | **Version-keyed keys**, not TTL invalidation | Published content is immutable, so the key changes when the content does and most invalidation becomes unnecessary. |
| CDN | **CloudFront** | Serves the entire form-package burst without an application server participating. |
| Local equivalent | `valkey` container | — |

---

## 6. Queue

| Layer | Selection | Why |
|---|---|---|
| Production | **Amazon SQS**, behind a four-operation interface | Four operations — enqueue, receive, ack, DLQ — keep it substitutable, and SQS has no cluster to operate. |
| Local | **PostgreSQL-backed queue** | Same narrow interface with no extra container, keeping the Compose stack under the 10-minute boot budget. |
| Outbox | **PostgreSQL table + relay** | Writing the event in the same transaction as the aggregate is what prevents "submitted but never scored". |
| Scheduler | **Leader-elected in-process** | Cron in N containers means N duplicate executions. |
| Rejected | **Kafka** | Unjustified operational weight for five deployables and a burst-shaped, not stream-shaped, workload. |

---

## 7. Object Storage

| Layer | Selection | Why |
|---|---|---|
| Production | **Amazon S3** | The S3 API is the closest thing to a portable standard in cloud storage. |
| Local | **MinIO** | Byte-compatible API, so no code path differs between local and production. |
| Contents | Media, form packages, archived Parquet, analytics events | Everything large, immutable, and CDN-servable belongs outside the database. |
| Access | **Short-lived signed URLs** | Prevents deep-linking and bulk asset extraction without an application server in the path. |
| Backup isolation | **Separate account + object lock** | A compromised production role must not be able to reach or delete backups. |

---

## 8. AI Providers

| Purpose | Selection | Why |
|---|---|---|
| Generation, verification, solutions | **Claude Opus 5** (`claude-opus-5`) | Correctness of physics, chemistry, and math content is the product, and a weaker model costs more in reviewer time than it saves in tokens. |
| Hints, tutor (H1) | **Claude Sonnet 5** (`claude-sonnet-5`) | Strong enough for scaffolded explanation at roughly half the Opus rate, on content that is reviewed before students see it. |
| Classification, triage | **Claude Haiku 4.5** (`claude-haiku-4-5`) | Fixed-label classification does not need frontier reasoning. |
| Cost mechanism | **Batch API + prompt caching** | Batch halves token cost and a cached grounding prefix reads at ~0.1×, which together make the content pipeline economics work. |
| **Embeddings** **NEW** | **Voyage AI**, with self-hosted BGE-M3 as escape hatch | Strong retrieval quality behind a narrow interface, and embeddings are versioned and regenerable by design if we switch. |
| Symbolic verification | **SymPy** | A computer algebra system does not agree with itself out of politeness, unlike a second model call. |
| Local development | **Fixture provider replaying recorded responses** | The stack must boot without an API key and AI-dependent tests must be deterministic. |
| Provider isolation | Adapter inside the AI Service only | Provider substitution is a 3-person-day change (EXT-05) because the domain never sees it. |

---

## 9. Monitoring

| Layer | Selection | Why |
|---|---|---|
| Instrumentation | **OpenTelemetry** | Vendor-neutral by construction, so the backend below is swappable without touching application code. |
| **Metrics, logs, traces** **NEW** | **Grafana Cloud** | OTLP-native with a genuinely usable free tier, and a self-hostable LGTM escape hatch that Datadog does not offer at any price. |
| **Error tracking** **NEW** | **Sentry** | Frontend error grouping, source maps, and release tracking are materially better than logs for the client tier, and it self-hosts. |
| Synthetic monitoring | **Grafana Synthetic Monitoring** | The four critical journeys need probing from outside the VPC, which internal metrics cannot do. |
| Alerting | **Grafana Alerting → PagerDuty** | Multi-window SLO burn-rate alerting is native, and only burn alerts should page. |
| Rejected | **Datadog** | Per-host and per-GB pricing would consume most of the pre-revenue infrastructure budget on its own. |
| Log discipline | Structured JSON, allowlist serializer | Denylist PII redaction fails open on the first unanticipated field. |

---

## 10. Deployment

| Layer | Selection | Why |
|---|---|---|
| Compute | **ECS Fargate** | Five deployables do not justify the operational surface of EKS for a team without a platform engineer. |
| Registry | **ECR** | Colocated with compute, so image pulls cost nothing and cross no network boundary. |
| IaC | **Terraform** | Provider-portable, matching the cloud-agnostic constraint that Terraform's competitors do not. |
| CI/CD | **GitHub Actions** **NEW** | Generous free tier for a small team, with Compose-based integration tests running natively on the runners. |
| Environments | Local · CI · shared staging · production | Per-PR preview environments are the single largest avoidable cost at this stage; ephemeral schemas in staging give the same isolation. |
| Deployment strategy | Rolling with health gating, frozen during mock windows | The freeze is a CI gate reading the mock schedule, not a calendar reminder. |
| Region | **`ap-south-1`** (Mumbai) | Latency to the entire user base and the default answer for DPDP data residency. |
| Secrets | **AWS Secrets Manager**, interface-wrapped | Rotation and audit for free, behind an interface that keeps the door open. |

---

## 11. Supporting Services

**NEW** — none of these were previously selected.

| Purpose | Selection | Why |
|---|---|---|
| Payments | **Razorpay** | Deepest UPI e-mandate support in India, which subscription autopay specifically requires. |
| Transactional email | **Amazon SES** | Roughly an order of magnitude cheaper than the alternatives at a volume where email is pure cost. |
| Transactional SMS | **MSG91** | India-native with TRAI DLT template registration handled, which international providers make painful. |
| Push notifications | **Firebase Cloud Messaging** | Free, and covers Android, web push, and iOS through one integration. |
| Analytics events | **Direct to S3 as Parquet** | Third-party product analytics priced per event is unjustifiable when we already own the pipeline. |

**DLT registration is a scheduling risk:** every transactional SMS template must be pre-registered with an Indian telecom operator, and approval takes days to weeks. Start before it blocks launch.

---

## 12. Cost Envelope

| Stage | Monthly | Budget | Headroom |
|---|---|---|---|
| **M0–M1** (local + staging, pre-revenue) | ~₹8,000 | ₹15,000 (CST-01) | ✅ ~47% |
| **M2** (10K MAU) | ~₹32,000 | ₹60,000 (CST-02) | ✅ ~47% |
| **100K MAU** | ~₹250,000 infra + AI | ≤ ₹3/MAU (CST-03) | ⚠️ Tight — the binding constraint |

At 100K MAU the free tier must be genuinely near-zero marginal cost, which is why zero live inference on free (CST-06) is a stack requirement and not a product preference.

---

## 13. Deliberately Rejected

| Rejected | Instead | Why |
|---|---|---|
| Kubernetes / EKS | ECS Fargate | Operational surface no five-deployable system earns. |
| Kafka | SQS + outbox | Burst-shaped workload, not stream-shaped. |
| Aurora / Citus / Timescale | Standard PostgreSQL | Native partitioning reaches the ceiling without one-way lock-in. |
| Elasticsearch at launch | Postgres FTS + pgvector | An entire system deferred until a numeric trigger justifies it. |
| Datadog | Grafana Cloud | Would consume most of the pre-revenue budget alone. |
| Auth0 / Clerk / Cognito | In-house auth | Per-MAU pricing is disqualifying at 1M users; Cognito additionally conflicts with cloud-agnosticism. |
| GraphQL | REST + OpenAPI | Defeats CDN caching and makes the answer-key payload audit impractical. |
| Next.js | Vite SPA | SSR adds a permanent server tier and fights the service worker for one first paint. |
| MUI / AntD | Radix + Tailwind | Exceeds the 250KB initial bundle budget before any product code. |
| Per-PR preview envs | Ephemeral schemas | Largest avoidable cost at this stage. |
| Third-party analytics | S3 + Parquet | Per-event pricing on a pipeline we already own. |

---

## 14. Compose Parity

Every production dependency has a local equivalent — this is what enforces cloud-agnosticism (MNT-01).

| Production | Local | Portable? |
|---|---|---|
| ECS Fargate | Node/Python containers | ✅ Containers |
| RDS PostgreSQL | `postgres:16` + extensions | ✅ Standard PG only |
| ElastiCache Valkey | `valkey` | ✅ Redis protocol |
| S3 | MinIO | ✅ S3 API |
| SQS | Postgres queue | ✅ Four-operation interface |
| CloudFront | Nginx | ✅ Standard HTTP caching |
| Secrets Manager | `.env` | ✅ Interface-wrapped |
| Claude API | Fixture replay | ✅ Provider interface |
| Athena | DuckDB | ✅ Parquet |
| Grafana Cloud | Grafana + LGTM | ✅ OTLP |

**Recorded lock-in exceptions: none.** Any future exception requires an ADR naming the migration cost.

---
