# Non-Functional Requirements
**Product:** AI-Powered Online Examination & Question Intelligence Platform
**Version:** 0.1 (Planning) · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [PRD.md](PRD.md) §15 M1 · [FRS.md](FRS.md) §1 · **Phase:** 0.7 — precedes Phase 1

---

## 0. Conventions

- Targets are **binding** unless marked *(aspirational)*. A binding target that cannot be met requires an explicit, recorded decision — not silent drift.
- **Percentiles** are measured over rolling 28-day windows unless stated.
- **Service tiers** classify every capability by consequence of failure:

| Tier | Capabilities | Consequence of failure |
|---|---|---|
| **T0** | Mock delivery, response capture, submission, scoring, authentication | A student loses an exam attempt. Irrecoverable. |
| **T1** | Practice, solutions, concept map, search, payments | Core value blocked; recoverable by retry. |
| **T2** | Analytics, reports, authoring, review workflow | Internal or deferred work delayed. |
| **T3** | AI generation, batch jobs, notifications, recommendations | Degraded quality; no user-blocking impact. |

- Every target below states a **verification method**. An NFR without a test is decoration.

---

## 1. Scale & Load Model

All capacity targets reference this model. Revisit at each 3× growth increment.

| Dimension | Launch (M2) | Year 1 | Year 3 | **Design ceiling** |
|---|---|---|---|---|
| Registered users | 10 K | 100 K | 1 M | **5 M** |
| Monthly active | 6 K | 60 K | 400 K | **1 M** |
| Daily active | 1.5 K | 15 K | 100 K | **300 K** |
| Peak concurrent mock takers | 1 K | 10 K | 80 K | **250 K** |
| Published items | 25 K | 60 K | 500 K | **5 M** |
| Response records / year | 20 M | 400 M | 4 B | **20 B** |
| Peak API RPS | 200 | 800 | 6 K | **20 K** |
| Authors + reviewers | 15 | 60 | 400 | **2 K** |

### 1.1 The Load Shape That Actually Matters

Average load is irrelevant here. Three burst profiles drive the architecture:

| Burst | Trigger | Profile | Dominant cost |
|---|---|---|---|
| **B1 — Form pre-download** | 15-min window before a scheduled mock | 80% of participants pull a full offline package | Egress / CDN |
| **B2 — Submission storm** | 5-min window at mock end | ~60% of attempts submit; each carries 75–180 responses | Write throughput |
| **B3 — Result rush** | Result publication | Near-100% of participants read results within 30 min | Read amplification / cache |

**Design consequence:** offline-first capture converts a three-hour sustained-concurrency problem into a short egress burst plus a short write burst. Sustained in-exam concurrency is *not* a scaling problem in this architecture — B1, B2, and B3 are. Capacity planning targets these three windows and nothing else.

**Seasonality:** demand rises ~4× in the 90 days before the live exam and collapses immediately after. Capacity must scale down as readily as up; fixed-capacity provisioning is a cost failure.

---

## 2. Client Support Matrix

*(Closes PRD §15 M8.)*

| Dimension | Minimum supported | Target experience |
|---|---|---|
| Android | 9.0 (API 28) | 12+ |
| iOS | 15 | 17+ |
| RAM | 2 GB | 4 GB+ |
| Screen | 360 × 640 CSS px | 390 × 844 |
| Browsers | Chrome/Edge last 3, Safari last 3, Firefox last 3, Android WebView 100+ | — |
| Network floor | 3G, 400 kbps, 300 ms RTT, 2% loss | 4G |
| Offline storage available | 500 MB | 2 GB |

**Rules**
- A student on the minimum profile must be able to complete a full-length mock end to end. This is a launch gate, not a nice-to-have.
- Feature detection, never device or UA blocking.
- The minimum profile is the *default* test target in CI, not an afterthought.

---

## 3. Scalability (NFR-SCA)

| ID | Requirement | Target | Verification |
|---|---|---|---|
| SCA-01 | Horizontal scaling of stateless request handling | Linear throughput to the §1 ceiling; no single-node bottleneck | Load test at 3× projected peak |
| SCA-02 | Burst B1 — form pre-download | 80% of 100 K participants served in 15 min; ≥ 95% CDN cache hit | Synthetic burst test |
| SCA-03 | Burst B2 — submission storm | 250 K attempts (≈ 20 M responses) ingested within 5 min; zero rejection | Load test at ceiling |
| SCA-04 | Burst B3 — result read amplification | 100 K result reads/min sustained 30 min | Load test |
| SCA-05 | Response-record growth | Query performance constant as the response corpus grows from 10 M → 20 B rows | Benchmark at 10×, 100×, 1000× seed volume |
| SCA-06 | Item corpus growth | Search and retrieval latency constant from 25 K → 5 M items | Benchmark at scale tiers |
| SCA-07 | Elastic scale-down | Off-season capacity ≤ 25% of peak-season capacity | Cost review, seasonal |
| SCA-08 | Scale-up responsiveness | Absorb a 10× traffic step within 5 min without SLO breach | Chaos/step-load test |
| SCA-09 | Multi-exam scaling | Adding an exam adds no fixed per-exam infrastructure | Architecture review at M3 |
| SCA-10 | No scaling ceiling introduced by v1 decisions | Every component has a documented path to the §1 ceiling | Phase 2/3 design review |
| SCA-11 | Tenancy readiness | Organization-scoped data partitioning possible without schema migration | Phase 1 model review |
| SCA-12 | Read/write separation | Analytical load never degrades T0/T1 transactional latency | Load test with concurrent analytics |

