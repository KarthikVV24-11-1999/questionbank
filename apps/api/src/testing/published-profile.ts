import { randomUUID } from 'node:crypto';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../contexts/curriculum/domain/concept-identity.js';
import { ConceptNode } from '../contexts/curriculum/domain/concept-node.js';
import { Exam } from '../contexts/curriculum/domain/exam.js';
import { ExamProfileVersion } from '../contexts/curriculum/domain/exam-profile-version.js';
import { TaxonomyVersion } from '../contexts/curriculum/domain/taxonomy-version.js';
import { DrizzleConceptIdentityRepository } from '../contexts/curriculum/infrastructure/concept-identity.repository.js';
import { DrizzleExamProfileVersionRepository } from '../contexts/curriculum/infrastructure/exam-profile-version.repository.js';
import { DrizzleExamRepository } from '../contexts/curriculum/infrastructure/exam.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../contexts/curriculum/infrastructure/taxonomy-version.repository.js';
import type { TestDatabase } from './database.js';
import { expectValue } from './expect-result.js';
import { jeeMainProfileProps } from './profile-fixtures.js';

const staff: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['curriculum_curator'] };

export interface PublishedProfile {
  readonly profileVersionId: string;
  readonly taxonomyVersionId: string;
}

/**
 * A real, published JEE Main exam profile version (and the taxonomy it is built on) in the test database, written through
 * curriculum's own repositories — what an attempt's pins are copied from, so a spec that creates attempts reads them from
 * curriculum rather than from a double. Three hours, as the profile says.
 */
export async function seedPublishedProfile(database: TestDatabase): Promise<PublishedProfile> {
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const versions = new DrizzleTaxonomyVersionRepository(database.db);
  const taxonomyVersionId = randomUUID();

  let version = expectValue(TaxonomyVersion.createDraft({ taxonomyVersionId, examFamily: 'JEE', academicYear: '2026' }));
  expectValue(await versions.insert(version));
  const identity = expectValue(
    ConceptIdentity.create({ conceptIdentityId: randomUUID(), canonicalName: 'Physics', subjectDomain: 'physics', createdInVersion: taxonomyVersionId }),
  );
  expectValue(await identities.insert(identity));
  const node = expectValue(
    ConceptNode.createRoot({ conceptNodeId: randomUUID(), conceptIdentityId: identity.conceptIdentityId, displayName: 'Physics', examWeight: 1, estimatedTeachingHours: 10 }),
  );
  version = expectValue(version.addConceptNode(node, identity));
  expectValue(await versions.update(version, 1));
  expectValue(await versions.update(expectValue(version.publish(staff, new Date('2026-08-05T08:00:00.000Z'))), 2));

  const exam = expectValue(Exam.create({ examId: randomUUID(), code: 'JEE_MAIN', displayName: 'JEE Main', jurisdiction: 'IN', conductingBody: 'NTA' }));
  expectValue(await new DrizzleExamRepository(database.db).insert(exam));

  const profileVersionId = randomUUID();
  const draft = expectValue(ExamProfileVersion.createDraft(jeeMainProfileProps({ profileVersionId, examId: exam.examId, taxonomyVersionId })));
  const published = expectValue(draft.publish({ taxonomyVersionIsPublished: true, publishedBy: staff, publishedAt: new Date('2026-08-05T09:00:00.000Z') }));
  expectValue(await new DrizzleExamProfileVersionRepository(database.db).insert(published, true));
  return { profileVersionId, taxonomyVersionId };
}
