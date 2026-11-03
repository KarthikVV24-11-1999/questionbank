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

export interface PublishedSyllabus {
  readonly examCode: string;
  readonly academicYear: string;
  readonly profileVersionId: string;
  readonly taxonomyVersionId: string;
  /** A subject, two chapters under it, and a topic under the first chapter. */
  readonly nodes: { readonly physics: string; readonly mechanics: string; readonly optics: string; readonly kinematics: string };
  readonly concepts: { readonly physics: string; readonly mechanics: string; readonly optics: string; readonly kinematics: string };
}

/**
 * A published syllabus with a hierarchy a learner can pick from, and an exam with a profile version active for a year (inserting an active profile is what activates it for the year it names), written through curriculum's own repositories. Physics has
 * Mechanics and Optics under it and Kinematics under Mechanics, so that picking a chapter stands for the chapter and the topic under it.
 */
export async function seedPublishedSyllabus(database: TestDatabase, options: { readonly examCode?: string; readonly academicYear?: string; readonly publishTaxonomy?: boolean } = {}): Promise<PublishedSyllabus> {
  const examCode = options.examCode ?? 'JEE_MAIN';
  const academicYear = options.academicYear ?? '2027';
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const versions = new DrizzleTaxonomyVersionRepository(database.db);
  const taxonomyVersionId = randomUUID();
  let version = expectValue(TaxonomyVersion.createDraft({ taxonomyVersionId, examFamily: 'JEE', academicYear }));
  expectValue(await versions.insert(version));

  const concepts = { physics: randomUUID(), mechanics: randomUUID(), optics: randomUUID(), kinematics: randomUUID() };
  const nodes = { physics: randomUUID(), mechanics: randomUUID(), optics: randomUUID(), kinematics: randomUUID() };
  const identity = async (id: string, name: string) => {
    const made = expectValue(ConceptIdentity.create({ conceptIdentityId: id, canonicalName: name, subjectDomain: 'physics', createdInVersion: taxonomyVersionId }));
    expectValue(await identities.insert(made));
    return made;
  };
  const props = (conceptNodeId: string, conceptIdentityId: string, displayName: string) => ({ conceptNodeId, conceptIdentityId, displayName, examWeight: 1, estimatedTeachingHours: 10 });
  const root = expectValue(ConceptNode.createRoot(props(nodes.physics, concepts.physics, 'Physics')));
  version = expectValue(version.addConceptNode(root, await identity(concepts.physics, 'Physics')));
  const mechanics = expectValue(ConceptNode.createUnder(root, props(nodes.mechanics, concepts.mechanics, 'Mechanics')));
  version = expectValue(version.addConceptNode(mechanics, await identity(concepts.mechanics, 'Mechanics')));
  const optics = expectValue(ConceptNode.createUnder(root, props(nodes.optics, concepts.optics, 'Optics')));
  version = expectValue(version.addConceptNode(optics, await identity(concepts.optics, 'Optics')));
  const kinematics = expectValue(ConceptNode.createUnder(mechanics, props(nodes.kinematics, concepts.kinematics, 'Kinematics')));
  version = expectValue(version.addConceptNode(kinematics, await identity(concepts.kinematics, 'Kinematics')));
  expectValue(await versions.update(version, 1));
  if (options.publishTaxonomy !== false) expectValue(await versions.update(expectValue(version.publish(staff, new Date('2026-08-05T08:00:00.000Z'))), 2));

  const exam = expectValue(Exam.create({ examId: randomUUID(), code: examCode, displayName: examCode === 'JEE_MAIN' ? 'JEE Main' : examCode, jurisdiction: 'IN', conductingBody: 'NTA' }));
  const examRepo = new DrizzleExamRepository(database.db);
  expectValue(await examRepo.insert(exam));
  const profileVersionId = randomUUID();
  const draft = expectValue(ExamProfileVersion.createDraft(jeeMainProfileProps({ profileVersionId, examId: exam.examId, taxonomyVersionId, academicYear })));
  if (options.publishTaxonomy !== false) {
    const published = expectValue(draft.publish({ taxonomyVersionIsPublished: true, publishedBy: staff, publishedAt: new Date('2026-08-05T09:00:00.000Z') }));
    expectValue(await new DrizzleExamProfileVersionRepository(database.db).insert(published, true));
  } else {
    expectValue(await new DrizzleExamProfileVersionRepository(database.db).insert(draft, false));
  }
  return { examCode, academicYear, profileVersionId, taxonomyVersionId, nodes, concepts };
}