**Rules**
- No design may require redesign — only reprovisioning — to reach the §1 ceiling.
- Scheduled mocks are *predictable*: pre-scaling is mandatory, reactive autoscaling alone is insufficient for B1/B2.

---

## 4. Availability (NFR-AVA)

| ID | Scope | Target | Monthly budget |
|---|---|---|---|
| AVA-01 | T0 — steady state | **99.95%** | 21.9 min |
| AVA-02 | T0 — during scheduled mock windows | **99.99%** | 4.4 min/mo equivalent |
| AVA-03 | T1 | **99.9%** | 43.8 min |
| AVA-04 | T2 | **99.5%** | 3.65 h |
| AVA-05 | T3 | **99.0%** | 7.3 h |

| ID | Requirement | Target | Verification |
|---|---|---|---|
| AVA-06 | Zero-downtime deployment | No user-visible interruption on release | Deploy under synthetic load |
| AVA-07 | Deployment freeze during mock windows | No production change within a scheduled mock window | Release policy + CI gate |
| AVA-08 | Infrastructure fault tolerance | Survive loss of any single availability zone with no data loss and ≤ 60 s degradation | AZ failure drill, semi-annual |
| AVA-09 | Dependency isolation | No third-party outage (payment, AI provider, email) may take down T0 | Dependency failure injection |
| AVA-10 | Client-side survivability | In-progress mock continues through a **complete** backend outage | Full-backend-down drill |
| AVA-11 | Error budget policy | Budget exhaustion freezes feature releases until restored | Monthly SLO review |
| AVA-12 | Planned maintenance | Announced ≥ 72 h ahead; never within 7 days of a live exam date | Change calendar |

**Honest constraint:** a 2–5 person team without dedicated SRE cannot credibly operate above 99.95% on T0. That number is chosen to be *achievable and defended*, not aspirational. Higher targets require staffing, not architecture.

---

## 5. Reliability (NFR-REL)

Reliability here means **correctness under failure** — distinct from uptime. Several targets are zero-tolerance.

| ID | Requirement | Target | Verification |
|---|---|---|---|
| REL-01 | Response data loss | **Zero**, under any network, device, or backend failure (INV-06) | Adversarial network + kill testing every release |
| REL-02 | Submission idempotency | 100% — no duplicate attempt or altered result on retry | Property-based + replay testing |
| REL-03 | Scoring determinism | 100% — identical inputs always produce identical outputs (INV-05) | Golden-set regression, every commit, blocking |
| REL-04 | Scoring correctness | 100% pass against released papers and official answer keys | Golden-set suite per exam profile version |
| REL-05 | Offline→online sync success | ≥ 99.9% completed within 60 s of connectivity restoration | Field telemetry |
| REL-06 | Sync conflict resolution | 100% resolved in favour of the complete local log; zero silent discards | Conflict simulation suite |
| REL-07 | Data durability (content, attempts) | ≥ 99.999999999% | Provider SLA + restore drills |
| REL-08 | Async job delivery | At-least-once with idempotent consumers; zero lost jobs | Job replay + poison-message testing |
| REL-09 | Timer integrity | Server-anchored; client clock manipulation cannot extend an attempt | Adversarial client testing |
| REL-10 | Payment reconciliation | 100% of payment events reconciled daily; zero unreconciled >24 h | Automated daily reconciliation |
| REL-11 | Entitlement consistency | Zero instances of paid access denied or unpaid access granted | Continuous assertion + audit |
| REL-12 | Content version integrity | 100% of attempts resolve to the exact item versions presented (INV-04) | Referential assertion in CI + production audit |
| REL-13 | Audit log completeness | 100% of mutating actions produce an audit record; append-only enforced | Mutation coverage test |
| REL-14 | Re-scoring safety | 100% dual-result retention; mandatory dry-run before execution (INV-11) | Operational gate + audit |
| REL-15 | Graceful degradation | Every dependency failure has a defined, tested degraded behavior | See §17 matrix; failure injection |

