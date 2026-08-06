# Security Architecture
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [NFR.md](NFR.md) §8–9 · [BACKEND-ARCHITECTURE.md](BACKEND-ARCHITECTURE.md) §4–5 · [DATA-ARCHITECTURE.md](DATA-ARCHITECTURE.md) §3, §10
**Phase:** 6 — Security, Identity & Integrity

> Mechanisms already decided elsewhere are referenced, not restated. This document adds the threat model, key hierarchy, rate-limit values, audit tamper evidence, and the anti-cheating and content-protection designs.

---

## 1. Threat Model

### 1.1 Assets, ranked by attacker value

| # | Asset | Why it's targeted | Primary control |
|---|---|---|---|
| 1 | **Answer keys, pre-submission** | Converts directly into exam score | Never in any client payload (SEC-08) |
| 2 | **The item corpus** | The moat — competitors and coaching institutes want it wholesale | Extraction economics (§10) |
| 3 | **Student PII** (minor-heavy) | DPDP liability, reputational | Single erasable location (§12) |
| 4 | **Attempt and score records** | Grade manipulation | Append-only + server-authoritative scoring |
| 5 | **Entitlement state** | Free access to paid content | Server-side derivation, never client-supplied |
| 6 | **Credentials** | Account takeover, sharing | §3 |
| 7 | **AI budget** | Cost-exhaustion denial of service — an under-recognised attack on a low-ARPU product | Per-user budgets enforced at enqueue |

### 1.2 Actors

| Actor | Capability | Motive | Realistic response |
|---|---|---|---|
| **Opportunistic student** | Browser, shared login | Answers, free access | Architecture (keys absent) + entitlement checks |
| **Motivated student** | Scripting, multiple accounts | High-stakes exam | Detection + statistical exclusion, not policing |
| **Competitor / scraper** | Distributed, funded, patient | Corpus acquisition | Raise extraction cost; make leaks traceable |
| **Coaching institute** | Bulk accounts, systematic | Corpus for own material | Concurrency limits + fingerprinting (§10) |
| **Insider** — author, reviewer, ops | Legitimate access to keys and content | Varies | Least privilege, step-up, tamper-evident audit |
| **Commodity external** | Credential stuffing, bots | Volume | Rate limiting, WAF |
| **AI-mediated** | Prompt injection via content | Capability escape | AI Service holds no write capability (D8) |

**The insider is the highest-privilege threat and receives the most design attention.** Content Ops can see every answer key; a reviewer can approve a defective item; Support can view student records. Each is constrained by scope, step-up, and audit rather than by trust.

### 1.3 Trust boundaries

```
UNTRUSTED           SEMI-TRUSTED              TRUSTED
─────────           ────────────              ───────
Client device  ──▶  API Gateway         ──▶   Core API
(assume fully       (TLS, WAF, rate           (authz, entitlement,
 compromised)        limit, request ID)        domain invariants)
                                                    │
Third-party    ◀──  Circuit breakers    ◀──────────┤
providers           (isolated, no T0 dep)           │
                                                    ▼
AI Service     ──▶  ACL (proposes only) ──▶   Content (never written by AI)
                                                    │
Retrieved      ──▶  Treated as data,             PostgreSQL
content             never instructions        (append-only grants revoked)
```

**Everything the client sends is hostile input, including timing, event IDs, and the response log.** The server re-validates the deadline, dedupes by event ID, and computes the score itself.

---

## 2. What Is Already Decided

| Concern | Where | Summary |
|---|---|---|
| Token design, session lifecycle, MFA, step-up | Backend §4 | Ed25519 JWT + opaque refresh with rotation and reuse detection; separate attempt token |
| Policy-based authorization, deny-by-default | Backend §5 | Evaluated at the command/query boundary; handler without a policy fails at boot |
| Append-only enforced by DB role | Data §3 P5 | App role holds no UPDATE/DELETE on audit, responses, scores, versions |
| No PII in append-only stores | Data §10 | Resolves the DPDP-erasure vs. immutable-audit conflict |
| PCI SAQ-A scope | NFR SEC-16 | Card data never touches platform systems |
| No proctoring, ever | PRD §12, DECISIONS C.4 | Permanently out of scope |

---

## 3. Authentication — deltas only

| Decision | Justification |
|---|---|
| Argon2id, tuned so a single verification costs ≥ 100 ms on production hardware | Cheap verification is cheap offline cracking. |
| Credential-stuffing defence is **rate limiting + breach-list rejection at registration**, not CAPTCHA | CAPTCHAs harm accessibility and are defeated cheaply; we also never solve them (policy). |
| Failure responses are identical for unknown identifier, wrong credential, and locked account | Distinct responses are a user-enumeration oracle. |
| Verification codes are single-use, short-lived, and rate-limited per identifier **and** per source | Per-identifier alone permits distributed enumeration. |
| Federated identity links only after verified contact match | Auto-linking on an unverified email is account takeover by design. |
| **The attempt token is bound to `attempt_id`, not the session**, and expires with the attempt | An exam must survive session refresh; the attempt token must not survive the exam. |

