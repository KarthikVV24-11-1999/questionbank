# Data Architecture
**Product:** AI-Powered Online Examination & Question Intelligence Platform
**Version:** 0.1 · **Date:** 2026-08-05 · **Status:** Draft
**Traces to:** [DOMAIN-MODEL.md](DOMAIN-MODEL.md) · [NFR.md](NFR.md) §1, §13 · **Phase:** 3 — Data Architecture

> No DDL. Table families, keys, and access paths only. Phase 2 (System Architecture) was skipped; §1 records the topology decisions this design implies and which must be ratified there.

---

## 1. Storage Topology

| Store | Role | Choice | Local (Compose) parity |
|---|---|---|---|
| **Primary OLTP** | Every aggregate; system of record | **PostgreSQL 16+**, managed (RDS) | `postgres:16` |
| **Object storage** | Media bytes, offline form packages, cold analytics | S3-compatible | MinIO |
| **Cache / ephemeral** | Sessions, entitlement evaluation, hot reads. **Never a system of record.** | Redis/Valkey | `valkey` |
| **Search & vector** | FTS + embeddings | **Postgres FTS + pgvector**, in-database | Same image + extension |
| **Analytics** | Historical response analysis | **Parquet on object storage**, queried by DuckDB/Athena | DuckDB over local MinIO |
| **Queue / event relay** | Cross-context events | Transactional **outbox** in Postgres + relay | Same |

**Decisions this locks:**
- **Standard PostgreSQL, not Aurora-specific features.** Aurora is API-compatible, so moving *to* it later is trivial; moving *off* it is not. Nothing may depend on Aurora-only behavior. Same reasoning excludes Citus and Timescale — native declarative partitioning reaches the §1 ceiling without the lock-in or ops burden.
- **One primary database until proven insufficient.** Eleven contexts, one Postgres instance with schema-per-context. Contexts are logical boundaries; splitting the database is a Phase 2 extraction decision, not a starting position. A 2–5 person team operating eleven datastores is a failure mode.
- **No dedicated search cluster at launch.** Postgres FTS + pgvector serves the §1 Year-1 corpus. OpenSearch is a documented escape hatch with a defined trigger (§8.3), not a day-one cost.
- **Cross-schema foreign keys are prohibited.** Contexts reference each other by ID only — the same rule as the domain model. This is what makes later extraction mechanical rather than archaeological.

---

## 2. Normalization Policy

The requirement is "highly normalized." Applied literally to a content-rendering document, that produces a node-per-span table nobody can query usefully. The boundary:

| Normalize fully | Store as validated document (JSONB) |
|---|---|
| Anything joined, filtered, aggregated, or constrained | Anything only ever loaded whole and rendered |
| Identity, versions, lifecycle, references | `content_body` (stem, solution step, stimulus) |
| Taxonomy tags, media references, prerequisites | `marking_rule_set`, `timing_policy`, `navigation_policy` |
| Provenance, licensing, review decisions | `pre_check_result` payloads, `device_context` |
| Scores, outcomes, entitlements, exposure | `response_payload` (per item type) |

**Rules for every JSONB column**
1. Carries an explicit `*_schema_version` sibling column. No unversioned JSON anywhere.
2. Validated against a registered JSON Schema on write — the application enforces it; the column is not a dumping ground.
3. Anything inside it that must be queried is **extracted into a normalized column or child table**, not reached with a JSON path in a hot query.
4. Documents that are pinned by hash (`marking_rule_set`) store the canonical hash alongside.

`content_body` additionally carries derived projections written at the same time: `plain_text` (for FTS), `notation_terms[]` (for symbolic search), and `referenced_media_ids[]` — the last normalized out into `content_media_ref` so media usage is a real relationship, not a JSON scan.

---

## 3. Core Schema Patterns

### P1 — Identity / Version split
Every versioned aggregate becomes two families: `x` (identity, lifecycle state, `current_published_version_id`) and `x_version` (immutable snapshot, `version_no`, `created_by`, `created_at`).
Applies to: item, stimulus, solution, media_asset, taxonomy, exam_profile, plan, prompt, model.
**`x_version` rows are never updated.** Enforced at the database role level (P5).

