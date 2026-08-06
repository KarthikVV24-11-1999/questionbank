import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ok, err, type Result } from '../domain/result.js';
import { ConceptIdentity, type ConceptIdentityId } from '../domain/concept-identity.js';
import {
  conflict,
  corruptRow,
  notFound,
  type ConceptIdentityRepository,
  type Persisted,
  type RepositoryError,
} from '../domain/repository-ports.js';
import { conceptIdentity } from './schema.js';

type ConceptIdentityRow = typeof conceptIdentity.$inferSelect;

/**
 * The snake_case ↔ camelCase boundary for concept identities. It exists here
 * and nowhere else (ENGINEERING-HANDBOOK §2).
 */
export function toConceptIdentity(row: ConceptIdentityRow): Result<ConceptIdentity, RepositoryError> {
  const identity = ConceptIdentity.reconstitute({
    conceptIdentityId: row.conceptIdentityId,
    canonicalName: row.canonicalName,
    subjectDomain: row.subjectDomain,
    createdInVersion: row.createdInVersion,
    ...(row.supersededBy !== null ? { supersededBy: row.supersededBy } : {}),
  });

  return identity.ok
    ? ok(identity.value)
    : err(corruptRow(`concept_identity ${row.conceptIdentityId} cannot be loaded: ${identity.error.message}`));
}

export function toConceptIdentityRow(identity: ConceptIdentity): typeof conceptIdentity.$inferInsert {
  return {
    conceptIdentityId: identity.conceptIdentityId,
    canonicalName: identity.canonicalName,
    subjectDomain: identity.subjectDomain,
    createdInVersion: identity.createdInVersion,
    supersededBy: identity.supersededBy ?? null,
  };
}

export class DrizzleConceptIdentityRepository implements ConceptIdentityRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(identity: ConceptIdentity): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>> {
    const [row] = await this.db
      .insert(conceptIdentity)
      .values({ ...toConceptIdentityRow(identity), aggregateVersion: 1 })
      .returning();

    return row === undefined
      ? err(conflict(`concept identity ${identity.conceptIdentityId} was not inserted`))
      : ok({ aggregate: identity, aggregateVersion: row.aggregateVersion });
  }

  async update(
    identity: ConceptIdentity,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>> {
    const rows = await this.db
      .update(conceptIdentity)
      .set({ ...toConceptIdentityRow(identity), aggregateVersion: expectedAggregateVersion + 1 })
      .where(
        and(
          eq(conceptIdentity.conceptIdentityId, identity.conceptIdentityId),
          eq(conceptIdentity.aggregateVersion, expectedAggregateVersion),
        ),
      )
      .returning();

    const row = rows[0];
    return row === undefined
      ? err(
          conflict(
            `concept identity ${identity.conceptIdentityId} was modified by someone else: expected aggregate version ${expectedAggregateVersion}`,
          ),
        )
      : ok({ aggregate: identity, aggregateVersion: row.aggregateVersion });
  }

  async findById(
    conceptIdentityId: ConceptIdentityId,
  ): Promise<Result<Persisted<ConceptIdentity>, RepositoryError>> {
    const rows = await this.db
      .select()
      .from(conceptIdentity)
      .where(eq(conceptIdentity.conceptIdentityId, conceptIdentityId));

    const row = rows[0];
    if (row === undefined) return err(notFound(`concept identity ${conceptIdentityId} not found`));

    const identity = toConceptIdentity(row);
    return identity.ok ? ok({ aggregate: identity.value, aggregateVersion: row.aggregateVersion }) : identity;
  }
}