---

## 4. Authorization & RBAC

Roles are additive; scope narrows them (subject, tenant, ownership). Evaluated server-side at every access point.

| Capability | Guest | Student | Author | Reviewer | Content Ops | Support | Admin | AI Gen | AI Tutor |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Read published content | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read answer keys / solutions pre-attempt | ✗ | ✗ | ◐¹ | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Own attempts & analytics | ✗ | ✅ | ✅ | ✅ | ✗ | ◐² | ✗ | ✗ | ◐³ |
| Author drafts | ✗ | ✗ | ◐⁴ | ◐⁴ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Review / approve content | ✗ | ✗ | ✗ | ◐⁴ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Publish content | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Taxonomy / exam profile | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✅ | ✗ | ✗ |
| Form assembly & scheduling | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ |
| **Re-scoring** | ✗ | ✗ | ✗ | ✗ | ⚡ | ✗ | ⚡ | ✗ | ✗ |
| User & role administration | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ⚡ | ✗ | ✗ |
| Subscription adjustment | ✗ | ◐⁵ | ✗ | ✗ | ✗ | ✅ | ✅ | ✗ | ✗ |
| Read audit log | ✗ | ✗ | ✗ | ✗ | ◐⁶ | ✗ | ✅ | ✗ | ✗ |
| Bulk operations / export | ✗ | ◐⁷ | ✗ | ✗ | ⚡ | ✗ | ⚡ | ✗ | ✗ |

✅ full · ◐ scoped · ⚡ requires step-up · ✗ none
¹ own authored items only · ² metadata only, never responses · ³ read-only for grounding · ⁴ subject-scoped, never own content (INV-12) · ⁵ own subscription · ⁶ content scope only · ⁷ own data export

| Rule | Justification |
|---|---|
| **Support holds no mutation capability in Content, Assessment, or Scoring** (INV-09) | Academic records must not be alterable by the role most exposed to social engineering. |
| Every Support access to a user record is logged, **including reads** | Read access to a minor's record is itself a privacy event. |
| Reviewers are excluded from their own content at assignment *and* re-checked at decision | A single check is a single bug away from failing. |
| No role can alter its own role set | Removes self-escalation entirely. |

---

## 5. Secrets & Key Management

| Layer | Design |
|---|---|
| **Root** | KMS-managed root key; never exported |
| **Data keys** | Envelope encryption, one data key per store (primary DB, backups, object storage), rotated annually |
| **Backup keys** | **Separate credential domain from production** — a compromised production role cannot decrypt backups (SEC-21) |
| **Signing keys** | Independent keys with independent rotation: access tokens (Ed25519), form-package integrity, attempt deadlines |
| **Application secrets** | Injected at runtime from the secret store; never in images, env files, or repos; rotated ≤ 90 days |

| Decision | Justification |
|---|---|
| Signing-key rotation uses **overlapping validity** with published key IDs | Rotation must not invalidate in-flight tokens or an in-progress attempt. |
| Break-glass access is time-boxed, requires two approvers, and is audited | The account that can do anything is the account most worth compromising. |
| Secret scanning blocks CI on any commit | Detection after merge is detection after publication. |
| No secret is ever a build-time constant | An image is a distribution channel. |

---

## 6. Encryption

| Data state | Control |
|---|---|
| **In transit, external** | TLS 1.3 preferred, 1.2 floor; HSTS with preload; no plaintext anywhere |
| **In transit, internal** | TLS between all services including database connections |
| **At rest — database** | Storage-level encryption + column-level for contact channels and credential references |
| **At rest — object storage** | Server-side encryption; media and form packages served via short-lived signed URLs |
| **At rest — backups** | Encrypted under the separate backup key domain; immutable object lock |
| **At rest — client** | Local response log encrypted at rest on device; the form package is signed, not encrypted (it contains no keys) |

**The form package is deliberately unencrypted.** It carries no answer keys, no solutions, and no numeric specs — so encrypting it would defend nothing while adding a client-side key-management problem. Integrity is what matters, and that is a signature.

---

## 7. Rate Limiting

Token bucket per principal **and** per source. Limits are exposed in response headers so clients back off rather than retry into the wall.

