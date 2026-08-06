import { describe, expect, it } from 'vitest';
import {
  checkNoDuplicateConceptIdentities,
  checkNoOrphans,
  checkNoParentCycles,
  checkNoPrerequisiteCycles,
  checkPrerequisiteEndpointsExist,
  checkRootsPerSubjectDomain,
  checkTaxonomyInvariants,
  type TaxonomyStructure,
} from './taxonomy-invariants.js';
import { aChildNode, aRootNode, anEdge, subjectDomains } from '../../../testing/curriculum-fixtures.js';

const physicsRoot = aRootNode('cn_physics', 'ci_physics');
const mechanics = aChildNode(physicsRoot, 'cn_mechanics', 'ci_mechanics');
const kinematics = aChildNode(mechanics, 'cn_kinematics', 'ci_kinematics');

const domains = subjectDomains({
  ci_physics: 'physics',
  ci_mechanics: 'physics',
  ci_kinematics: 'physics',
});

function structure(overrides: Partial<TaxonomyStructure> = {}): TaxonomyStructure {
  return {
    nodes: [physicsRoot, mechanics, kinematics],
    prerequisites: [],
    subjectDomainOf: domains,
    ...overrides,
  };
}

describe('a valid tree', () => {
  it('produces no violations', () => {
    expect(checkTaxonomyInvariants(structure())).toEqual([]);
  });

  it('accepts one root per subject domain across several domains', () => {
    const chemistryRoot = aRootNode('cn_chemistry', 'ci_chemistry');

    const violations = checkTaxonomyInvariants({
      nodes: [physicsRoot, mechanics, chemistryRoot],
      prerequisites: [anEdge('ci_mechanics', 'ci_chemistry')],
      subjectDomainOf: subjectDomains({
        ci_physics: 'physics',
        ci_mechanics: 'physics',
        ci_chemistry: 'chemistry',
      }),
    });

    expect(violations).toEqual([]);
  });
});

describe('root per subject domain', () => {
  it('rejects two roots in the same subject domain', () => {
    const secondRoot = aRootNode('cn_physics_alt', 'ci_mechanics');

    const [violation] = checkRootsPerSubjectDomain(
      structure({ nodes: [physicsRoot, secondRoot] }),
    );

    expect(violation?.code).toBe('MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN');
    expect(violation?.offendingNodes).toEqual(['cn_physics', 'cn_physics_alt']);
  });

  it('rejects a subject domain with no root', () => {
    const [violation] = checkRootsPerSubjectDomain(structure({ nodes: [mechanics, kinematics] }));

    expect(violation?.code).toBe('NO_ROOT_FOR_SUBJECT_DOMAIN');
    expect(violation?.offendingNodes).toEqual(['physics']);
  });
});

describe('orphan nodes', () => {
  it('rejects a node whose parent is absent from the version', () => {
    const [violation] = checkNoOrphans(structure({ nodes: [physicsRoot, kinematics] }));

    expect(violation?.code).toBe('ORPHAN_NODE');
    expect(violation?.offendingNodes).toEqual(['cn_kinematics', 'cn_mechanics']);
    expect(violation?.message).toContain('cn_mechanics');
  });

  it('accepts a fully connected hierarchy', () => {
    expect(checkNoOrphans(structure())).toEqual([]);
  });
});

describe('parent hierarchy cycles', () => {
  it('rejects a two-node parent cycle', () => {
    const cyclicRoot = physicsRoot.moveUnder(mechanics);

    const [violation] = checkNoParentCycles(structure({ nodes: [cyclicRoot, mechanics] }));

    expect(violation?.code).toBe('PARENT_CYCLE');
    expect(violation?.offendingNodes).toEqual(['cn_mechanics', 'cn_physics']);
  });

  it('rejects a three-node parent cycle', () => {
    const cyclicRoot = physicsRoot.moveUnder(kinematics);

    const [violation] = checkNoParentCycles(
      structure({ nodes: [cyclicRoot, mechanics, kinematics] }),
    );

    expect(violation?.code).toBe('PARENT_CYCLE');
    expect(violation?.offendingNodes).toEqual(['cn_kinematics', 'cn_mechanics', 'cn_physics']);
  });

  it('reports a cycle once even when several nodes hang off it', () => {
    const cyclicRoot = physicsRoot.moveUnder(mechanics);
    const leaf = aChildNode(kinematics, 'cn_projectiles', 'ci_projectiles');

    const violations = checkNoParentCycles(
      structure({ nodes: [cyclicRoot, mechanics, kinematics, leaf] }),
    );

    expect(violations).toHaveLength(1);
  });

  it('accepts an acyclic hierarchy', () => {
    expect(checkNoParentCycles(structure())).toEqual([]);
  });
});