### P2 — Lifecycle state, not soft delete
Blanket `deleted_at` on every table is rejected. It forces a filter into every query, breaks unique constraints, and — critically — a soft-deleted row is still stored personal data under DPDP, so it does not satisfy erasure.

| Deletion semantics | Mechanism | Applies to |
|---|---|---|
| Content withdrawal | `lifecycle_state = retired/suspended` + reason | item, stimulus, solution, media_asset |
| Reversible user action | `deleted_at` (partial unique indexes exclude it) | draft item, bookmark, saved search, study plan, notification preference |
| Account withdrawal | **De-identification**, not deletion (INV-13) | user → pseudonymous id retained; PII destroyed |
| Operational expiry | Partition detach + drop | session, application log, notification instance |

`deleted_at` exists on roughly 8 tables, not 200.

### P3 — Audit: two mechanisms, deliberately separate
- **`audit_record`** — append-only, application-written, one row per consequential command. Columns: `principal_kind` (human / ai_agent / system), `principal_id`, `action`, `target_context`, `target_type`, `target_id`, `target_version`, `justification`, `occurred_at`. Time-partitioned.
- **Version tables (P1)** — the *content* history. Already complete; no shadow tables needed.

**Generic trigger-based history tables are rejected.** They double write cost on every table to duplicate what P1 and `audit_record` already provide.

### P4 — Transactional outbox
Cross-context events (`AttemptSubmitted`, `ChallengeUpheld`, `ItemPublished`, `ScorePublished`) are written to `outbox_message` **in the same transaction** as the aggregate change, then drained by a relay. Without this, "attempt submitted but never scored" becomes a real production class of bug. Time-partitioned, aggressively pruned after acknowledgement.

### P5 — Append-only enforced at the database, not in code
The application role holds no `UPDATE` or `DELETE` grant on: `*_version` (post-publication), `response_event`, `audit_record`, `score_record`, `item_outcome`, `exposure_ledger_entry`, `invoice`, `ai_spend_ledger`, `consent_grant`.
A code bug then cannot violate INV-03, INV-06, or INV-11. This is the single highest-leverage integrity control in the design.

### P6 — Identifiers: UUIDv7 everywhere
Time-ordered UUIDs. Required because offline clients generate `attempt_id` and `response_event_id` before any server contact. Random UUIDv4 would fragment every insert-heavy B-tree; sequential bigints cannot be client-generated. This decision is effectively irreversible at scale — see §13 R4.

### P7 — Tenancy carried from day one
Every table that will *ever* be organization-scoped carries `tenant_id`, defaulted to the platform tenant. Nullable-later is a multi-billion-row migration (§13 R5). Cost now: one column. Applies to: user, item, form, attempt, subscription, and their descendants.

### P8 — Optimistic concurrency
`aggregate_version` integer on every aggregate root. No pessimistic locking on any student-facing path.

### P9 — Idempotency as a first-class column
`idempotency_key` with a unique constraint on: `attempt_submission`, `payment_transaction`, `outbox_message` consumption, `generation_run`. REL-02 is a constraint, not retry logic.

---

## 4. Logical Schema by Context

Table families with their defining columns. Descendant/child tables shown indented.

### Identity & Access — schema `identity`

| Table | Key columns |
|---|---|
| `user` | `user_id` PK · `tenant_id` · `display_name` · `date_of_birth` · `account_state` · `is_minor` (generated) · `aggregate_version` |
| `user_credential` | `user_id` FK · `algorithm` · `secret_ref` · `work_factor` · `rotated_at` |
| `contact_channel` | `user_id` FK · `channel_type` · `value` · `verification_state` · `is_primary` · unique(`channel_type`,`value`) where active |
| `role_assignment` | `user_id` FK · `role` · `scope_type` · `scope_id` · `granted_by` · `justification` |
| `consent` | `consent_id` PK · `user_id` · `purpose` |
| `consent_grant` | `consent_id` FK · `state` · `policy_version` · `granted_at` · `evidence` · `guardian_attestation` — **append-only** |
| `session` | `session_id` PK · `user_id` · `device_context` (JSONB) · `issued_at` · `absolute_expiry` · `revoked_at` |
| `audit_record` | see P3 — **partitioned** |

### Curriculum — schema `curriculum`