**REL-01, REL-02, REL-03, REL-04 are zero-tolerance.** A defect against any of them is a Sev-1 regardless of blast radius.

---

## 6. Performance (NFR-PER)

Measured on the §2 **minimum** device and network profile unless stated. Server latencies exclude network.

### 6.1 Client Experience

| ID | Metric | p50 | p95 | p99 |
|---|---|---|---|---|
| PER-01 | Item render (mid-tier Android) | 120 ms | **400 ms** | 800 ms |
| PER-02 | Time to first meaningful content, 4G | 1.2 s | **2.5 s** | 4.0 s |
| PER-03 | Time to first meaningful content, 3G floor | 3.0 s | **6.0 s** | 9.0 s |
| PER-04 | App/web cold start | 1.5 s | **3.0 s** | 5.0 s |
| PER-05 | Mock item navigation (offline) | 50 ms | **150 ms** | 300 ms |
| PER-06 | Response capture acknowledgement (local) | 10 ms | **50 ms** | 100 ms |
| PER-07 | Offline package download, full mock, 4G | 35 s | **90 s** | 180 s |

### 6.2 Server

| ID | Operation | p95 | p99 |
|---|---|---|---|
| PER-08 | T0/T1 read API | **200 ms** | 500 ms |
| PER-09 | T0/T1 write API | **300 ms** | 700 ms |
| PER-10 | Attempt submission ingest (75–180 responses) | **1.5 s** | 3.0 s |
| PER-11 | Scoring — JEE Main form (75 items) | **2.0 s** | 4.0 s |
| PER-12 | Scoring — NEET form (180 items) | **3.0 s** | 6.0 s |
| PER-13 | Result availability after submission | **60 s** | 120 s |
| PER-14 | Structured search | **300 ms** | 700 ms |
| PER-15 | Semantic search | **800 ms** | 1.5 s |
| PER-16 | Concept map computation (incremental) | **500 ms** | 1.2 s |
| PER-17 | Mock diagnostic report generation | **10 s** | 30 s |
| PER-18 | AI item generation, per candidate *(T3)* | **30 s** | 90 s |
| PER-19 | AI tutor first token | **2.0 s** | 4.0 s |

### 6.3 Payload & Resource Budgets

| ID | Budget | Target |
|---|---|---|
| PER-20 | Initial web bundle, compressed | ≤ 250 KB |
| PER-21 | Average item payload incl. media, compressed | ≤ 200 KB |
| PER-22 | Full mock offline package, compressed | ≤ **3 MB** |
| PER-23 | Client memory during a 3-hour mock | ≤ 250 MB, no growth trend |
| PER-24 | Battery drain over a 3-hour mock | ≤ 25% on the minimum device profile |
| PER-25 | Data consumed by a complete mock (download + sync) | ≤ 5 MB |

**Rules**
- PER-22 and PER-25 are cost *and* accessibility requirements — students pay for data.
- Performance budgets are enforced in CI; a regression beyond budget fails the build.
- Perceived performance during a mock is a **T0 correctness concern**: a student penalized by platform lag has been harmed.

---

## 7. Accessibility (NFR-ACC)

*(Closes PRD §15 M7.)*

| ID | Requirement | Target | Verification |
|---|---|---|---|
| ACC-01 | Conformance standard | **WCAG 2.2 Level AA** across all student-facing surfaces | Automated + manual audit per release; third-party audit pre-launch |
| ACC-02 | Mathematical content accessibility | All notation exposed as accessible structured markup with a screen-reader-verified reading order | Manual testing with TalkBack, VoiceOver, NVDA |
| ACC-03 | Diagram and figure alternatives | 100% of media assets carry meaningful alt text; complex figures carry long descriptions | Publication gate (FR-QM-06) |
| ACC-04 | Keyboard operability | Complete mock attempt achievable keyboard-only, including palette navigation and submission | Manual test per release |
| ACC-05 | Focus management | Visible focus indicator meeting 2.2 focus-appearance criteria; no focus traps | Automated + manual |
| ACC-06 | Contrast | ≥ 4.5:1 text, ≥ 3:1 UI components and graphical objects | Automated |
| ACC-07 | Non-colour encoding | No information conveyed by colour alone — critical in analytics and diagrams | Design review + manual |
| ACC-08 | Text scaling | Usable to 200% OS text scaling with no loss of content or function | Manual |
| ACC-09 | Touch targets | ≥ 44 × 44 CSS px with adequate spacing | Automated |
| ACC-10 | Motion | Honours reduced-motion preference; no motion required to complete a task | Manual |
| ACC-11 | Timing accommodations | Extended-time accommodations supported at the profile level for eligible students | Functional test |
| ACC-12 | Screen-reader mock parity | A screen-reader user can complete a full mock within the standard time | Assisted user testing pre-launch |
| ACC-13 | Regulatory | Conformance with Rights of Persons with Disabilities Act 2016 accessibility obligations | Legal review |

