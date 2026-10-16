import { randomUUID } from 'node:crypto';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../contexts/curriculum/domain/concept-identity.js';
import { ConceptNode } from '../contexts/curriculum/domain/concept-node.js';
import { TaxonomyVersion } from '../contexts/curriculum/domain/taxonomy-version.js';
import { DrizzleConceptIdentityRepository } from '../contexts/curriculum/infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../contexts/curriculum/infrastructure/taxonomy-version.repository.js';
import type { TestDatabase } from './database.js';
import { expectValue } from './expect-result.js';

const OWNER: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['exam_owner'] };

/**
 * A taxonomy version with one concept, built through curriculum's own domain and
 * repositories, and published unless asked not to be. Real rows, so a check that
 * reads curriculum is tested against curriculum and not against a description of it.
 */
export async function aTaxonomy(
  database: TestDatabase,
  options: { readonly versionId: string; readonly conceptIdentityId: string; readonly displayName: string; readonly publish: boolean },
): Promise<void> {
  const versions = new DrizzleTaxonomyVersionRepository(database.db);
  const identities = new DrizzleConceptIdentityRepository(database.db);

  let version = expectValue(TaxonomyVersion.createDraft({ taxonomyVersionId: options.versionId, examFamily: 'JEE', academicYear: '2026' }));
  expectValue(await versions.insert(version));
  const identity = expectValue(
    ConceptIdentity.create({
      conceptIdentityId: options.conceptIdentityId,
      canonicalName: options.displayName,
      subjectDomain: 'physics',
      createdInVersion: options.versionId,
    }),
  );
  expectValue(await identities.insert(identity));
  version = expectValue(
    version.addConceptNode(
      expectValue(
        ConceptNode.createRoot({
          conceptNodeId: randomUUID(),
          conceptIdentityId: identity.conceptIdentityId,
          displayName: options.displayName,
          examWeight: 1,
          estimatedTeachingHours: 20,
        }),
      ),
      identity,
    ),
  );
  expectValue(await versions.update(version, 1));
  if (options.publish) {
    expectValue(await versions.update(expectValue(version.publish(OWNER, new Date('2026-08-05T08:00:00.000Z'))), 2));
  }
}
