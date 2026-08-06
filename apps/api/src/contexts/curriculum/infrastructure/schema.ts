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
 * Drizzle mirror of `infra/migrations/*_curriculum_schema.sql`. The SQL file is
 * the source of truth for the database; this file is how the repositories talk
 * to it. Nothing outside `infrastructure/` may import it.
 */
export const curriculum = pgSchema('curriculum');

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
const uuidV7 = sql`curriculum.uuid_generate_v7()`;

export const taxonomyVersion = curriculum.table(
  'taxonomy_version',
  {
    taxonomyVersionId: uuid('taxonomy_version_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    examFamily: text('exam_family').notNull(),
    academicYear: text('academic_year').notNull(),
    state: text('state').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedByKind: text('published_by_kind'),
    publishedById: uuid('published_by_id'),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('taxonomy_version_tenant_family_year_idx').on(table.tenantId, table.examFamily, table.academicYear)],
);

export const conceptIdentity = curriculum.table(
  'concept_identity',
  {
    conceptIdentityId: uuid('concept_identity_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    canonicalName: text('canonical_name').notNull(),
    subjectDomain: text('subject_domain').notNull(),
    createdInVersion: uuid('created_in_version')
      .notNull()
      .references(() => taxonomyVersion.taxonomyVersionId),
    supersededBy: uuid('superseded_by'),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('concept_identity_created_in_version_idx').on(table.createdInVersion)],
);

export const conceptNode = curriculum.table(
  'concept_node',
  {
    conceptNodeId: uuid('concept_node_id').primaryKey().default(uuidV7),
    taxonomyVersionId: uuid('taxonomy_version_id')
      .notNull()
      .references(() => taxonomyVersion.taxonomyVersionId, { onDelete: 'cascade' }),
    conceptIdentityId: uuid('concept_identity_id')
      .notNull()
      .references(() => conceptIdentity.conceptIdentityId),
    parentNodeId: uuid('parent_node_id'),
    displayName: text('display_name').notNull(),
    examWeight: numeric('exam_weight', { precision: 6, scale: 5 }).notNull(),
    depth: integer('depth').notNull(),
    estimatedTeachingHours: numeric('estimated_teaching_hours', { precision: 7, scale: 2 }).notNull(),
  },
  (table) => [
    unique('concept_node_identity_unique_per_version').on(table.taxonomyVersionId, table.conceptIdentityId),
    index('concept_node_parent_idx').on(table.parentNodeId),
    index('concept_node_version_idx').on(table.taxonomyVersionId),
  ],
);

export const prerequisiteEdge = curriculum.table(
  'prerequisite_edge',
  {
    taxonomyVersionId: uuid('taxonomy_version_id')
      .notNull()
      .references(() => taxonomyVersion.taxonomyVersionId, { onDelete: 'cascade' }),
    fromConceptIdentityId: uuid('from_concept_identity_id')
      .notNull()
      .references(() => conceptIdentity.conceptIdentityId),
    toConceptIdentityId: uuid('to_concept_identity_id')
      .notNull()
      .references(() => conceptIdentity.conceptIdentityId),
    strength: numeric('strength', { precision: 4, scale: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taxonomyVersionId, table.fromConceptIdentityId, table.toConceptIdentityId] }),
  ],
);

export const exam = curriculum.table(
  'exam',
  {
    examId: uuid('exam_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    code: text('code').notNull(),
    displayName: text('display_name').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    conductingBody: text('conducting_body').notNull(),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('exam_code_unique_per_tenant').on(table.tenantId, table.code)],
);

export const examProfileVersion = curriculum.table(
  'exam_profile_version',
  {
    profileVersionId: uuid('profile_version_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exam.examId),
    academicYear: text('academic_year').notNull(),
    state: text('state').notNull().default('draft'),
    taxonomyVersionId: uuid('taxonomy_version_id')
      .notNull()
      .references(() => taxonomyVersion.taxonomyVersionId),
    totalMarks: numeric('total_marks', { precision: 8, scale: 2 }).notNull(),
    timingPolicy: jsonb('timing_policy').notNull(),
    timingPolicySchemaVersion: integer('timing_policy_schema_version').notNull().default(1),
    navigationPolicy: jsonb('navigation_policy').notNull(),
    navigationPolicySchemaVersion: integer('navigation_policy_schema_version').notNull().default(1),
    markingRuleSet: jsonb('marking_rule_set').notNull(),
    markingRuleSetSchemaVersion: integer('marking_rule_set_schema_version').notNull().default(1),
    markingRuleSetHash: text('marking_rule_set_hash'),
    toleranceDefaults: jsonb('tolerance_defaults'),
    toleranceDefaultsSchemaVersion: integer('tolerance_defaults_schema_version').notNull().default(1),
    itemTypeAllowances: jsonb('item_type_allowances').notNull(),
    itemTypeAllowancesSchemaVersion: integer('item_type_allowances_schema_version').notNull().default(1),
    goldenSetValidation: jsonb('golden_set_validation').notNull(),
    goldenSetValidationSchemaVersion: integer('golden_set_validation_schema_version').notNull().default(1),
    isActive: boolean('is_active').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedByKind: text('published_by_kind'),
    publishedById: uuid('published_by_id'),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('exam_profile_version_one_active_per_year_idx')
      .on(table.examId, table.academicYear)
      .where(sql`is_active`),
    index('exam_profile_version_exam_idx').on(table.examId),
    index('exam_profile_version_taxonomy_idx').on(table.taxonomyVersionId),
  ],
);

export const examSectionSpec = curriculum.table(
  'exam_section_spec',
  {
    sectionSpecId: uuid('section_spec_id').primaryKey().default(uuidV7),
    profileVersionId: uuid('profile_version_id')
      .notNull()
      .references(() => examProfileVersion.profileVersionId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    itemCount: integer('item_count').notNull(),
    itemTypeMix: jsonb('item_type_mix').notNull(),
    itemTypeMixSchemaVersion: integer('item_type_mix_schema_version').notNull().default(1),
    maxMarks: numeric('max_marks', { precision: 8, scale: 2 }).notNull(),
    sectionTimingMinutes: integer('section_timing_minutes'),
  },
  (table) => [unique('exam_section_spec_ordinal_unique_per_profile').on(table.profileVersionId, table.ordinal)],
);

export const taxonomyMigration = curriculum.table(
  'taxonomy_migration',
  {
    migrationId: uuid('migration_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    fromVersion: uuid('from_version')
      .notNull()
      .references(() => taxonomyVersion.taxonomyVersionId),
    toVersion: uuid('to_version')
      .notNull()
      .references(() => taxonomyVersion.taxonomyVersionId),
    state: text('state').notNull().default('draft'),
    dryRunResult: jsonb('dry_run_result'),
    dryRunResultSchemaVersion: integer('dry_run_result_schema_version').notNull().default(1),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('taxonomy_migration_from_idx').on(table.fromVersion),
    index('taxonomy_migration_to_idx').on(table.toVersion),
  ],
);

export const taxonomyMapping = curriculum.table(
  'taxonomy_mapping',
  {
    mappingId: uuid('mapping_id').primaryKey().default(uuidV7),
    migrationId: uuid('migration_id')
      .notNull()
      .references(() => taxonomyMigration.migrationId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').notNull(),
    fromIds: uuid('from_ids').array().notNull(),
    toIds: uuid('to_ids').array().notNull(),
    disposition: text('disposition').notNull().default('pending'),
  },
  (table) => [
    unique('taxonomy_mapping_ordinal_unique_per_migration').on(table.migrationId, table.ordinal),
    index('taxonomy_mapping_migration_idx').on(table.migrationId),
  ],
);

export const curriculumSchema = {
  taxonomyVersion,
  conceptIdentity,
  conceptNode,
  prerequisiteEdge,
  exam,
  examProfileVersion,
  examSectionSpec,
  taxonomyMigration,
  taxonomyMapping,
};