**Flagged risk:** ACC-02 is genuinely hard. Accessible mathematics with reliable screen-reader reading order across TalkBack, VoiceOver, and NVDA is not solved by choosing a rendering library — it requires structured source markup (already mandated by INV-14 and FR-TCH-02) plus explicit per-notation testing. Budget for it in Phase 1, not Phase 8.

---

## 8. Security (NFR-SEC)

| ID | Requirement | Target | Verification |
|---|---|---|---|
| SEC-01 | Transport encryption | TLS 1.3 preferred, 1.2 minimum; HSTS enforced; no plaintext transport anywhere | Automated scan per release |
| SEC-02 | Encryption at rest | All data stores, backups, and object storage encrypted | Infrastructure audit |
| SEC-03 | Credential storage | Memory-hard hashing (Argon2id class), per-credential salt, tuned work factor | Code review + audit |
| SEC-04 | Authorization model | Deny by default; every request authorized server-side at the point of access (INV-15) | Authorization test suite; negative-path coverage 100% on T0/T1 |
| SEC-05 | Privileged access | MFA mandatory for Content Ops, Support, Platform Admin; step-up for destructive actions | Access audit, monthly |
| SEC-06 | Session security | Short-lived tokens with rotation; revocation effective ≤ 60 s; full revocation on credential change | Functional + timing test |
| SEC-07 | Secrets management | No secret in source, image, or config; rotation ≤ 90 days; break-glass access audited | Secret scanning in CI (blocking) |
| SEC-08 | Answer-key confidentiality | Keys and solutions **never** present in any client payload before submission | Payload inspection test, every release, blocking |
| SEC-09 | Rate limiting | Per-identity and per-source limits on auth, search, export, reporting, and AI endpoints | Abuse simulation |
| SEC-10 | Input handling | Validation at every trust boundary; output encoding; no dynamic query construction from user input | SAST + code review |
| SEC-11 | Dependency management | Critical vulnerabilities patched ≤ **7 days**; high ≤ 30 days; automated SCA in CI | CI gate + weekly report |
| SEC-12 | Static analysis | SAST on every pull request; no new high-severity findings merged | CI gate |
| SEC-13 | Penetration testing | Independent test before public launch, annually thereafter, and before any B2B launch | Report + remediation tracking |
| SEC-14 | Audit immutability | Audit records append-only; no role can edit or delete; reads are themselves audited | Permission test + audit review |
| SEC-15 | Least privilege (infrastructure) | No shared production credentials; human production access is time-bound and audited | Access review, quarterly |
| SEC-16 | Payment data isolation | Card data never touches platform systems; PSP tokenization only (PCI SAQ-A scope) | Architecture review + PSP attestation |
| SEC-17 | Content extraction resistance | Systematic scraping detected and rate-limited; abuse signals raised (FR-MOD-05) | Abuse simulation |
| SEC-18 | Incident response | Sev-1 acknowledged ≤ 15 min, contained ≤ 4 h; post-incident review within 5 working days | Incident drill, semi-annual |
| SEC-19 | Breach notification | Regulator and affected users notified within statutory DPDP timelines | Documented runbook |
| SEC-20 | AI prompt-injection resistance | Content and user input cannot cause an AI agent to exceed its permission scope | Adversarial test suite |
| SEC-21 | Backup security | Backups encrypted, stored in a separate credential domain, immutable (object lock) | Restore drill + access audit |

**Explicit non-goal:** DRM-style content protection. It is defeatable, degrades accessibility, and harms legitimate users. Content leakage is mitigated through rate limiting, abuse detection, and the fact that the corpus's value is its structure and analytics — not the raw text.

---

## 9. Privacy (NFR-PRI)

| ID | Requirement | Target | Verification |
|---|---|---|---|
| PRI-01 | Data minimization | Only data with a documented purpose is collected; annual review removes the rest | Data inventory review |
| PRI-02 | Purpose limitation | No secondary use without fresh consent | Policy + code review |
| PRI-03 | Consent management | Versioned, timestamped, granular by purpose, revocable in-product | Functional + audit |
| PRI-04 | Minors' protection | No behavioural profiling for non-educational purposes; no targeted advertising — unconditional (INV-10) | Code review + configuration assertion |
| PRI-05 | Parental consent | Verified guardian consent recorded before processing beyond account creation | Functional test |
| PRI-06 | Access & portability | Fulfilled ≤ **30 days**; machine-readable | Request-handling audit |
| PRI-07 | Erasure | Fulfilled ≤ 30 days; only de-identified aggregates retained (INV-13) | Deletion verification test |
| PRI-08 | PII in telemetry | **Zero** PII in logs, traces, metrics, URLs, or analytics events | Automated log scanning (blocking) |
| PRI-09 | Analytics pseudonymization | Behavioural analytics operate on pseudonymous identifiers | Design review |
| PRI-10 | Data residency | Primary storage and processing in India; cross-border transfer only to permitted jurisdictions with documented safeguards | Infrastructure audit |
| PRI-11 | Sub-processor governance | Register maintained and published; DPA with each; user notice before material change | Quarterly review |
| PRI-12 | AI data handling | Student content is not used to train third-party models; contractually enforced and disclosed | Vendor contract review |
| PRI-13 | Privacy impact assessment | DPIA completed before launch and before any materially new processing | Documented DPIA |
| PRI-14 | Internal access to student data | Role-scoped, justified, logged; no ambient production data access | Access audit, monthly |