describe('duplicate concept identities', () => {
  it('rejects the same concept identity placed on two nodes', () => {
    const duplicate = aChildNode(physicsRoot, 'cn_mechanics_copy', 'ci_mechanics');

    const [violation] = checkNoDuplicateConceptIdentities(
      structure({ nodes: [physicsRoot, mechanics, duplicate] }),
    );

    expect(violation?.code).toBe('DUPLICATE_CONCEPT_IDENTITY');
    expect(violation?.offendingNodes).toEqual(['ci_mechanics', 'cn_mechanics', 'cn_mechanics_copy']);
  });

  it('accepts distinct identities', () => {
    expect(checkNoDuplicateConceptIdentities(structure())).toEqual([]);
  });
});

describe('prerequisite graph', () => {
  it('accepts an acyclic prerequisite graph', () => {
    const violations = checkNoPrerequisiteCycles(
      structure({
        prerequisites: [anEdge('ci_physics', 'ci_mechanics'), anEdge('ci_mechanics', 'ci_kinematics')],
      }),
    );

    expect(violations).toEqual([]);
  });

  it('rejects a two-node prerequisite cycle', () => {
    const [violation] = checkNoPrerequisiteCycles(
      structure({
        prerequisites: [anEdge('ci_mechanics', 'ci_kinematics'), anEdge('ci_kinematics', 'ci_mechanics')],
      }),
    );

    expect(violation?.code).toBe('PREREQUISITE_CYCLE');
    expect(violation?.offendingNodes).toEqual(['ci_kinematics', 'ci_mechanics']);
  });

  it('rejects a three-node indirect prerequisite cycle', () => {
    const [violation] = checkNoPrerequisiteCycles(
      structure({
        prerequisites: [
          anEdge('ci_physics', 'ci_mechanics'),
          anEdge('ci_mechanics', 'ci_kinematics'),
          anEdge('ci_kinematics', 'ci_physics'),
        ],
      }),
    );

    expect(violation?.code).toBe('PREREQUISITE_CYCLE');
    expect(violation?.offendingNodes).toEqual(['ci_kinematics', 'ci_mechanics', 'ci_physics']);
    expect(violation?.message).toContain('ci_physics');
  });

  it('accepts a diamond, which is not a cycle', () => {
    const violations = checkNoPrerequisiteCycles(
      structure({
        prerequisites: [
          anEdge('ci_physics', 'ci_mechanics'),
          anEdge('ci_physics', 'ci_kinematics'),
          anEdge('ci_mechanics', 'ci_projectiles'),
          anEdge('ci_kinematics', 'ci_projectiles'),
        ],
      }),
    );

    expect(violations).toEqual([]);
  });

  it('rejects an edge endpoint that is not placed in the version', () => {
    const [violation] = checkPrerequisiteEndpointsExist(
      structure({ prerequisites: [anEdge('ci_mechanics', 'ci_thermodynamics')] }),
    );

    expect(violation?.code).toBe('UNKNOWN_PREREQUISITE_CONCEPT');
    expect(violation?.offendingNodes).toEqual(['ci_thermodynamics']);
  });
});

describe('violation reporting', () => {
  it('reports every violation of a badly formed version at once', () => {
    const duplicate = aChildNode(physicsRoot, 'cn_dup', 'ci_mechanics');

    const codes = checkTaxonomyInvariants({
      nodes: [mechanics, kinematics, duplicate],
      prerequisites: [anEdge('ci_mechanics', 'ci_missing')],
      subjectDomainOf: domains,
    }).map((violation) => violation.code);

    expect(codes).toContain('DUPLICATE_CONCEPT_IDENTITY');
    expect(codes).toContain('ORPHAN_NODE');
    expect(codes).toContain('NO_ROOT_FOR_SUBJECT_DOMAIN');
    expect(codes).toContain('UNKNOWN_PREREQUISITE_CONCEPT');
  });

  it('names the offending nodes on every violation', () => {
    const violations = checkTaxonomyInvariants({
      nodes: [kinematics],
      prerequisites: [],
      subjectDomainOf: domains,
    });

    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.offendingNodes.length).toBeGreaterThan(0);
      expect(violation.kind).toBe('RuleViolation');
    }
  });
});
