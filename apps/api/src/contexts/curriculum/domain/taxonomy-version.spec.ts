import { describe, expect, it } from 'vitest';
import { TaxonomyVersion } from './taxonomy-version.js';
import { aChildNode, aRootNode, anEdge, anIdentity } from '../../../testing/curriculum-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const physicsIdentity = anIdentity('ci_physics');
const mechanicsIdentity = anIdentity('ci_mechanics');
const kinematicsIdentity = anIdentity('ci_kinematics');
const chemistryIdentity = anIdentity('ci_chemistry', 'chemistry');

const physicsRoot = aRootNode('cn_physics', 'ci_physics');
const mechanics = aChildNode(physicsRoot, 'cn_mechanics', 'ci_mechanics');
const kinematics = aChildNode(mechanics, 'cn_kinematics', 'ci_kinematics');

function draft(): TaxonomyVersion {
  return expectValue(TaxonomyVersion.createDraft({ taxonomyVersionId: 'tv_1', examFamily: 'JEE', academicYear: '2026' }));
}

function physicsTree(): TaxonomyVersion {
  const withRoot = expectValue(draft().addConceptNode(physicsRoot, physicsIdentity));
  const withMechanics = expectValue(withRoot.addConceptNode(mechanics, mechanicsIdentity));
  return expectValue(withMechanics.addConceptNode(kinematics, kinematicsIdentity));
}

describe('TaxonomyVersion creation', () => {
  it('starts empty and consistent', () => {
    const version = draft();

    expect(version.taxonomyVersionId).toBe('tv_1');
    expect(version.academicYear).toBe('2026');
    expect(version.nodes).toEqual([]);
    expect(version.validate()).toEqual([]);
  });

  it('rejects an empty id', () => {
    expect(
      expectError(TaxonomyVersion.createDraft({ taxonomyVersionId: ' ', examFamily: 'JEE', academicYear: '2026' })).code,
    ).toBe('TAXONOMY_VERSION_ID_REQUIRED');
  });

  it.each(['', '26', 'next year', '2026-2027'])('rejects academic year %j', (academicYear) => {
    expect(
      expectError(TaxonomyVersion.createDraft({ taxonomyVersionId: 'tv_1', examFamily: 'JEE', academicYear })).code,
    ).toBe('ACADEMIC_YEAR_INVALID');
  });

  it.each(['2026', '2026-27'])('accepts academic year %j', (academicYear) => {
    expect(
      expectValue(TaxonomyVersion.createDraft({ taxonomyVersionId: 'tv_1', examFamily: 'JEE', academicYear })).academicYear,
    ).toBe(academicYear);
  });
});

describe('TaxonomyVersion node placement', () => {
  it('accepts a valid tree and reports no violations', () => {
    const version = physicsTree();

    expect(version.nodes).toHaveLength(3);
    expect(version.validate()).toEqual([]);
    expect(version.nodeById('cn_kinematics')?.depth).toBe(2);
  });

  it('supports several subject domains, one root each', () => {
    const chemistryRoot = aRootNode('cn_chemistry', 'ci_chemistry');
    const version = expectValue(physicsTree().addConceptNode(chemistryRoot, chemistryIdentity));

    expect(version.validate()).toEqual([]);
    expect(version.nodes).toHaveLength(4);
  });

  it('rejects a second root in the same subject domain', () => {
    const secondRoot = aRootNode('cn_physics_alt', 'ci_optics');

    const error = expectError(physicsTree().addConceptNode(secondRoot, anIdentity('ci_optics')));

    expect(error.code).toBe('MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN');
    expect(error.offendingNodes).toContain('cn_physics');
  });

  it('rejects a node whose parent is not in the version — no orphans', () => {
    const orphan = aChildNode(mechanics, 'cn_orphan', 'ci_orphan');

    const error = expectError(draft().addConceptNode(orphan, anIdentity('ci_orphan')));

    expect(error.code).toBe('PARENT_NODE_NOT_FOUND');
    expect(error.offendingNodes).toEqual(['cn_orphan', 'cn_mechanics']);
  });

  it('rejects a duplicate concept identity within the version', () => {
    const duplicate = aChildNode(physicsRoot, 'cn_mechanics_copy', 'ci_mechanics');

    const error = expectError(physicsTree().addConceptNode(duplicate, mechanicsIdentity));

    expect(error.code).toBe('DUPLICATE_CONCEPT_IDENTITY');
    expect(error.offendingNodes).toEqual(['ci_mechanics', 'cn_mechanics', 'cn_mechanics_copy']);
  });

  it('rejects a duplicate node id', () => {
    const sameId = aChildNode(physicsRoot, 'cn_mechanics', 'ci_other');

    expect(expectError(physicsTree().addConceptNode(sameId, anIdentity('ci_other'))).code).toBe(
      'DUPLICATE_CONCEPT_NODE_ID',
    );
  });

  it('rejects an identity that does not match the node', () => {
    const error = expectError(draft().addConceptNode(physicsRoot, mechanicsIdentity));

    expect(error.code).toBe('CONCEPT_IDENTITY_MISMATCH');
    expect(error.offendingNodes).toContain('ci_physics');
  });

  it('keeps depth consistent with the parent chain it accepted', () => {
    const version = physicsTree();

    expect(version.nodeById('cn_physics')?.depth).toBe(0);
    expect(version.nodeById('cn_mechanics')?.depth).toBe(1);
    expect(version.nodeById('cn_kinematics')?.depth).toBe(2);
    expect(version.childrenOf('cn_mechanics').map((node) => node.conceptNodeId)).toEqual(['cn_kinematics']);
  });

  it('leaves the original version untouched when a node is added', () => {
    const version = draft();

    expectValue(version.addConceptNode(physicsRoot, physicsIdentity));

    expect(version.nodes).toEqual([]);
  });
});