### 9.1 Retention Schedule

| Data | Retention |
|---|---|
| Account and profile | Life of account + 30 days after deletion request |
| Attempts, responses, scores | Life of account; de-identified aggregates retained indefinitely |
| Consent records | 7 years after withdrawal |
| Payment and invoice records | **8 years** (Companies Act) |
| Audit logs — security and academic | 3 years (1 year immediately queryable) |
| Application and access logs | 90 days |
| Session records | 90 days after expiry |
| Notification delivery logs | 180 days |
| AI conversation logs | 12 months |
| Support tickets | 3 years |
| Database backups | 35 days |

---

## 10. Maintainability (NFR-MNT)

Weighted heavily: a 2–5 person team has no capacity to absorb accidental complexity.

| ID | Requirement | Target | Verification |
|---|---|---|---|
| MNT-01 | Local development parity | Full stack running via **Docker Compose** with local equivalents of every managed service; no cloud account required | New-machine setup test |
| MNT-02 | Time to running local environment | ≤ **10 minutes** on a clean laptop, single command | Timed onboarding test |
| MNT-03 | Test coverage — scoring and domain rules | **100% branch coverage** on scoring, marking, and entitlement logic | CI gate, blocking |
| MNT-04 | Test coverage — overall | ≥ 80% line, ≥ 70% branch | CI gate |
| MNT-05 | Golden-set scoring regression | 100% pass, every commit, blocking | CI gate |
| MNT-06 | CI feedback time | Unit + integration ≤ **10 min**; full suite ≤ 30 min | CI metrics |
| MNT-07 | Deployment frequency | Daily-capable; no manual release ceremony | DORA metrics |
| MNT-08 | Change failure rate | ≤ 15% | DORA metrics |
| MNT-09 | Mean time to restore (T0) | ≤ **1 hour** | Incident metrics |
| MNT-10 | Engineer onboarding | Productive first meaningful change within ≤ 5 working days | Tracked per hire |
| MNT-11 | Architectural decision records | Every architectural decision recorded with context, options, and consequence | Repository review |
| MNT-12 | Bus factor | No module with fewer than 2 people able to change it safely | Quarterly review |
| MNT-13 | Dependency freshness | No runtime dependency more than one major version behind; security patches ≤ 30 days | Automated report |
| MNT-14 | Schema migration safety | All migrations backward-compatible and reversible; expand-contract only | Migration review gate |
| MNT-15 | Dead code and flags | Feature flags removed within 90 days of full rollout | Quarterly cleanup |
| MNT-16 | Runbooks | Every T0/T1 alert maps to a runbook | Alert review |
| MNT-17 | Reproducible builds | Identical inputs produce identical artifacts; all environments provisioned as code | CI verification |

**MNT-01 is the enforcement mechanism for cloud-agnosticism** (see EXT-06). If a component cannot run locally in Compose, it is a lock-in candidate and requires an explicit exception.

---

## 11. Extensibility (NFR-EXT)

Extensibility targets are stated in **effort**, because that is the only honest measure.

| ID | Requirement | Target | Verification |
|---|---|---|---|
| EXT-01 | New exam onboarding | ≤ **10 person-days**; zero core schema change; zero core code change | **M3 NEET launch is the acceptance test** |
| EXT-02 | New item type | ≤ 5 person-days; no change to attempt, response, or scoring core | JEE Advanced multi-correct as reference case |
| EXT-03 | New marking rule | Declarative configuration only; **zero code change** | Rule-engine test suite |
| EXT-04 | New locale for content | Zero schema change; content model already carries locale variants | Model review at Phase 1 |
| EXT-05 | AI provider substitution | ≤ 3 person-days behind a stable interface; no domain code affected | Provider-swap spike |
| EXT-06 | Cloud portability | No managed service adopted without a documented local and alternative-cloud equivalent | Exception register; MNT-01 as proof |
| EXT-07 | Organization/tenancy introduction | No schema migration of core content or attempt structures | Phase 1 model review |
| EXT-08 | Public API introduction | Additive; versioned; no breaking change to internal contracts | Contract review at Phase 7 |
| EXT-09 | Service extraction | Documented extraction seams; extracting a bounded context requires no domain rewrite | Phase 2 boundary review |
| EXT-10 | Taxonomy version transition | New syllabus version adopted without re-tagging unchanged concepts | Migration dry-run |
| EXT-11 | Adaptive engine introduction | Pluggable selection strategy; no change to practice session contracts | Phase 5 design review |
| EXT-12 | Native client introduction | All v1 APIs client-agnostic; no web-specific coupling | API review |

