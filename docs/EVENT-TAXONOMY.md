# Analytics Event Taxonomy
**Version:** 1.0 · **Date:** 2026-08-05 · **Status:** Specification
**Closes:** PRD §15 **M2** · **Implements:** FR-ANA-10, OBS-12 · **Release:** M0 — capture begins before any user-facing feature

> Events not captured are permanently lost. This taxonomy ships before the first student account exists.

---

## 1. Envelope

Every event, without exception, carries this envelope. Payload fields are additive per event type.

| Field | Notes |
|---|---|
| `event_id` | UUIDv7, client- or server-generated; the deduplication key |
| `event_name` | From §3. Ad-hoc names are rejected at the ingestion edge |
| `event_version` | Integer. Bumped on any breaking payload change |
| `occurred_at` | Event time (client clock, offset-corrected) |
| `received_at` | Ingestion time — the two differ by hours for offline events |
| `actor` | `{ kind: human \| ai_agent \| system, pseudonymous_id }` — **never a name, email, or phone** |
| `session_id` | Pseudonymous, rotating |
| `surface` | `web \| pwa \| android \| ios \| server \| worker` |
| `app_version`, `device_class`, `network_class` | `low \| mid \| high`; `offline \| 2g \| 3g \| 4g \| wifi` |
| `tenant_id` | Platform tenant by default (P7) |
| `context` | `{ exam_id?, attempt_id?, item_version_id?, concept_identity_id?, form_id? }` |

**Rules**
1. **No PII in any field, ever** (PRI-08, F10). Pseudonymous IDs only; the mapping lives in one erasable place.
2. Written to object storage as date-partitioned Parquet. **Never to the OLTP database.**
3. Schema-validated at the ingestion edge; violations are quarantined and alerted, never silently dropped.
4. Events from minors are excluded from any non-educational profiling at query time by an enforced filter (INV-10).
5. Offline events buffer locally and upload with the response log; `occurred_at` is authoritative for analysis.

---

## 2. Naming Convention

`<domain>.<object>_<past_tense_verb>` — e.g. `attempt.mock_submitted`. Past tense only: events are facts, not intentions.

---

## 3. Catalog

### Acquisition & Onboarding
| Event | Key payload |
|---|---|
| `account.registered` | `signup_method`, `referral_source`, `age_band` |
| `account.verified` | `channel`, `attempts_taken`, `seconds_to_verify` |
| `onboarding.step_completed` | `step`, `seconds_on_step` |
| `onboarding.abandoned` | `last_step`, `seconds_elapsed` |
| `onboarding.scope_declared` | `concept_count`, `coverage_fraction` |

### Diagnostic & Learning Loop *(the product's core funnel)*
| Event | Key payload |
|---|---|
| `diagnostic.started` / `diagnostic.completed` | `item_count`, `duration_ms`, `concepts_assessed` |
| `diagnostic.abandoned` | `items_answered`, `abandon_index` |
| `concept_map.viewed` | `weak_count`, `strong_count`, `drill_down` |
| `practice.session_started` | `selection_strategy`, `source` (recommendation \| self \| remediation), `concept_ids`, `item_count` |
| `practice.item_answered` | `outcome`, `time_on_item_ms`, `answer_changes`, `difficulty_band`, `was_flagged` |
| `practice.session_completed` / `_abandoned` | `items_attempted`, `accuracy`, `duration_ms` |
| `solution.viewed` | `depth` (basic \| stepwise \| distractor \| alternate), `seconds_before_view`, `was_gated` |
| `remediation.set_generated` | `trigger`, `concept_ids`, `item_count` |
| `remediation.set_completed` | `accuracy_delta_vs_baseline` |
| **`mastery.gain_verified`** | `concept_identity_id`, `days_to_verify`, `evidence_count` — **the north-star event** |
| `mastery.regressed` | `concept_identity_id`, `days_since_gain` |
| `review.due_completed` / `review.due_skipped` | `interval_days`, `lapse_count` |
| `error_notebook.entry_reviewed` | `error_cause`, `days_since_error` |