describe('TaxonomyVersion node removal', () => {
  it('removes a leaf', () => {
    const version = expectValue(physicsTree().removeConceptNode('cn_kinematics'));

    expect(version.nodes).toHaveLength(2);
    expect(version.validate()).toEqual([]);
  });

  it('refuses to remove a node with children, which would orphan them', () => {
    const error = expectError(physicsTree().removeConceptNode('cn_mechanics'));

    expect(error.code).toBe('NODE_HAS_CHILDREN');
    expect(error.offendingNodes).toEqual(['cn_mechanics', 'cn_kinematics']);
  });

  it('refuses to remove a concept still referenced by a prerequisite edge', () => {
    const version = expectValue(physicsTree().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    const error = expectError(version.removeConceptNode('cn_kinematics'));

    expect(error.code).toBe('CONCEPT_REFERENCED_BY_PREREQUISITE');
  });

  it('rejects removal of an unknown node', () => {
    expect(expectError(physicsTree().removeConceptNode('cn_absent')).code).toBe('CONCEPT_NODE_NOT_FOUND');
  });
});

describe('TaxonomyVersion prerequisite edges', () => {
  it('accepts an acyclic edge', () => {
    const version = expectValue(physicsTree().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    expect(version.prerequisites).toHaveLength(1);
    expect(version.validate()).toEqual([]);
  });

  it('rejects an edge that would close a two-node cycle', () => {
    const version = expectValue(physicsTree().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    const error = expectError(version.addPrerequisiteEdge(anEdge('ci_kinematics', 'ci_mechanics')));

    expect(error.code).toBe('PREREQUISITE_CYCLE');
    expect(error.offendingNodes).toEqual(['ci_kinematics', 'ci_mechanics']);
  });

  it('rejects an edge that would close a three-node indirect cycle', () => {
    const first = expectValue(physicsTree().addPrerequisiteEdge(anEdge('ci_physics', 'ci_mechanics')));
    const second = expectValue(first.addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    const error = expectError(second.addPrerequisiteEdge(anEdge('ci_kinematics', 'ci_physics')));

    expect(error.code).toBe('PREREQUISITE_CYCLE');
    expect(error.offendingNodes).toEqual(['ci_kinematics', 'ci_mechanics', 'ci_physics']);
  });

  it('rejects an edge referencing a concept not placed in the version', () => {
    const error = expectError(physicsTree().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_absent')));

    expect(error.code).toBe('UNKNOWN_PREREQUISITE_CONCEPT');
    expect(error.offendingNodes).toEqual(['ci_absent']);
  });

  it('rejects a duplicate edge', () => {
    const version = expectValue(physicsTree().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    expect(expectError(version.addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics'))).code).toBe(
      'DUPLICATE_PREREQUISITE_EDGE',
    );
  });

  it('names the offending concepts on a cycle rejection', () => {
    const version = expectValue(physicsTree().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    const error = expectError(version.addPrerequisiteEdge(anEdge('ci_kinematics', 'ci_mechanics')));

    expect(error.message).toContain('ci_mechanics');
    expect(error.kind).toBe('RuleViolation');
  });
});