| Path | Limit | Rationale |
|---|---|---|
| Login | 5 / 15 min per identifier; 20 / hr per source | Credential stuffing |
| Verification / reset send | 3 / hr per identifier | SMS cost and harassment |
| Registration | 10 / hr per source | Bulk account creation |
| **Item fetch** | 120 / min burst, **1,000 / hr sustained** | A student practises ~20–60 items/hr; this is ~20× headroom and still catches bulk extraction |
| **Solution fetch** | Entitlement quota, then 60 / hr | Solutions are the highest-value content per byte |
| Search | 60 / min | Enumeration via search is the subtler extraction path |
| Data export | 1 / day per account | Bulk exfiltration of own data at scale |
| AI tutor | Per-tier token budget, hard-capped | Cost-exhaustion (asset #7) |
| **Attempt submission** | **Effectively unlimited per attempt; deduped by idempotency key** | A rate limit that can lose an attempt is a correctness bug wearing a security costume |
| Reporting / analytics | 10 / min | Expensive queries |

| Decision | Justification |
|---|---|
| Limits apply to authenticated principals, not just IPs | An authenticated scraper is the realistic threat; IP limits alone miss it entirely. |
| Exceeding a content limit **raises an abuse signal**, it does not ban | Automated bans on false positives cost more than the extraction they prevent. |
| Sustained-window limits alongside burst limits | Burst-only limits are trivially defeated by pacing. |

---

## 8. Audit Logging

| Decision | Justification |
|---|---|
| Append-only enforced by **revoked UPDATE/DELETE grants** (Data §3 P5) | A code bug cannot violate it. |
| **Each record carries the hash of the previous record — a hash chain** | Makes deletion or reordering detectable *even by someone with database access*. This is the control that constrains the insider threat. |
| Daily chain root written to a **separate store under different credentials** | Anchors the chain so it cannot be silently rewritten wholesale. |
| Chain verified nightly; a break is a Sev-1 | An unverified integrity control is a claim, not a control. |
| Every record: principal (human or machine), action, target and version, timestamp, justification where required | INV-02. |
| Reading the audit log is itself audited | Audit access is a strong pre-incident signal. |
| **Audit log is a separate system from application logs** | Different retention (3 years vs. 30 days), different access, different legal weight. |
| No PII — pseudonymous principal IDs only | Resolves erasure vs. immutability (Data §10). |

---

## 9. Anti-Cheating

**Stance: this protects the validity of cohort statistics and the honesty of a student's own diagnostic signal. It does not police students.** A student who cheats on a practice set harms only their own diagnosis; the platform's obligation is to detect that the signal is unreliable, not to punish.

### 9.1 The architectural control

Everything else is secondary to one property: **answer keys, solutions, and numeric specs are absent from every client payload until submission** (SEC-08). The form package contains items and media only. Scoring happens server-side against server-held keys.

This closes the primary cheat vector — reading the key from the client — at the architecture level, verified by a blocking payload-inspection test on every release (F6). No surveillance can substitute for it, and with it, surveillance buys little.

### 9.2 Detection — behavioural signals only

| Signal | Detects |
|---|---|
| Impossible timing (correct answer faster than reading time) | External lookup |
| Timing bimodality within one attempt | Assistance on a subset |
| Accuracy inconsistent with established ability | Answer sharing |
| Improbable concurrent sessions across distant contexts | Credential sharing |
| Systematic sequential item access at machine pace | Extraction, not attempt |
| Answer-change patterns inconsistent with reasoning | Transcription from a source |

| Decision | Justification |
|---|---|
| **No camera, screen capture, keystroke analysis, or biometrics — permanently** | Poor accuracy, high cost, severe DPDP exposure with minors, and not what this market pays for. |
| Signals **annotate** the attempt; they never auto-invalidate it | A false positive on a legitimate high performer is the worst outcome available. |
| Anomalous attempts are **excluded from cohort statistics**; the student's own result stands | Protects the asset actually at risk — statistical validity. |
| Invalidating a personal result requires human review and a communicated reason | Due process (FR-MOD-06). |
| The policy is published to students in plain language | A rule students cannot read is not a rule. |
| Server-anchored, signed deadlines; client clock manipulation cannot extend an attempt | The one timing control that must be absolute. |

---

## 10. Content Protection

**DRM is rejected** — defeatable, accessibility-hostile, and it punishes legitimate users. The design instead raises extraction cost and makes leaks attributable.

| Control | Effect |
|---|---|
| **Per-account item-set fingerprinting** | Each student's practice selection is a distinct sample. `ExposureLedger` already records every presentation, so leaked content can be traced to the accounts that saw that combination — turning a passive ledger into forensic attribution at zero additional cost. |
| Sustained-window rate limits (§7) | Extracting 500K items at 1,000/hr takes 20 account-years |
| Exposure caps on mock-reserved items | The highest-value items are never in general circulation |
| Concurrency limits per tier | Bulk institutional sharing becomes visible |
| Abuse signals on sequential access patterns | Distinguishes practising from harvesting |
| Media served via short-lived signed URLs | Prevents deep-linking and bulk asset pulls |
| Licensing and provenance on every item | The legal path requires proving ownership |

**The strategic point:** the corpus's value is its structure, tagging, solutions, and the mastery analytics built on it — not the raw question text. A competitor who scrapes the text has copied the cheapest part and none of the moat. Protection is therefore proportionate, not absolute.

---

## 11. Payment Security

| Decision | Justification |
|---|---|
| **Card data never touches platform systems** — PSP-hosted collection, tokenization only | Keeps PCI scope at SAQ-A permanently; this is an architectural constraint, not an implementation detail. |
| No card storage; RBI-compliant tokenization via the PSP | Regulatory requirement and a liability we decline to hold. |
| Payment webhooks verified by signature and replayed idempotently | An unverified webhook is an entitlement-granting endpoint. |
| Entitlement granted only on **confirmed** payment; pending grants nothing | Optimistic granting is free access with extra steps. |
| Idempotency key on every payment operation | Double-charge is worse than a failed charge. |
| Daily automated reconciliation; nothing unreconciled beyond 24 h | Silent payment drift is undetectable without it. |
| Refunds above threshold require approval, justification, and audit | The insider path to value extraction. |
| Mandate pre-debit notification per RBI rules | Regulatory, and the alternative is chargebacks. |
| Payment provider isolated behind a circuit breaker; failure never interrupts an attempt | Commerce must not be able to break an exam. |

---

## 12. Privacy

| Decision | Justification |
|---|---|
| All directly identifying data lives in **one erasable location**; everything else carries a pseudonymous ID | Makes erasure a bounded operation rather than a corpus-wide scan (Data §10). |
| **Zero PII in logs, traces, metrics, URLs, or analytics** — enforced by a serializer **allowlist** | Denylist redaction fails open on the first unanticipated field. |
| Minors: no behavioural profiling for non-educational purposes, no targeted advertising — unconditional | INV-10, and enforced as a query-time predicate, not a convention. |
| Verified guardian consent before processing beyond account creation | DPDP; under-18 is a large share of this user base. |
| Consent versioned, timestamped, granular by purpose, revocable in-product | A consent record that cannot be reconstructed is not a consent record. |
| Access, portability, and erasure fulfilled ≤ 30 days | Statutory. |
| Student content contractually excluded from third-party model training | PRI-12, and disclosed. |
| Data residency: India; cross-border only with documented safeguards | Assumed, pending ratification. |
| DPIA before launch and before any materially new processing | Required, and it surfaces design problems while they are still cheap. |

---

## 13. Security Monitoring & Detection

Distinct from operational monitoring (NFR §12) — different signals, different responders.

| Signal | Threshold | Routes to |
|---|---|---|
| Authentication failure spike | 5× baseline over 10 min | Security on-call |
| Privileged action outside business hours | Any | Security on-call |
| Bulk content access above sustained limit | Any | Moderation triage |
| Data export volume anomaly | 3× account baseline | Security on-call |
| **Answer-key payload assertion failure** | **Any — Sev-1** | Immediate page |
| Audit hash-chain break | Any — Sev-1 | Immediate page |
| AI budget anomaly | 2× expected burn rate | Content Ops + security |
| Improbable concurrency | Confidence threshold | Moderation triage |
| New-device login on a privileged account | Any | Account owner + security |
| Failed authorization spike for one principal | 20 in 5 min | Security on-call |

| Decision | Justification |
|---|---|
| **Every authorization denial is logged with principal, resource, and reason** | Denials are the primary signal of both attacks and broken product design. |
| Security alerts route separately from operational alerts | They need different responders and different urgency. |
| Detection signals are advisory inputs to human decisions, never automatic sanctions | Consistent with §9 and FR-MOD-05. |
| Sev-1 definitions per DECISIONS §C.1; PII exposure is Sev-1 by definition | Removes judgment from the moment judgment is least reliable. |
| Independent penetration test pre-launch, annually, and before any B2B launch | The only control that finds what the design missed. |

---

## 14. Security Fitness Functions

Additions to the existing CI gates.

| # | Check |
|---|---|
| F35 | Answer keys, solutions, and numeric specs absent from every client payload — blocking |
| F36 | No handler reachable without a declared authorization policy |
| F37 | Negative-path authorization coverage 100% on T0/T1 |
| F38 | No PII pattern in any log, trace, or metric output |
| F39 | No secret in source, image, or committed config |
| F40 | App role holds no UPDATE/DELETE on any append-only table |
| F41 | Audit hash chain verifies over the last 24 hours |
| F42 | No card-data field exists in any schema or DTO |
| F43 | Every rate-limited route declares both burst and sustained limits |
| F44 | No new dependency with a known critical vulnerability |

---