**Rule:** if any Horizon 1 or 2 item from PRD §14 requires a core domain change, Phase 1 was wrong and must be revisited — not patched.

---

## 12. Observability (NFR-OBS)

| ID | Requirement | Target | Verification |
|---|---|---|---|
| OBS-01 | Structured logging | All logs structured with a correlation identifier propagated across every service boundary | Trace inspection |
| OBS-02 | Distributed tracing | ≥ 1% baseline sampling; 100% on error; T0 paths fully traced | Trace coverage audit |
| OBS-03 | Service metrics | Rate, errors, duration for every endpoint; utilization and saturation for every resource | Dashboard review |
| OBS-04 | SLO instrumentation | Every §4 and §6 target has a live SLO dashboard with burn-rate alerting | Dashboard audit |
| OBS-05 | Time to detect (T0 incident) | ≤ **5 minutes** | Incident metrics + drills |
| OBS-06 | Time to attribute | ≤ 15 minutes to the failing component | Incident metrics |
| OBS-07 | Synthetic monitoring | Login, start mock, submit mock, view result probed every 60 s from ≥ 2 regions | Probe uptime |
| OBS-08 | Mock-window posture | Elevated monitoring and on-call presence for every scheduled mock window | Operational checklist |
| OBS-09 | Alert quality | ≤ 2 pages/week per on-call person; every page is user-impacting and actionable | Monthly alert review |
| OBS-10 | Business metric instrumentation | Mastery gains, conversion, content throughput, AI acceptance treated as first-class telemetry | Dashboard review |
| OBS-11 | Cost observability | Per-feature and per-tenant cost attribution; AI spend visible daily | Monthly cost review |
| OBS-12 | Data quality monitoring | Event-taxonomy conformance ≥ 99%; schema violations alerted | Pipeline monitoring |
| OBS-13 | Telemetry privacy | Zero PII in any telemetry stream (PRI-08) | Automated scanning, blocking |
| OBS-14 | Log retention | 30 days immediately queryable; 1 year in cold storage | Storage audit |
| OBS-15 | Client-side observability | Client errors, render performance, sync failures, and offline events reported | Telemetry coverage |

**Alert discipline is a hard constraint, not a preference.** For a team this size, alert fatigue is a direct availability risk — OBS-09 is binding.

---

## 13. Backup & Recovery (NFR-BAK)

| ID | Data class | RPO | RTO | Retention |
|---|---|---|---|---|
| BAK-01 | Attempts, responses, scores (T0) | ≤ **1 min** | ≤ **1 h** | 35-day PITR |
| BAK-02 | Content, taxonomy, exam profiles | ≤ 5 min | ≤ 4 h | 35-day PITR + weekly logical export |
| BAK-03 | Identity, entitlements, payments | ≤ 1 min | ≤ 1 h | 35-day PITR |
| BAK-04 | Audit logs | ≤ 5 min | ≤ 8 h | Full retention per §9.1 |
| BAK-05 | Media assets | ≤ 15 min | ≤ 8 h | Versioned, 90-day soft delete |
| BAK-06 | Derived data (embeddings, aggregates, statistics) | N/A — **recomputable** | ≤ 24 h to rebuild | Not backed up |

| ID | Requirement | Target | Verification |
|---|---|---|---|
| BAK-07 | Restore drill | **Quarterly**, timed, documented, from production-scale data | Drill report |
| BAK-08 | Backup integrity | Automated verification of every backup; failure alerts within 1 h | Automated check |
| BAK-09 | Backup isolation | Separate credential domain and account; immutable (object lock) | Access audit |
| BAK-10 | Cross-region replication | All T0 backups replicated to a second region | Infrastructure audit |
| BAK-11 | Recovery granularity | Point-in-time to 1-second precision within the PITR window | Drill verification |
| BAK-12 | Logical portability export | Weekly full content export in an open format | Automated job |

**BAK-06 is a deliberate cost decision:** derived data is explicitly designated recomputable and excluded from backup. This requires that rebuild procedures are tested (BAK-07) — an untested rebuild is not a recovery strategy.

**An untested backup is not a backup.** BAK-07 is binding; a missed drill is a Sev-3 incident.

---

