import type { PrincipalRef } from '@questionbank/domain-types';

/**
 * Facts published for downstream contexts (EVENT-TAXONOMY). Payloads carry
 * identifiers only — never a full aggregate — so a consumer must read the
 * owning context rather than trust a copy.
 */
export const CURRICULUM_EVENT_TYPES = [
  'TaxonomyVersionPublished',
  'ExamProfileVersionPublished',
  'TaxonomyMigrationExecuted',
] as const;

export type CurriculumEventType = (typeof CURRICULUM_EVENT_TYPES)[number];

export interface DomainEvent<TType extends string, TPayload> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly principal: PrincipalRef;
  readonly correlationId: string;
  readonly payload: TPayload;
}

export interface TaxonomyVersionPublishedPayload {
  readonly taxonomyVersionId: string;
  readonly examFamily: string;
  readonly academicYear: string;
  readonly conceptCount: number;
}

export interface ExamProfileVersionPublishedPayload {
  readonly profileVersionId: string;
  readonly examId: string;
  readonly academicYear: string;
  readonly taxonomyVersionId: string;
  readonly markingRuleSetHash: string;
}

export interface TaxonomyMigrationExecutedPayload {
  readonly migrationId: string;
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly mappingCount: number;
}

export type TaxonomyVersionPublished = DomainEvent<
  'TaxonomyVersionPublished',
  TaxonomyVersionPublishedPayload
>;
export type ExamProfileVersionPublished = DomainEvent<
  'ExamProfileVersionPublished',
  ExamProfileVersionPublishedPayload
>;
export type TaxonomyMigrationExecuted = DomainEvent<
  'TaxonomyMigrationExecuted',
  TaxonomyMigrationExecutedPayload
>;

export type CurriculumEvent =
  | TaxonomyVersionPublished
  | ExamProfileVersionPublished
  | TaxonomyMigrationExecuted;

/**
 * Every event either has an analytics counterpart or an explicit exemption
 * (F18). The registry is what CI checks for completeness.
 */
export interface EventRegistration {
  readonly eventType: CurriculumEventType;
  readonly schemaVersion: number;
  readonly analyticsEvent: string | null;
  readonly analyticsExemptionReason: string | null;
}

export const CURRICULUM_EVENT_REGISTRY: readonly EventRegistration[] = Object.freeze([
  Object.freeze({
    eventType: 'TaxonomyVersionPublished' as const,
    schemaVersion: 1,
    analyticsEvent: 'curriculum.taxonomy_version_published',
    analyticsExemptionReason: null,
  }),
  Object.freeze({
    eventType: 'ExamProfileVersionPublished' as const,
    schemaVersion: 1,
    analyticsEvent: 'curriculum.exam_profile_version_published',
    analyticsExemptionReason: null,
  }),
  Object.freeze({
    eventType: 'TaxonomyMigrationExecuted' as const,
    schemaVersion: 1,
    analyticsEvent: 'curriculum.taxonomy_migration_executed',
    analyticsExemptionReason: null,
  }),
]);
