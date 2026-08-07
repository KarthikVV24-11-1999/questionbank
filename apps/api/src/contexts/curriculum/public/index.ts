/**
 * The curriculum context's only public surface. It exports exactly three
 * categories — commands, queries, events — and no aggregate, entity,
 * repository or infrastructure type (ENGINEERING-HANDBOOK §1, §9 rule 1).
 *
 * Value objects consumers need are re-exported as read-only DTO shapes, never
 * as the domain classes.
 */

// ── Commands ────────────────────────────────────────────────────────────────
export type {
  AddConceptNode,
  AddPrerequisiteEdge,
  CreateTaxonomyDraft,
  MoveConceptNode,
  PublishTaxonomyVersion,
  RemoveConceptNode,
} from '../application/commands/taxonomy-commands.js';

export type {
  CreateExam,
  CreateProfileDraft,
  PublishProfileVersion,
  SupersedeProfileVersion,
  UpdateProfileDraft,
} from '../application/commands/exam-profile-commands.js';

export type {
  AddMapping,
  CreateMigration,
  ExecuteMigration,
  RunDryRun,
} from '../application/commands/migration-commands.js';

// ── Queries ─────────────────────────────────────────────────────────────────
export type {
  ConceptNodeView,
  ConceptPrerequisiteView,
  ConceptSubtreeView,
  ExamProfileVersionView,
  ExamView,
  GetConceptPrerequisites,
  GetConceptSubtree,
  GetExamProfileVersion,
  GetMigrationDryRun,
  GetTaxonomyVersion,
  ListExams,
  ListTaxonomyVersions,
  SectionSpecView,
  TaxonomyVersionDetailView,
  TaxonomyVersionView,
} from '../application/queries/curriculum-queries.js';

// ── Events ──────────────────────────────────────────────────────────────────
export type {
  CurriculumEvent,
  CurriculumEventType,
  ExamProfileVersionPublished,
  ExamProfileVersionPublishedPayload,
  TaxonomyMigrationExecuted,
  TaxonomyMigrationExecutedPayload,
  TaxonomyVersionPublished,
  TaxonomyVersionPublishedPayload,
} from '../domain/events/curriculum-events.js';

export { CURRICULUM_EVENT_TYPES } from '../domain/events/curriculum-events.js';

// ── Value objects consumers need, as read-only data ─────────────────────────

/** The marking rule set as data (D6). Consumers read it; only Curriculum owns it. */
export type { MarkingRuleSetData, MarkingRuleData } from '../domain/value-objects/marking-rule-set.js';
export type { Condition, ConditionKind } from '../domain/value-objects/condition.js';
export type { Award, AwardKind } from '../domain/value-objects/award.js';

/** How outcomes become sectional and total scores (ADR-0006). Owned here, executed by Scoring. */
export type {
  AggregationSpecData,
  BestOfSpec,
  RoundingSpec,
  RoundingMode,
  SectionAggregation,
  TotalAggregation,
} from '../domain/value-objects/aggregation-spec.js';

/** The answer specification as data (D-001). */
export type {
  AnswerForm,
  ComparisonMode,
  CreateNumericAnswerSpecProps as NumericAnswerSpecData,
  NormalizationFlags,
  UnitSpec,
} from '../domain/value-objects/numeric-answer-spec.js';

export type { MigrationDryRunResult, MigrationException } from '../domain/migration-dry-run.js';