### Mock Examination
| Event | Key payload |
|---|---|
| `mock.catalog_viewed` | `available_count`, `gated_count` |
| `mock.package_download_started` / `_completed` / `_failed` | `bytes`, `duration_ms`, `network_class`, `failure_reason` |
| `mock.attempt_started` | `form_id`, `profile_version_id`, `is_offline` |
| `mock.item_visited` | `slot_ordinal`, `visit_index` |
| `mock.item_answered` | `outcome_unknown_at_time`, `time_on_item_ms`, `answer_changes` |
| `mock.item_flagged` / `_unflagged` | `slot_ordinal` |
| `mock.section_entered` | `section_ordinal`, `elapsed_ms` |
| `mock.connectivity_lost` / `_restored` | `offline_duration_ms`, `events_buffered` |
| `mock.attempt_submitted` | `submission_mode` (manual \| auto_expiry \| recovered), `answered`, `unanswered`, `flagged`, `sync_lag_ms` |
| `mock.attempt_interrupted` / `_recovered` | `interruption_type`, `device_changed` |
| `mock.result_viewed` | `seconds_after_publication` |
| `mock.diagnostic_viewed` | `findings_shown`, `deepest_drill_level` |
| `mock.remediation_clicked` | `finding_rank`, `hours_after_result` — **measures FR-ANA-02's actual value** |

### Content Pipeline *(server-side)*
| Event | Key payload |
|---|---|
| `item.drafted` | `author_kind` (human \| ai), `item_type`, `concept_id` |
| `item.submitted_for_review` | `authoring_duration_ms`, `validation_warnings` |
| `item.review_decided` | `decision`, `reason_category`, `queue_wait_ms`, `review_duration_ms` |
| `item.published` / `item.retired` / `item.suspended` | `source_type`, `reason` |
| `item.defect_reported` / `item.defect_resolved` | `category`, `severity`, `resolution_hours` |
| `solution.published` | `has_distractor_analysis`, `step_count` |
| `taxonomy.version_published` / `taxonomy.migration_executed` | `concepts_changed`, `exceptions_resolved` |

### AI
| Event | Key payload |
|---|---|
| `ai.generation_run_started` / `_completed` | `model_version_id`, `prompt_version_id`, `requested`, `produced`, `cost_units` |
| `ai.precheck_evaluated` | `check`, `passed`, `rejection_reason` |
| `ai.candidate_dispositioned` | `disposition`, `reviewer_decision`, `confidence` |
| `ai.budget_threshold_crossed` | `scope`, `threshold`, `action_taken` |
| `ai.degraded` | `reason`, `feature`, `duration_ms` |
| `ai.tutor_turn` *(H1)* | `grounded`, `citation_count`, `escalated`, `latency_first_token_ms` |

### Commerce
| Event | Key payload |
|---|---|
| `paywall.shown` | `gated_feature`, `trigger_context`, `quota_state` |
| `paywall.dismissed` / `plan.selected` | `plan_version_id`, `seconds_on_screen` |
| `checkout.started` / `_completed` / `_failed` | `payment_method`, `failure_reason`, `attempt_number` |
| `subscription.renewed` / `_cancelled` / `_expired` / `_grace_entered` | `cancellation_reason`, `days_active` |
| `quota.exhausted` | `quota_key`, `days_into_period` |

### Engagement, Trust, Platform
| Event | Key payload |
|---|---|
| `notification.sent` / `_opened` / `_suppressed` | `category`, `channel`, `suppression_reason` |
| `search.executed` | `mode` (structured \| fulltext \| semantic), `filter_count`, `result_count`, `latency_ms` |
| `search.result_selected` | `rank`, `mode` |
| `moderation.report_filed` / `moderation.action_taken` | `category`, `severity`, `action` |
| `client.error` | `error_class`, `surface`, `is_fatal` |
| `client.sync_failed` | `retry_count`, `events_pending`, `failure_class` |
| `performance.render_measured` | `metric`, `value_ms`, `device_class` |
| `accessibility.assistive_tech_detected` | `at_class` — informs ACC-12, no personal data |

**Total: 68 event types.** Additions require a taxonomy version bump and a registry entry; the ingestion edge rejects unregistered names.

---

## 4. Derived Metrics → Source Events

Proof the taxonomy actually serves PRD §7.

| Metric | Source |
|---|---|
| Weekly Verified Mastery Gains *(north star)* | `mastery.gain_verified` |
| Accuracy delta on remediated concepts | `remediation.set_completed` |
| Diagnosis → practice within 48h | `mock.remediation_clicked` vs `mock.result_viewed` |
| Mock completion rate | `mock.attempt_started` vs `mock.attempt_submitted` |
| Free → paid conversion | `paywall.shown` → `checkout.completed` |
| AI first-pass acceptance | `ai.candidate_dispositioned` |
| Median author time per item | `item.drafted` → `item.submitted_for_review` |
| Reviewer queue depth & ageing | `item.review_decided.queue_wait_ms` |
| Zero response loss verification | `client.sync_failed` + `mock.connectivity_lost` reconciliation |
| Cost per published item | `ai.generation_run_completed.cost_units` ÷ published count |

---
