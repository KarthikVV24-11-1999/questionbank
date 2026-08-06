import type { Result } from './result.js';
import type { ConceptIdentity, ConceptIdentityId } from './concept-identity.js';
import type { TaxonomyVersion, TaxonomyVersionId } from './taxonomy-version.js';

/** An aggregate together with the concurrency counter it was loaded at (P8). */
export interface Persisted<T> {
  readonly aggregate: T;
  readonly aggregateVersion: number;
}

/**
 * Failures a repository reports as values. Infrastructure faults — the database
 * is unreachable, a statement is malformed — still throw (ENGINEERING-HANDBOOK §8).
 */
export type RepositoryErrorCode = 'CONFLICT' | 'NOT_FOUND' | 'CORRUPT_ROW';

export interface RepositoryError {
  readonly kind: 'Conflict' | 'NotFound' | 'RuleViolation';
  readonly code: RepositoryErrorCode;
  readonly message: string;
}

export function conflict(message: string): RepositoryError {
  return { kind: 'Conflict', code: 'CONFLICT', message };
}

export function notFound(message: string): RepositoryError {
  return { kind: 'NotFound', code: 'NOT_FOUND', message };
}

export function corruptRow(message: string): RepositoryError {
  return { kind: 'RuleViolation', code: 'CORRUPT_ROW', message };
}

export interface ConceptIdentityRepository {
  insert(identity: ConceptIdentity): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>>;
  update(
    identity: ConceptIdentity,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>>;
  findById(
    conceptIdentityId: ConceptIdentityId,
  ): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>>;
}

export interface TaxonomyVersionRepository {
  insert(version: TaxonomyVersion): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>>;
  update(
    version: TaxonomyVersion,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>>;
  findById(
    taxonomyVersionId: TaxonomyVersionId,
  ): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>>;
  listByExamFamily(examFamily: string): Promise<readonly Persisted<TaxonomyVersion>[]>;
}