## 14. Disaster Recovery (NFR-DRC)

### 14.1 Scenarios and Posture

| ID | Scenario | Year-1 posture | Year-3 posture |
|---|---|---|---|
| DRC-01 | Single AZ loss | Automatic failover, RTO ≤ 60 s, RPO 0 | Same |
| DRC-02 | Full region loss | Restore from cross-region backup — **RTO ≤ 8 h, RPO ≤ 15 min** | Warm standby — RTO ≤ 1 h, RPO ≤ 5 min |
| DRC-03 | Logical data corruption | PITR to pre-corruption point — RTO ≤ 4 h | Same |
| DRC-04 | Malicious deletion / ransomware | Restore from immutable backups in separate credential domain — RTO ≤ 8 h | Same |
| DRC-05 | Provider-level outage (AI, payment, email) | Degrade per §17; T0 unaffected | Multi-provider failover |
| DRC-06 | Complete backend unavailability during a mock | **Clients continue offline; zero attempt loss** | Same |

### 14.2 Requirements

| ID | Requirement | Target | Verification |
|---|---|---|---|
| DRC-07 | DR runbooks | Documented, versioned, executable by any engineer on the team | Runbook review |
| DRC-08 | DR game day | Full region-loss simulation **annually**; component failover semi-annually | Exercise report |
| DRC-09 | Recovery decision authority | Named decision-maker and documented escalation path | Runbook |
| DRC-10 | Communication plan | Student, author, and regulator communication templates prepared in advance | Documented plan |
| DRC-11 | Data reconciliation post-recovery | Documented procedure to reconcile client-held offline attempts after any recovery | Drill verification |
| DRC-12 | DR for a live exam window | Contingency plan for outage during a scheduled mock, including re-scheduling and score-protection policy | Documented policy |

**DRC-06 is the architecture's DR advantage and should be stated plainly:** because response capture is offline-first, a complete backend failure during a mock does not cost a single student their attempt. Recovery reconciles queued client submissions afterward. This is worth more than a hot standby, and costs nothing.

**Honest constraint:** an 8-hour region-loss RTO is what a 2–5 person team can genuinely execute. Warm standby is a Year-3 investment tied to headcount, not a v1 promise.

---

## 15. Compliance (NFR-CMP)

| ID | Regime | Obligation | Verification |
|---|---|---|---|
| CMP-01 | **DPDP Act 2023 (India)** — primary | Consent, notice, minors' protection, breach notification, data principal rights, Consent Manager readiness | Legal review + DPIA pre-launch |
| CMP-02 | GDPR-grade practice *(voluntary superset)* | Adopted to avoid rework on future international expansion | Design review |
| CMP-03 | IT Act 2000 & SPDI Rules | Reasonable security practices; published privacy policy | Legal review |
| CMP-04 | **RPwD Act 2016** | Accessibility obligations for digital services (see §7) | Accessibility audit |
| CMP-05 | Consumer Protection (E-Commerce) Rules 2020 | Named **Grievance Officer** with published contact; acknowledgement ≤ 48 h; resolution ≤ 30 days | Published policy + ticket metrics |
| CMP-06 | GST / CGST Rules | Compliant tax invoices, correct rate application, credit notes | Finance review |
| CMP-07 | Companies Act 2013 | Financial records retained 8 years | Retention audit |
| CMP-08 | **PCI DSS — SAQ-A scope only** | Card data never touches platform systems; PSP-hosted collection and tokenization | Architecture attestation |
| CMP-09 | RBI card-storage and e-mandate rules | No card storage; tokenization via PSP; pre-debit notification per mandate rules | PSP contract + functional test |
| CMP-10 | Copyright Act 1957 | Documented reproduction rights for every PYQ and third-party item (FR-QM-05) | Legal review of licensing register |
| CMP-11 | Terms, privacy policy, disclaimers | Published, versioned, acceptance recorded; explicit disclaimers on predicted scores and AI-generated content | Legal sign-off |
| CMP-12 | Sub-processor transparency | Public register; notice before material change | Quarterly review |
| CMP-13 | SOC 2 Type I *(deferred)* | Not pursued in Year 1; required before B2B/institute launch | Roadmap item |

**Scoping decision:** never handling card data keeps PCI scope at SAQ-A. This is a deliberate architectural constraint (SEC-16), not an implementation detail — it must survive Phase 2.

---

## 16. Cost Constraints (NFR-CST)

### 16.1 The Binding Economic Reality

At the PRD §8 pricing hypothesis (~₹1,299/yr Plus ≈ ₹108/month) and a 4% conversion rate, revenue per MAU is approximately **₹4.30/month**. A 70% gross margin therefore caps blended infrastructure and AI cost at roughly **₹1.30 per MAU per month (~$0.015)**.