| Table | Key columns |
|---|---|
| `concept_identity` | `concept_identity_id` PK · `canonical_name` · `subject_domain` · `created_in_version` · `superseded_by` |
| `taxonomy_version` | `taxonomy_version_id` PK · `exam_family` · `academic_year` · `state` · `published_at` |
| `concept_node` | `taxonomy_version_id` FK · `concept_identity_id` FK · `parent_node_id` · `exam_weight` · `depth` |
| `prerequisite_edge` | `taxonomy_version_id` · `from_concept_identity_id` · `to_concept_identity_id` · `strength` |
| `taxonomy_migration` | `migration_id` · `from_version` · `to_version` · `state` |
| `taxonomy_mapping` | `migration_id` FK · `kind` (identity/rename/move/split/merge/removal) · `from_ids[]` · `to_ids[]` · `disposition` |
| `exam` | `exam_id` PK · `code` · `jurisdiction` · `conducting_body` |
| `exam_profile_version` | `profile_version_id` PK · `exam_id` FK · `academic_year` · `state` · `taxonomy_version_id` · `timing_policy` (JSONB) · `navigation_policy` (JSONB) · **`marking_rule_set`** (JSONB) · **`marking_rule_set_hash`** · `policy_schema_version` · `golden_set_validation` |
| `exam_section_spec` | `profile_version_id` FK · `ordinal` · `subject` · `item_count` · `item_type_mix` · `max_marks` |

### Content — schema `content`

| Table | Key columns |
|---|---|
| `item` | `item_id` PK · `tenant_id` · `item_type` · `lifecycle_state` · `current_published_version_id` · `retirement_reason` · `replaced_by_item_id` |
| `item_version` | `item_version_id` PK · `item_id` FK · `version_no` · `stem_body` (JSONB) · `stem_plain_text` · `difficulty_estimate` · `stimulus_version_id` · `authored_by` · `authored_by_kind` — **immutable** |
| `item_option` | `item_version_id` FK · `option_id` · `ordinal` · `body` (JSONB) · `is_correct` |
| `item_numeric_spec` | `item_version_id` FK · `expected_value` · `comparison_mode` · `tolerance_value` · `significant_figures` · `range_min/max` · `unit_canonical` · `unit_required` · `accepted_forms[]` |
| `item_taxonomy_tag` | `item_version_id` FK · `concept_identity_id` FK · `taxonomy_version_id` · `weight` · `is_primary` |
| `item_provenance` | `item_version_id` FK · `source_type` · `source_exam` · `source_year` · `source_session` · `model_version_id` · `prompt_version_id` · `generation_run_id` · `confidence` |
| `content_licensing` | `owner_type` · `owner_version_id` · `status` · `license_ref` · `attribution` · `expires_at` — `unresolved` blocks publication |
| `item_version_locale` | `item_version_id` FK · `locale` · `stem_body` · `options` · `translated_by` · `review_state` |
| `review_decision` | `target_type` · `target_version_id` · `reviewer_id` · `decision` · `reason_category` · `pre_edit_version_id` · `signed_at` |
| `review_assignment` | `assignment_id` · `target_ref` · `assigned_to` · `priority` · `due_by` · `state` |
| `stimulus` / `stimulus_version` / `stimulus_version_locale` | Mirrors item pattern |
| `solution` / `solution_version` / `solution_version_locale` | `solution_version_id` · `item_version_id` FK · `final_answer_assertion` |
| `solution_step` | `solution_version_id` FK · `ordinal` · `body` (JSONB) |
| `distractor_analysis` | `solution_version_id` FK · `option_id` · `misconception_body` |
| `alternate_approach` | `solution_version_id` FK · `label` · `steps` (JSONB) |
| `media_asset` / `media_asset_version` | `storage_key` · `checksum` · `mime_type` · `width/height` · **`alt_text` NOT NULL** · `long_description` |
| `media_derivative` | `media_asset_version_id` FK · `variant` · `storage_key` · `bytes` |
| `content_media_ref` | `owner_type` · `owner_version_id` · `media_asset_version_id` — normalized usage graph |
| `item_defect` / `defect_report` | `item_version_id` · `category` · `severity` · `triage_state` · `resolution` |
| `answer_key_challenge` | `item_version_id` · `attempt_id` · `claimed_answer` · `justification` · `outcome` · `adjudication_reasoning` |

