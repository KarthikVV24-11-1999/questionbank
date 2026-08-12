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
 * Drizzle mirror of `infra/migrations/*_content_schema.sql`. The SQL file is
 * the source of truth for the database; this file is how the repositories talk
 * to it. Nothing outside `infrastructure/` may import it.
 */
export const content = pgSchema('content');

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
const uuidV7 = sql`content.uuid_generate_v7()`;

export const stimulus = content.table('stimulus', {
  stimulusId: uuid('stimulus_id').primaryKey().default(uuidV7),
  tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
  stimulusType: text('stimulus_type').notNull(),
  lifecycleState: text('lifecycle_state').notNull().default('draft'),
  currentPublishedVersionId: uuid('current_published_version_id'),
  retirementReason: text('retirement_reason'),
  aggregateVersion: integer('aggregate_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stimulusVersion = content.table(
  'stimulus_version',
  {
    stimulusVersionId: uuid('stimulus_version_id').primaryKey().default(uuidV7),
    stimulusId: uuid('stimulus_id')
      .notNull()
      .references(() => stimulus.stimulusId, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    body: jsonb('body').notNull(),
    bodySchemaVersion: integer('body_schema_version').notNull().default(1),
    bodyPlainText: text('body_plain_text').notNull(),
    notationTerms: text('notation_terms').array().notNull().default(sql`'{}'`),
    authoredByKind: text('authored_by_kind').notNull(),
    authoredById: uuid('authored_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once, at publication. What the immutability trigger keys on (INV-03). */
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    unique('stimulus_version_no_unique').on(table.stimulusId, table.versionNo),
    index('stimulus_version_stimulus_idx').on(table.stimulusId),
  ],
);

export const item = content.table(
  'item',
  {
    itemId: uuid('item_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    itemType: text('item_type').notNull(),
    lifecycleState: text('lifecycle_state').notNull().default('draft'),
    currentPublishedVersionId: uuid('current_published_version_id'),
    retirementReason: text('retirement_reason'),
    replacedByItemId: uuid('replaced_by_item_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('item_tenant_state_idx').on(table.tenantId, table.lifecycleState)],
);

export const itemVersion = content.table(
  'item_version',
  {
    itemVersionId: uuid('item_version_id').primaryKey().default(uuidV7),
    itemId: uuid('item_id')
      .notNull()
      .references(() => item.itemId, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    itemType: text('item_type').notNull(),
    stemBody: jsonb('stem_body').notNull(),
    stemBodySchemaVersion: integer('stem_body_schema_version').notNull().default(1),
    stemPlainText: text('stem_plain_text').notNull(),
    notationTerms: text('notation_terms').array().notNull().default(sql`'{}'`),
    difficultyEstimate: text('difficulty_estimate').notNull(),
    stimulusVersionId: uuid('stimulus_version_id').references(() => stimulusVersion.stimulusVersionId),
    authoredByKind: text('authored_by_kind').notNull(),
    authoredById: uuid('authored_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once, at publication. What the immutability trigger keys on (INV-03). */
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    unique('item_version_no_unique').on(table.itemId, table.versionNo),
    index('item_version_item_idx').on(table.itemId),
    index('item_version_stimulus_idx').on(table.stimulusVersionId),
  ],
);

export const itemOption = content.table(
  'item_option',
  {
    itemVersionId: uuid('item_version_id')
      .notNull()
      .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
    optionId: text('option_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    body: jsonb('body').notNull(),
    bodySchemaVersion: integer('body_schema_version').notNull().default(1),
    bodyPlainText: text('body_plain_text').notNull(),
    /** Key material. Read by the authoring queries and nothing else (ADR-0009). */
    isCorrect: boolean('is_correct').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.itemVersionId, table.optionId] }),
    unique('item_option_ordinal_unique').on(table.itemVersionId, table.ordinal),
  ],
);

export const itemMatchingMember = content.table(
  'item_matching_member',
  {
    itemVersionId: uuid('item_version_id')
      .notNull()
      .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
    side: text('side').notNull(),
    memberId: text('member_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    body: jsonb('body').notNull(),
    bodySchemaVersion: integer('body_schema_version').notNull().default(1),
    bodyPlainText: text('body_plain_text').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemVersionId, table.side, table.memberId] }),
    unique('item_matching_member_ordinal_unique').on(table.itemVersionId, table.side, table.ordinal),
  ],
);

export const itemMatchingPair = content.table(
  'item_matching_pair',
  {
    itemVersionId: uuid('item_version_id')
      .notNull()
      .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
    leftMemberId: text('left_member_id').notNull(),
    rightMemberId: text('right_member_id').notNull(),
    leftSide: text('left_side').notNull().default('left'),
    rightSide: text('right_side').notNull().default('right'),
  },
  (table) => [primaryKey({ columns: [table.itemVersionId, table.leftMemberId] })],
);

export const itemNumericSpec = content.table('item_numeric_spec', {
  itemVersionId: uuid('item_version_id')
    .primaryKey()
    .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
  /** The authored decimal literal, as text — never numeric (ADR-0007). */
  expectedValue: text('expected_value').notNull(),
  comparisonMode: text('comparison_mode').notNull(),
  toleranceValue: text('tolerance_value'),
  significantFigures: integer('significant_figures'),
  rangeMin: text('range_min'),
  rangeMax: text('range_max'),
  unitCanonical: text('unit_canonical'),
  unitAcceptedEquivalents: text('unit_accepted_equivalents').array().notNull().default(sql`'{}'`),
  unitRequired: boolean('unit_required').notNull().default(false),
  acceptedForms: text('accepted_forms').array().notNull(),
});

export const itemTaxonomyTag = content.table(
  'item_taxonomy_tag',
  {
    itemVersionId: uuid('item_version_id')
      .notNull()
      .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
    conceptIdentityId: uuid('concept_identity_id').notNull(),
    taxonomyVersionId: uuid('taxonomy_version_id').notNull(),
    weight: numeric('weight', { precision: 4, scale: 3 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.itemVersionId, table.conceptIdentityId] }),
    uniqueIndex('item_taxonomy_tag_one_primary').on(table.itemVersionId).where(sql`is_primary`),
    index('item_taxonomy_tag_concept_idx').on(table.conceptIdentityId, table.taxonomyVersionId),
  ],
);

export const itemProvenance = content.table('item_provenance', {
  itemVersionId: uuid('item_version_id')
    .primaryKey()
    .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  sourceExam: text('source_exam'),
  sourceYear: integer('source_year'),
  sourceSession: text('source_session'),
  authorRef: text('author_ref'),
  modelVersionId: uuid('model_version_id'),
  promptVersionId: uuid('prompt_version_id'),
  generationRunId: uuid('generation_run_id'),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  importBatchId: uuid('import_batch_id'),
});

export const solution = content.table(
  'solution',
  {
    solutionId: uuid('solution_id').primaryKey().default(uuidV7),
    tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
    itemId: uuid('item_id')
      .notNull()
      .references(() => item.itemId, { onDelete: 'cascade' }),
    targetItemVersionId: uuid('target_item_version_id')
      .notNull()
      .references(() => itemVersion.itemVersionId),
    lifecycleState: text('lifecycle_state').notNull().default('draft'),
    currentPublishedVersionId: uuid('current_published_version_id'),
    aggregateVersion: integer('aggregate_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('solution_item_idx').on(table.itemId),
    index('solution_target_version_idx').on(table.targetItemVersionId),
  ],
);

export const solutionVersion = content.table(
  'solution_version',
  {
    solutionVersionId: uuid('solution_version_id').primaryKey().default(uuidV7),
    solutionId: uuid('solution_id')
      .notNull()
      .references(() => solution.solutionId, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    finalAnswerKind: text('final_answer_kind').notNull(),
    finalAnswer: jsonb('final_answer').notNull(),
    finalAnswerSchemaVersion: integer('final_answer_schema_version').notNull().default(1),
    authoredByKind: text('authored_by_kind').notNull(),
    authoredById: uuid('authored_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once, at publication. What the immutability trigger keys on (INV-03). */
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    unique('solution_version_no_unique').on(table.solutionId, table.versionNo),
    index('solution_version_solution_idx').on(table.solutionId),
  ],
);

export const solutionStep = content.table(
  'solution_step',
  {
    solutionVersionId: uuid('solution_version_id')
      .notNull()
      .references(() => solutionVersion.solutionVersionId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    body: jsonb('body').notNull(),
    bodySchemaVersion: integer('body_schema_version').notNull().default(1),
    bodyPlainText: text('body_plain_text').notNull(),
    conceptRefs: uuid('concept_refs').array().notNull().default(sql`'{}'`),
  },
  (table) => [primaryKey({ columns: [table.solutionVersionId, table.ordinal] })],
);

export const distractorAnalysis = content.table(
  'distractor_analysis',
  {
    solutionVersionId: uuid('solution_version_id')
      .notNull()
      .references(() => solutionVersion.solutionVersionId, { onDelete: 'cascade' }),
    optionId: text('option_id').notNull(),
    misconceptionBody: jsonb('misconception_body').notNull(),
    misconceptionBodySchemaVersion: integer('misconception_body_schema_version').notNull().default(1),
    misconceptionPlainText: text('misconception_plain_text').notNull(),
  },
  (table) => [primaryKey({ columns: [table.solutionVersionId, table.optionId] })],
);

export const alternateApproach = content.table(
  'alternate_approach',
  {
    solutionVersionId: uuid('solution_version_id')
      .notNull()
      .references(() => solutionVersion.solutionVersionId, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    steps: jsonb('steps').notNull(),
    stepsSchemaVersion: integer('steps_schema_version').notNull().default(1),
    applicabilityNote: text('applicability_note'),
  },
  (table) => [primaryKey({ columns: [table.solutionVersionId, table.label] })],
);

export const mediaAsset = content.table('media_asset', {
  assetId: uuid('asset_id').primaryKey().default(uuidV7),
  tenantId: uuid('tenant_id').notNull().default(PLATFORM_TENANT),
  assetType: text('asset_type').notNull(),
  lifecycleState: text('lifecycle_state').notNull().default('draft'),
  currentPublishedVersionId: uuid('current_published_version_id'),
  retirementReason: text('retirement_reason'),
  aggregateVersion: integer('aggregate_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mediaAssetVersion = content.table(
  'media_asset_version',
  {
    assetVersionId: uuid('asset_version_id').primaryKey().default(uuidV7),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => mediaAsset.assetId, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    /** Where the bytes live. The bytes are never here (DEC-6). */
    storageKey: text('storage_key').notNull(),
    checksum: text('checksum').notNull(),
    mimeType: text('mime_type').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** ACC-03 at the database as well as in the type. */
    altText: text('alt_text').notNull(),
    longDescription: text('long_description'),
    authoredByKind: text('authored_by_kind').notNull(),
    authoredById: uuid('authored_by_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set once, at publication. What the immutability trigger keys on (INV-03). */
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    unique('media_asset_version_no_unique').on(table.assetId, table.versionNo),
    index('media_asset_version_asset_idx').on(table.assetId),
  ],
);

export const contentMediaRef = content.table(
  'content_media_ref',
  {
    ownerType: text('owner_type').notNull(),
    ownerVersionId: uuid('owner_version_id').notNull(),
    mediaAssetVersionId: uuid('media_asset_version_id')
      .notNull()
      .references(() => mediaAssetVersion.assetVersionId),
  },
  (table) => [
    primaryKey({ columns: [table.ownerType, table.ownerVersionId, table.mediaAssetVersionId] }),
    index('content_media_ref_asset_idx').on(table.mediaAssetVersionId),
  ],
);

/** Modeled for H1 (FR-QM-11). Nothing writes it this milestone. */
export const itemVersionLocale = content.table(
  'item_version_locale',
  {
    itemVersionId: uuid('item_version_id')
      .notNull()
      .references(() => itemVersion.itemVersionId, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    stemBody: jsonb('stem_body').notNull(),
    stemBodySchemaVersion: integer('stem_body_schema_version').notNull().default(1),
    stemPlainText: text('stem_plain_text').notNull(),
    options: jsonb('options').notNull().default(sql`'[]'::jsonb`),
    optionsSchemaVersion: integer('options_schema_version').notNull().default(1),
    translatedByKind: text('translated_by_kind').notNull(),
    translatedById: uuid('translated_by_id').notNull(),
    reviewState: text('review_state').notNull().default('draft'),
    attestedById: uuid('attested_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.itemVersionId, table.locale] })],
);

export const contentSchema = {
  stimulus,
  stimulusVersion,
  item,
  itemVersion,
  itemOption,
  itemMatchingMember,
  itemMatchingPair,
  itemNumericSpec,
  itemTaxonomyTag,
  itemProvenance,
  solution,
  solutionVersion,
  solutionStep,
  distractorAnalysis,
  alternateApproach,
  mediaAsset,
  mediaAssetVersion,
  contentMediaRef,
  itemVersionLocale,
};