This is the single hardest constraint in the entire specification. It means:
- Free-tier users must be **near-zero marginal cost** — no live AI inference, aggressive caching, CDN-served content.
- Offline-first is a cost strategy, not only a reliability strategy: it eliminates sustained server load during the most expensive hours.
- **Either conversion must exceed 6%, or free-tier consumption must be tightly capped.** This is a business decision, not an engineering one, and it is currently unresolved.

### 16.2 Targets

| ID | Constraint | Target | Verification |
|---|---|---|---|
| CST-01 | Pre-revenue infrastructure (through M1) | ≤ **₹15,000/month** (~$180) via local dev and free tiers | Monthly cost review |
| CST-02 | Launch infrastructure at 10 K MAU (M2) | ≤ ₹60,000/month (~$720) | Monthly cost review |
| CST-03 | Blended infra + AI COGS per MAU | ≤ **₹3.00/month** at 100 K MAU, declining with scale | Cost-per-MAU dashboard |
| CST-04 | Free-tier marginal cost per MAU | ≤ ₹1.00/month | Segmented cost attribution |
| CST-05 | AI runtime cost per paid MAU | ≤ ₹8.00/month | AI spend dashboard |
| CST-06 | Free-tier live AI inference | **Zero** — cached and pre-generated content only | Architecture assertion |
| CST-07 | AI cost per published item | ≤ **40%** of the human-only authoring baseline | Content cost report |
| CST-08 | CDN cache hit ratio for content and media | ≥ **95%** | CDN metrics |
| CST-09 | Egress per mock attempt | ≤ 5 MB total (PER-25) | Telemetry |
| CST-10 | Gross margin | ≥ 70% at 100 K MAU | Finance review |
| CST-11 | Off-season cost | ≤ 25% of peak-season cost | Seasonal cost review |
| CST-12 | Budget alerting | Alerts at 50 / 80 / 100% of monthly budget; AI spend hard-capped | Automated |
| CST-13 | Cost attribution | Every cost line attributable to a feature or tier | Tagging audit |
| CST-14 | Managed-service premium | Justified per service against self-hosting, including the operational cost of a team with no SRE | Phase 2 decision record |
| CST-15 | Cost regression gate | Any change raising cost-per-MAU by >10% requires explicit approval | Monthly review |

**Rule:** cost per MAU is tracked as a **first-class SLO**, reviewed monthly with the same seriousness as availability. In a low-ARPU market, cost overrun kills the product as surely as downtime.

---

## 17. Graceful Degradation Matrix

Every dependency failure has a defined, tested behavior (REL-15).

| Failure | Behavior | Student impact |
|---|---|---|
| Network loss during mock | Full local operation; queued sync | **None** |
| Complete backend outage during mock | Attempt continues; submission queues | **None** until submission |
| AI provider unavailable | Generation queues; tutor unavailable with clear messaging; all published content unaffected | Cosmetic |
| AI budget exhausted | Non-essential AI halted; core learning unaffected | Cosmetic |
| Search unavailable | Structured browse via taxonomy remains | Reduced discovery |
| Semantic search unavailable | Falls back to full-text and structured filtering | Reduced relevance |
| Analytics pipeline delayed | Cached last-known concept map served with a staleness indicator | Minor |
| Payment provider unavailable | Existing entitlements unaffected; new purchases deferred with retry | New purchases blocked |
| Notification provider unavailable | In-app inbox remains authoritative | Minor |
| Media/CDN degraded | Text content renders; media placeholder with retry | Moderate — **blocks mock start**, not an in-progress attempt |
| Read replica lag | Reads served from primary for T0 paths only | None |

**Invariant across all rows:** no degradation path may cause response data loss (REL-01) or an incorrect score (REL-03/04).

---

## 18. Verification Summary

| Method | Cadence | Gates release? |
|---|---|---|
| Golden-set scoring regression | Every commit | **Yes — blocking** |
| Performance budget checks | Every commit | **Yes — blocking** |
| SAST, SCA, secret scanning | Every pull request | **Yes — blocking** |
| Answer-key payload inspection (SEC-08) | Every release | **Yes — blocking** |
| Automated accessibility scan | Every release | **Yes — blocking** |
| Manual accessibility audit | Every release | No |
| Load test at 3× projected peak | Quarterly + pre-season | No |
| Adversarial network / kill testing | Every release | **Yes — blocking** |
| Restore drill | Quarterly | No |
| AZ failover drill | Semi-annually | No |
| DR game day (full region loss) | Annually | No |
| Independent penetration test | Pre-launch, then annually | **Yes — pre-launch** |
| Third-party accessibility audit | Pre-launch, then annually | **Yes — pre-launch** |
| Cost-per-MAU review | Monthly | No |
| SLO and error-budget review | Monthly | Freezes features on breach |
| Access and privilege review | Quarterly | No |

---