### Assessment — schema `assessment`

| Table | Key columns |
|---|---|
| `form` | `form_id` PK · `tenant_id` · `profile_version_id` FK · `form_type` · `state` · `schedule_window` · `result_embargo_until` |
| `form_item_slot` | `form_id` FK · `slot_id` · `ordinal` · `section_ordinal` · `item_id` · **`item_version_id`** · `stimulus_version_id` · `marks_available` |
| `attempt` | `attempt_id` PK (UUIDv7, client-generated) · `tenant_id` · `user_id` · `form_id` · `mode` · `delivery_policy` (JSONB) · **`attempt_pin`** (JSONB + hash) · `state` · `started_at` · `server_deadline` — **partitioned by `started_at`** |
| `attempt_slot` | `attempt_id` · `started_at` (partition key) · `slot_id` · `item_version_id` · `current_response` (JSONB projection) · `flag_state` · `cumulative_time_ms` — **co-partitioned** |
| `response_event` | `response_event_id` (UUIDv7) · `attempt_id` · `started_at` (partition key) · `user_id` · `slot_id` · `sequence` · `kind` · `payload` (JSONB) · `client_ts` · `server_ts` — **append-only, partitioned, the largest table in the system** |
| `attempt_submission` | `attempt_id` · **`idempotency_key`** unique · `submitted_at` · `submission_mode` · `client_event_count` · `server_ack_at` |

### Scoring — schema `scoring`

| Table | Key columns |
|---|---|
| `score_record` | `score_record_id` PK · `attempt_id` · `attempt_started_at` (partition key) · `marking_rule_set_hash` · **`rule_schema_version`** · `generation` · `is_current` · `total_raw` · `total_max` · `computed_at` · `rescoring_operation_id` — **append-only, partitioned** |
| `score_section` | `score_record_id` FK · `section_ordinal` · `raw` · `attempted/correct/incorrect` · `negative_marks` |
| `item_outcome` | `score_record_id` FK · `slot_id` · `item_version_id` · `correctness` · `marks_awarded` · **`rule_applied_id`** · `rule_explanation` |
| `rescoring_operation` | `operation_id` · `trigger` · `scope` · `reason` · `dry_run_result` (JSONB) · `state` · `authorized_by` |

Unique partial index guarantees exactly one `is_current` score record per attempt.

### Psychometrics — schema `psychometrics` *(all derived, all recomputable)*

`item_statistics` (`item_version_id` PK · exposure · p_value · discrimination · median_time · anomaly_flags · is_above_threshold) · `distractor_distribution` · `exposure_ledger_entry` (**partitioned by `presented_at`**) · `form_statistics` · `form_percentile` · `calibration_run` · `item_parameter`

### Learning — schema `learning`

| Table | Key columns |
|---|---|
| `learner_profile` | `user_id` PK · `target_exam_id` · `target_year` · `current_class` · `locale` · `timezone` · `accommodations` (JSONB) |
| `learner_scope_concept` | `user_id` · `concept_identity_id` — declared syllabus scope |
| `concept_state` | `user_id` · `concept_identity_id` · `state` · `confidence` · `evidence_count` · `distinct_item_count` · `distinct_session_count` · `last_evidence_at` · `difficulty_band` — **partitioned by hash(`user_id`); ~2 B rows at ceiling** |
| `mastery_transition` | `user_id` · `concept_identity_id` · `from_state` · `to_state` · `qualifying_evidence` · `verifying_evidence` · `verified_at` · `is_regression` — **the north-star event source** |
| `review_schedule_entry` | `user_id` · `concept_identity_id` · `due_at` · `interval_days` · `consecutive_successes` · `lapse_count` |
| `error_entry` | `entry_id` · `user_id` · `attempt_id` · `slot_id` · `concept_identity_id` · `error_cause` · `annotation` · `resolved_by_transition_id` |
| `bookmark`, `study_plan`, `study_plan_milestone` | — |

### AI Content — schema `ai`

