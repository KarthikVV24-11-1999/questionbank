import type { ConceptIdentity } from '../contexts/curriculum/domain/concept-identity.js';
import type { TaxonomyVersion } from '../contexts/curriculum/domain/taxonomy-version.js';
import { ok, err, type Result } from '../contexts/curriculum/domain/result.js';
import {
  conflict,
  notFound,
  type ConceptIdentityRepository,
  type Persisted,
  type RepositoryError,
  type TaxonomyVersionRepository,
} from '../contexts/curriculum/domain/repository-ports.js';
import type { Clock, IdentifierFactory } from '../contexts/curriculum/application/ports.js';

/**
 * In-memory repositories for handler unit tests. They implement the same ports
 * as the Drizzle adapters, including optimistic concurrency, so a handler test
 * exercises the real control flow without I/O.
 */
export class InMemoryTaxonomyVersionRepository implements TaxonomyVersionRepository {
  readonly rows = new Map<string, Persisted<TaxonomyVersion>>();

  async insert(version: TaxonomyVersion): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    if (this.rows.has(version.taxonomyVersionId)) {
      return err(conflict(`taxonomy version ${version.taxonomyVersionId} already exists`));
    }
    const stored = { aggregate: version, aggregateVersion: 1 };
    this.rows.set(version.taxonomyVersionId, stored);
    return ok(stored);
  }

  async update(
    version: TaxonomyVersion,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    const current = this.rows.get(version.taxonomyVersionId);
    if (current === undefined) return err(notFound(`taxonomy version ${version.taxonomyVersionId} not found`));
    if (current.aggregateVersion !== expectedAggregateVersion) {
      return err(
        conflict(
          `taxonomy version ${version.taxonomyVersionId} was modified by someone else: expected aggregate version ${expectedAggregateVersion}`,
        ),
      );
    }

    const stored = { aggregate: version, aggregateVersion: expectedAggregateVersion + 1 };
    this.rows.set(version.taxonomyVersionId, stored);
    return ok(stored);
  }

  async findById(taxonomyVersionId: string): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    const stored = this.rows.get(taxonomyVersionId);
    return stored === undefined
      ? err(notFound(`taxonomy version ${taxonomyVersionId} not found`))
      : ok(stored);
  }

  async listByExamFamily(examFamily: string): Promise<readonly Persisted<TaxonomyVersion>[]> {
    return [...this.rows.values()].filter((stored) => stored.aggregate.examFamily === examFamily);
  }
}

export class InMemoryConceptIdentityRepository implements ConceptIdentityRepository {
  readonly rows = new Map<string, Persisted<ConceptIdentity>>();

  async insert(identity: ConceptIdentity): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>> {
    const stored = { aggregate: identity, aggregateVersion: 1 };
    this.rows.set(identity.conceptIdentityId, stored);
    return ok(stored);
  }

  async update(
    identity: ConceptIdentity,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>> {
    const current = this.rows.get(identity.conceptIdentityId);
    if (current === undefined) {
      return err(notFound(`concept identity ${identity.conceptIdentityId} not found`));
    }
    if (current.aggregateVersion !== expectedAggregateVersion) {
      return err(conflict(`concept identity ${identity.conceptIdentityId} was modified by someone else`));
    }

    const stored = { aggregate: identity, aggregateVersion: expectedAggregateVersion + 1 };
    this.rows.set(identity.conceptIdentityId, stored);
    return ok(stored);
  }

  async findById(conceptIdentityId: string): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>> {
    const stored = this.rows.get(conceptIdentityId);
    return stored === undefined
      ? err(notFound(`concept identity ${conceptIdentityId} not found`))
      : ok(stored);
  }
}

export class FixedClock implements Clock {
  constructor(private readonly instant = new Date('2026-08-05T09:00:00.000Z')) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

export class SequentialIdentifiers implements IdentifierFactory {
  #issued = 0;

  constructor(private readonly prefix = 'id') {}

  next(): string {
    this.#issued += 1;
    return `${this.prefix}_${this.#issued}`;
  }
}
