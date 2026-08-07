import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of `infra/migrations/*_scoring_schema.sql`. The SQL file is
 * the source of truth for the database; this file is how the repositories talk
 * to it. Nothing outside `infrastructure/` may import it.
 *
 * No column here references `curriculum` (§9 rule 3). `examProfileVersionId`
 * and `markingRuleSetHash` are values, because a score is pinned to what those
 * were when it was computed and must not follow them if they change.
 */
export const scoring = pgSchema('scoring');

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
const uuidV7 = sql`scoring.uuid_generate_v7()`;

/** Marks are stored as exact decimals, never as a float. */
const marks = (name: string) => numeric(name, { precision: 14, scale: 4 });

export const scoreRecord = scoring.table(
  'score_record',
  {
    scoreRecordId: uuid('score_record_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    attemptId: uuid('attempt_id').notNull(),
    examProfileVersionId: uuid('exam_profile_version_id').notNull(),
    markingRuleSetHash: text('marking_rule_set_hash').notNull(),
    ruleSchemaVersion: integer('rule_schema_version').notNull(),
    taxonomyVersionId: uuid('taxonomy_version_id').notNull(),
    generation: integer('generation').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    supersedesScoreRecordId: uuid('supersedes_score_record_id'),
    rescoringOperationId: uuid('rescoring_operation_id'),
    reasonForRescore: text('reason_for_rescore'),
    totalRaw: marks('total_raw').notNull(),
    totalMaxAvailable: marks('total_max_available').notNull(),
    totalAttemptedCount: integer('total_attempted_count').notNull(),
    totalCorrectCount: integer('total_correct_count').notNull(),
    totalIncorrectCount: integer('total_incorrect_count').notNull(),
    totalNegativeMarks: marks('total_negative_marks').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('score_record_one_current_per_attempt').on(table.attemptId).where(sql`is_current`),
    uniqueIndex('score_record_attempt_generation_key').on(table.attemptId, table.generation),
  ],
);

export const sectionScore = scoring.table(
  'section_score',
  {
    scoreRecordId: uuid('score_record_id').notNull(),
    sectionOrdinal: integer('section_ordinal').notNull(),
    raw: marks('raw').notNull(),
    maxAvailable: marks('max_available').notNull(),
    attemptedCount: integer('attempted_count').notNull(),
    correctCount: integer('correct_count').notNull(),
    incorrectCount: integer('incorrect_count').notNull(),
    negativeMarks: marks('negative_marks').notNull(),
  },
  (table) => [primaryKey({ columns: [table.scoreRecordId, table.sectionOrdinal] })],
);

export const itemOutcome = scoring.table(
  'item_outcome',
  {
    itemOutcomeId: uuid('item_outcome_id').primaryKey().default(uuidV7),
    scoreRecordId: uuid('score_record_id').notNull(),
    slotId: text('slot_id').notNull(),
    slotOrdinal: integer('slot_ordinal').notNull(),
    sectionOrdinal: integer('section_ordinal').notNull(),
    itemVersionId: uuid('item_version_id').notNull(),
    responseSnapshot: jsonb('response_snapshot'),
    responseSnapshotSchemaVersion: integer('response_snapshot_schema_version').notNull().default(1),
    correctness: text('correctness').notNull(),
    marksAwarded: marks('marks_awarded').notNull(),
    marksAvailable: marks('marks_available').notNull(),
    ruleAppliedId: text('rule_applied_id').notNull(),
    ruleAppliedExplanation: text('rule_applied_explanation').notNull(),
  },
  (table) => [
    unique('item_outcome_slot_unique').on(table.scoreRecordId, table.slotId),
    index('item_outcome_score_record_idx').on(table.scoreRecordId),
  ],
);

export const rescoringOperation = scoring.table(
  'rescoring_operation',
  {
    rescoringOperationId: uuid('rescoring_operation_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    trigger: text('trigger').notNull(),
    scope: text('scope').notNull(),
    scopeRef: text('scope_ref').notNull(),
    reason: text('reason').notNull(),
    state: text('state').notNull().default('drafted'),
    dryRunResult: jsonb('dry_run_result'),
    dryRunResultSchemaVersion: integer('dry_run_result_schema_version').notNull().default(1),
    authorizedByKind: text('authorized_by_kind'),
    authorizedById: uuid('authorized_by_id'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rescoring_operation_state_idx').on(table.tenantId, table.state)],
);