`model_version` · `prompt_version` · `generation_run` (`budget_consumed`, `state`, `initiated_by`) · `generation_candidate` (`disposition`, `confidence`, `rejection_reason`) · `pre_check_result` (`check`, `passed`, `rationale`) · `evaluation_run` · `evaluation_score` · `ai_budget` · **`ai_spend_ledger`** (append-only, partitioned by month) · `tutor_conversation` / `tutor_turn` (H1)

`content_embedding` — `owner_type` · `owner_version_id` · **`embedding_model_version_id`** · `vector` · `generated_at`. Deliberately **separate from `item_version`**: derived, regenerated on model change, and would otherwise bloat the hottest content table.

### Commerce — schema `commerce`

`plan` / `plan_version` (`entitlement_grants` JSONB) · `subscription` (**`plan_version_id` pinned**, `state`, `current_period`) · `subscription_state_change` · `quota_ledger` (`user_id`, `period`, `quota_key`, `consumed`, `limit`) · `payment_transaction` (**`idempotency_key`** unique, `psp_reference`, `reconciled_at`; **no card data — CMP-08**) · `mandate` / `mandate_notification` · `invoice` / `invoice_line` (immutable, 8-year retention) · `credit_note` · `promotion` / `promotion_redemption` · `refund_request`

### Engagement — schema `engagement`

`notification_template` / `notification_template_version` / `template_locale` · `notification_preference` · `notification_instance` (**partitioned by `created_at`**, 180-day retention) · `delivery_ledger`

### Trust & Safety — schema `trust`

`moderation_case` / `moderation_report` / `moderation_decision` · `sanction` / `sanction_appeal` · `abuse_signal`

---

## 5. Read Models

The authoring tables are optimized for governance; the student read path must not touch them.

| Projection | Serves | Refresh |
|---|---|---|
| **`published_item`** | Practice selection, form assembly, search, similar-item | Event-driven on `ItemPublished` / `ItemRetired` |
| `published_item_concept` | Concept-filtered selection | Same |
| `item_search_index` | FTS (`tsvector`) + `vector` | Same |
| `learner_dashboard` | Concept map summary, streaks, next action | Incremental on `ScorePublished` |
| `mock_result_summary` | B3 result-rush reads | On `ScorePublished` + on re-score |
| `content_coverage` | Ops gap dashboard | Materialized view, hourly |
| `reviewer_queue` | Review workspace | Live query — low volume |

`published_item` carries denormalized `item_type`, primary concept, empirical difficulty, exposure count, and entitlement tier. It is the single most-read table in the system and holds **published rows only** — a fraction of `item_version`.

---

## 6. Indexing Strategy

Indexes are specified by **access path**, not by column. Every index below traces to a named hot path; anything else is not created.

| # | Access path | Index |
|---|---|---|
| A1 | Login by identifier | Unique on `contact_channel(channel_type, value)` **partial** where verification_state = verified |
| A2 | Load form for delivery (B1) | `form_item_slot(form_id, ordinal)` **covering** `item_version_id`, `stimulus_version_id`, `marks_available` |
| A3 | Submission ingest (B2) | **PK only.** `response_event` carries no secondary B-tree — write throughput dominates |
| A4 | Read attempt for scoring | `attempt_slot(attempt_id)` within partition; `response_event(attempt_id, slot_id, sequence)` **BRIN + PK**, no B-tree on `attempt_id` |
| A5 | Result read (B3) | `score_record(attempt_id)` **partial** where `is_current` |
| A6 | Attempt history for a learner | `attempt(user_id, started_at DESC)` — local per partition |
| A7 | Concept map read | `concept_state(user_id, concept_identity_id)` PK — hash-partition-local |
| A8 | Practice item selection | `published_item(concept_identity_id, difficulty_band, item_type)` **covering** |
| A9 | Exclude recently seen | `exposure_ledger_entry(user_id, item_id, presented_at DESC)` |
| A10 | Full-text search | **GIN** on `item_search_index.tsvector` |
| A11 | Semantic search | **HNSW** on `content_embedding.vector`, partial per `embedding_model_version_id` |
| A12 | Duplicate detection | Same HNSW, plus trigram GIN on `stem_plain_text` |
| A13 | Review queue | `review_assignment(assigned_to, state, due_by)` **partial** where state = pending |
| A14 | Content coverage | `item_taxonomy_tag(concept_identity_id)` + matview |
| A15 | Error notebook | `error_entry(user_id, resolved_by_transition_id NULLS FIRST, created_at DESC)` |
| A16 | Spaced review due | `review_schedule_entry(user_id, due_at)` **partial** where due_at ≤ horizon |
| A17 | Outbox drain | `outbox_message(state, created_at)` **partial** where state = pending |
| A18 | Audit lookup | `audit_record(target_type, target_id, occurred_at DESC)` + BRIN on `occurred_at` |
| A19 | Payment reconciliation | `payment_transaction(reconciled_at NULLS FIRST, created_at)` **partial** |
| A20 | Idempotent submission | Unique on `attempt_submission(idempotency_key)` |

