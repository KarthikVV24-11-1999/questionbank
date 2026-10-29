# Analytics Event Taxonomy
**Version:** 1.0 · **Date:** 2026-08-05 · **Status:** Specification
**Closes:** PRD §15 **M2** · **Implements:** FR-ANA-10, OBS-12 · **Capture:** specified for M0, begins at M7; events before M7 are not recoverable

> Events not captured are permanently lost.

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
| Event | Key payload | Owner |
|---|---|---|
| `account.registered` | `signup_method`, `referral_source`, `age_band` | M8 |
| `account.verified` | `channel`, `attempts_taken`, `seconds_to_verify` | M8 |
| `onboarding.step_completed` | `step`, `seconds_on_step` | M8 |
| `onboarding.abandoned` | `last_step`, `seconds_elapsed` | M8 |
| `onboarding.scope_declared` | `concept_count`, `coverage_fraction` | M8 |

### Diagnostic & Learning Loop *(the product's core funnel)*
| Event | Key payload | Owner |
|---|---|---|
| `diagnostic.started` / `diagnostic.completed` | `item_count`, `duration_ms`, `concepts_assessed` | M8 |
| `diagnostic.abandoned` | `items_answered`, `abandon_index` | M8 |
| `concept_map.viewed` | `weak_count`, `strong_count`, `drill_down` | M8 |
| `practice.session_started` | `selection_strategy`, `source` (recommendation \| self \| remediation), `concept_ids`, `item_count` | M7 |
| `practice.item_answered` | `outcome`, `time_on_item_ms`, `answer_changes`, `difficulty_band`, `was_flagged` | M7 |
| `practice.session_completed` / `_abandoned` | `items_attempted`, `accuracy`, `duration_ms` | M7 |
| `solution.viewed` | `depth` (basic \| stepwise \| distractor \| alternate), `seconds_before_view`, `was_gated` | M7 |
| `remediation.set_generated` | `trigger`, `concept_ids`, `item_count` | M7 |
| `remediation.set_completed` | `accuracy_delta_vs_baseline` | M7 |
| **`mastery.gain_verified`** | `concept_identity_id`, `days_to_verify`, `evidence_count` — **the north-star event** | M7 |
| `mastery.regressed` | `concept_identity_id`, `days_since_gain` | M7 |
| `review.due_completed` / `review.due_skipped` | `interval_days`, `lapse_count` | M7 |
| `error_notebook.entry_reviewed` | `error_cause`, `days_since_error` | M7 |

### Mock Examination
| Event | Key payload | Owner |
|---|---|---|
| `mock.catalog_viewed` | `available_count`, `gated_count` | M9 |
| `mock.package_download_started` / `_completed` / `_failed` | `bytes`, `duration_ms`, `network_class`, `failure_reason` | M6 |
| `mock.attempt_started` | `form_id`, `profile_version_id`, `is_offline` | M6 |
| `mock.item_visited` | `slot_ordinal`, `visit_index` | M6 |
| `mock.item_answered` | `outcome_unknown_at_time`, `time_on_item_ms`, `answer_changes` | M6 |
| `mock.item_flagged` / `_unflagged` | `slot_ordinal` | M6 |
| `mock.section_entered` | `section_ordinal`, `elapsed_ms` | M6 |
| `mock.connectivity_lost` / `_restored` | `offline_duration_ms`, `events_buffered` | M6 |
| `mock.attempt_submitted` | `submission_mode` (manual \| auto_expiry \| recovered), `answered`, `unanswered`, `flagged`, `sync_lag_ms` | M6 |
| `mock.attempt_interrupted` / `_recovered` | `interruption_type`, `device_changed` | M6 |
| `mock.result_viewed` | `seconds_after_publication` | M6 |
| `mock.diagnostic_viewed` | `findings_shown`, `deepest_drill_level` | M7 |
| `mock.remediation_clicked` | `finding_rank`, `hours_after_result` — **measures FR-ANA-02's actual value** | M7 |

### Content Pipeline *(server-side)*
| Event | Key payload | Owner |
|---|---|---|
| `item.drafted` | `author_kind` (human \| ai), `item_type`, `concept_id` | M3 |
| `item.submitted_for_review` | `authoring_duration_ms`, `validation_warnings` | M3 |
| `item.review_decided` | `decision`, `reason_category`, `queue_wait_ms`, `review_duration_ms` | M4 |
| `item.published` / `item.retired` / `item.suspended` | `source_type`, `reason` | M3 |
| `item.defect_reported` / `item.defect_resolved` | `category`, `severity`, `resolution_hours` | none |
| `solution.published` | `has_distractor_analysis`, `step_count` | M3 |
| `taxonomy.version_published` / `taxonomy.migration_executed` | `concepts_changed`, `exceptions_resolved` | M1 |

### AI
| Event | Key payload | Owner |
|---|---|---|
| `ai.generation_run_started` / `_completed` | `model_version_id`, `prompt_version_id`, `requested`, `produced`, `cost_units` | M5 |
| `ai.precheck_evaluated` | `check`, `passed`, `rejection_reason` | M5 |
| `ai.candidate_dispositioned` | `disposition`, `reviewer_decision`, `confidence` | M5 |
| `ai.budget_threshold_crossed` | `scope`, `threshold`, `action_taken` | M5 |
| `ai.degraded` | `reason`, `feature`, `duration_ms` | M5 |
| `ai.tutor_turn` *(H1)* | `grounded`, `citation_count`, `escalated`, `latency_first_token_ms` | none |

### Commerce
| Event | Key payload | Owner |
|---|---|---|
| `paywall.shown` | `gated_feature`, `trigger_context`, `quota_state` | M9 |
| `paywall.dismissed` / `plan.selected` | `plan_version_id`, `seconds_on_screen` | M9 |
| `checkout.started` / `_completed` / `_failed` | `payment_method`, `failure_reason`, `attempt_number` | M9 |
| `subscription.renewed` / `_cancelled` / `_expired` / `_grace_entered` | `cancellation_reason`, `days_active` | M9 |
| `quota.exhausted` | `quota_key`, `days_into_period` | M9 |

### Engagement, Trust, Platform
| Event | Key payload | Owner |
|---|---|---|
| `notification.sent` / `_opened` / `_suppressed` | `category`, `channel`, `suppression_reason` | M8 |
| `search.executed` | `mode` (structured \| fulltext \| semantic), `filter_count`, `result_count`, `latency_ms` | M8 |
| `search.result_selected` | `rank`, `mode` | M8 |
| `moderation.report_filed` / `moderation.action_taken` | `category`, `severity`, `action` | M9 |
| `client.error` | `error_class`, `surface`, `is_fatal` | none |
| `client.sync_failed` | `retry_count`, `events_pending`, `failure_class` | M6 |
| `performance.render_measured` | `metric`, `value_ms`, `device_class` | none |
| `accessibility.assistive_tech_detected` | `at_class` — informs ACC-12, no personal data | none |

The Owner column names the milestone whose surface can know the fact, from the roadmap's deliverables; `none` marks an event no milestone's deliverables produce. Which owned events are emitted, and the measured conformance, are in [EVENT-CONFORMANCE.md](EVENT-CONFORMANCE.md).

**Total: 79 event names, written on 68 rows.** Additions require a taxonomy version bump and a registry entry; the ingestion edge rejects unregistered names.

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