**Principles**
- **BRIN over B-tree on every append-only time column.** `response_event` and `audit_record` are inserted in time order; BRIN is orders of magnitude smaller and adequate for range scans.
- **Partial indexes on lifecycle state**, not full — `WHERE state = 'pending'` on a queue is small and stays small.
- **Write-hot tables carry the minimum viable index set.** Every index on `response_event` is paid 20 M times during a single submission storm.
- **No JSONB GIN indexes.** Anything needing a query was extracted to a column (§2 rule 3). A GIN index on `content_body` would be an admission that extraction failed.
- Covering indexes only on A2 and A8 — the two paths where an extra heap fetch multiplies across a burst.

---

## 7. Partitioning

### 7.1 The bounded-hot-set principle

Postgres never holds 20 B response rows. It holds a **rolling 18-month hot window**; older partitions are detached and written to Parquet in object storage (§8). At the Year-3 §1 model that is ~2–3 B rows resident — comfortably within native declarative partitioning.

### 7.2 Partitioned tables

| Table | Strategy | Key | Granularity | Rationale |
|---|---|---|---|---|
| `response_event` | RANGE, sub-HASH | `started_at`, sub `attempt_id` | Monthly × 8 | Largest table. Time range enables detach-and-archive; hash sub-partitions spread the B2 write burst |
| `attempt` | RANGE | `started_at` | Monthly | Aligns with response_event |
| `attempt_slot` | RANGE | `started_at` *(denormalized)* | Monthly | **Co-partitioned** with attempt so scoring joins stay partition-local |
| `score_record`, `item_outcome` | RANGE | `attempt_started_at` *(denormalized)* | Monthly | Co-partitioned; re-scoring writes land in the original attempt's partition |
| `concept_state` | HASH | `user_id` | 64 | No time dimension — it is current state. Hash gives per-learner locality for A7 |
| `mastery_transition`, `error_entry` | HASH | `user_id` | 64 | User-scoped access dominates |
| `exposure_ledger_entry` | RANGE | `presented_at` | Monthly | Append-only; archival by detach |
| `audit_record` | RANGE | `occurred_at` | Monthly | Retention by detach; 3-year policy |
| `outbox_message` | RANGE | `created_at` | Daily | Pruned within days; daily partitions make cleanup a drop |
| `notification_instance` | RANGE | `created_at` | Monthly | 180-day retention by drop |
| `session` | RANGE | `created_at` | Weekly | 90-day retention by drop |
| `ai_spend_ledger` | RANGE | `occurred_at` | Monthly | Append-only cost ledger |

### 7.3 Deliberate denormalizations for partition alignment

`started_at` is copied into `attempt_slot`, `response_event`, `score_record`, and `item_outcome`; `user_id` is copied into `response_event`. Both are immutable once written. Without them, every scoring join crosses partitions and DPDP erasure requires a full scan. This is the correct trade and is recorded here so it is never "cleaned up."

### 7.4 Rejected

- **Hash-partitioning `attempt`/`response_event` by `user_id`.** Gives per-learner locality but makes archival impossible — you can never drop a partition. Retention wins; time-range is the primary dimension.
- **Partitioning `item` / `item_version`.** 5 M rows at ceiling. Partitioning adds planning cost for no benefit.

---

## 8. Analytics

### 8.1 Three tiers, three trigger points

| Tier | Mechanism | Serves | Trigger to advance |
|---|---|---|---|
| **T1 — now** | Read replica + materialized views | Ops dashboards, coverage, reviewer throughput | Default |
| **T2 — at scale** | Nightly Parquet export to object storage; DuckDB / Athena | Historical response analysis, cohort studies, psychometrics | `response_event` > 500 M rows **or** analytical load > 5% replica CPU |
| **T3 — later** | Columnar warehouse (ClickHouse or Redshift) | Sub-second interactive analytics | Only when T2 query latency blocks a user-facing feature |

T2 is the important choice: **Parquet on object storage with no always-on cluster** costs effectively nothing when idle. At CST-01's ₹15,000/month pre-revenue budget, an always-on warehouse is disqualifying.

### 8.2 Behavioural events bypass Postgres entirely
`analytics_event` (NFR M2 / FR-ANA-10) is appended directly to object storage as date-partitioned Parquet — never to the OLTP database. Events not captured are permanently lost, so capture starts at M0; but they must not cost transactional write throughput. Taxonomy conformance is validated at the ingestion edge.

### 8.3 Search escape hatch
Move FTS/vector to OpenSearch only when: corpus > 2 M items **or** A10/A11 p95 breaches PER-14/PER-15 **or** vector index maintenance degrades OLTP write latency. Until then, in-database search removes an entire system from the operational surface.

---

## 9. Media, Multilingual, AI Metadata

**Media.** Metadata in Postgres, bytes in object storage — never bytes in the database. `media_asset_version` holds `storage_key`, `checksum`, dimensions, and mandatory `alt_text`. `media_derivative` holds pre-generated variants (mobile, print, WebP/AVIF) so PER-21's 200 KB item budget is met by serving the right variant, not by resizing at request time. `content_media_ref` normalizes the usage graph, making "which published items use this asset?" a join rather than a JSON scan — required to refuse deletion of in-use assets.

**Multilingual.** `*_version_locale` child tables keyed on `(version_id, locale)`. The source-locale version is authoritative for correctness; a locale row carries its own `review_state` and reviewer. A correctness change to the source creates a new source version, which orphans every locale row until re-translated and re-reviewed — enforced by the publication precondition, not by a nullable flag. UI strings are not a database concern.

**AI metadata.** Provenance is normalized into `item_provenance` with real foreign keys to `model_version`, `prompt_version`, and `generation_run` — not a JSON blob. This exists to answer one question under pressure: *"a defect was found in prompt v7 — which published items came from it?"* That must be an index scan, not a corpus crawl. `ai_spend_ledger` is append-only and partitioned so CST-05 is measurable daily rather than reconstructed monthly.

---

## 10. Retention, Archival & the Erasure Conflict

**The conflict:** DPDP grants erasure; INV-02/INV-06 require immutable append-only logs. Both cannot hold if those logs contain personal data.

**Resolution: no PII in any append-only store.** `response_event`, `audit_record`, `exposure_ledger_entry`, and `ai_spend_ledger` carry only the pseudonymous `user_id`. Every piece of directly identifying data lives in `user` and `contact_channel` — one erasable location. Erasure destroys the identifying record and retains the pseudonymous behavioural history, which is then no longer personal data. Crypto-shredding is the fallback if any identifying field proves unavoidable, but the design goal is that none is.

| Data | Hot (Postgres) | Cold (Parquet) | Destroyed |
|---|---|---|---|
| `response_event`, `attempt` | 18 months | Indefinite (pseudonymous) | — |
| `score_record` | 36 months | Indefinite | — |
| `audit_record` | 12 months | To 3 years | After 3 years |
| `session` | 90 days | — | Partition drop |
| `notification_instance` | 180 days | — | Partition drop |
| `outbox_message` | 7 days | — | Partition drop |
| Invoices, payments | 8 years | — | Statutory (CMP-07) |
| User PII | Life of account | **Never** | On erasure, ≤ 30 days |

---

## 11. Multi-Exam Extensibility — the Proof

Adding NEET UG (M3) requires **inserts only**:

| Step | Action | Schema change |
|---|---|---|
| 1 | Insert `exam` row | None |
| 2 | Insert `exam_profile_version` + `exam_section_spec` rows; `marking_rule_set` JSONB encodes +4/−1, single-correct only | None |
| 3 | Insert `taxonomy_version` + `concept_node` rows for the NEET syllabus | None |
| 4 | Author items tagged to those concepts | None |
| 5 | Assemble forms against the new profile | None |

**No table is named after an exam. No column is exam-specific.** JEE Advanced's graded partial credit is added the same way — a `marking_rule_set` with partial-credit rule rows. Multi-correct items require one new `item_multicorrect_spec` child table and one new `item_type` value: additive, no migration of existing data (EXT-02).

---

## 12. Consistency Boundaries

| Guarantee | Scope |
|---|---|
| **Strong (single transaction)** | Any one aggregate + its outbox message |
| **Strong** | Attempt submission + all its response events |
| **Strong** | Score record + item outcomes |
| **Eventual (outbox-driven)** | Attempt → Psychometrics, Learning, Engagement |
| **Eventual** | Item published → `published_item`, search index, embeddings |
| **Eventual** | Score published → concept map, dashboards |
| **Explicitly accepted** | "No item published without a solution" — a publication *precondition* check, not a database constraint (D5) |

Read-your-own-writes is guaranteed for: submission acknowledgement, entitlement change, and profile edits. Everywhere else, staleness is surfaced in the UI rather than hidden.

---

## 13. Migration Risks

Ranked by cost of being wrong.

| # | Risk | Why it is expensive | Mitigation |
|---|---|---|---|
| **R1** | **Partition key regret** on `response_event` / `attempt` | Repartitioning multi-billion-row tables is a multi-week online migration with no clean rollback | Validate the chosen keys against 100× synthetic seed data **before M1**, not after |
| **R2** | **Marking-rule schema drift** | `marking_rule_set` is pinned by hash into historical attempts. If the executor's *interpretation* of the schema changes, re-scoring a 2027 attempt in 2030 yields a different result — silently violating REL-03 | Pin `rule_schema_version` alongside the hash; the executor must support **every historical schema version forever**; golden-set regression covers all live versions. **This is the subtlest risk in the design** |
| **R3** | **Tenancy retrofit** | Adding `organization_id` to `attempt` and `response_event` later is a rewrite of the largest tables | P7 — carry `tenant_id` from day one |
| **R4** | **Identifier choice** | Switching PK type at 10 B rows is not feasible | UUIDv7 decided now (P6); client-generated IDs make it non-negotiable |
| **R5** | **`content_body` JSONB evolution** | A schema change means backfilling up to 5 M documents | Versioned schema + lazy upgrade-on-read + background backfill; never a big-bang rewrite |
| **R6** | **Native enum types** | `ALTER TYPE` on enums is restrictive and lock-prone | Lookup tables or CHECK-constrained text for any set that will grow: `item_type`, `source_type`, defect and rejection categories. Native enums only for genuinely closed sets |
| **R7** | **Embedding model change** | Full regeneration of every vector; HNSW rebuild | `content_embedding` versioned by model; dual-write during transition; embeddings are designated recomputable (BAK-06) |
| **R8** | **Taxonomy migration defect** | A wrong concept mapping corrupts every historical mastery state and analytics series — often undetectably | Mandatory dry-run + exception list + reversibility (FR-QM-13); tags always retain `taxonomy_version_id` so history stays interpretable |
| **R9** | **Cross-schema FK creep** | A single accidental FK across contexts blocks later service extraction | Prohibited by policy; enforced by a CI check on migration files |
| **R10** | **Soft-delete + unique constraint collision** | Re-registering a soft-deleted email breaks the unique index | P2 restricts `deleted_at` to ~8 tables; all unique indexes there are partial |
| **R11** | **Data residency change** | Relocating billions of rows across regions is a project, not a migration | India-only assumed and recorded; revisiting requires a Phase 2 decision |
| **R12** | **Missing FKs on partitioned tables** | Postgres FK support across partitioned tables is limited; orphans accumulate silently | Application-level enforcement + weekly reconciliation job with alerting |
| **R13** | **Read-model divergence** | `published_item` drifting from `item_version` produces wrong content shown to students | Outbox-driven rebuild + nightly full-consistency check with alerting |
| **R14** | **Archive-boundary queries** | A query spanning the 18-month hot/cold boundary silently returns partial results | Federated query layer must fail loudly on boundary crossing, never return partial data |

---
