import { describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { TaxonomyVersion, type TaxonomyVersionError } from './taxonomy-version.js';
import type { Result } from './result.js';
import { aChildNode, aRootNode, anEdge, anIdentity } from '../../../testing/curriculum-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const curator: PrincipalRef = { kind: 'human', id: 'usr_curator', roleContext: ['curriculum_curator'] };
const publishedAt = new Date('2026-08-05T10:00:00.000Z');

const physicsRoot = aRootNode('cn_physics', 'ci_physics');
const mechanics = aChildNode(physicsRoot, 'cn_mechanics', 'ci_mechanics');
const kinematics = aChildNode(mechanics, 'cn_kinematics', 'ci_kinematics');

function draft(): TaxonomyVersion {
  const empty = expectValue(TaxonomyVersion.createDraft({ taxonomyVersionId: 'tv_1', examFamily: 'JEE', academicYear: '2026' }));
  const withRoot = expectValue(empty.addConceptNode(physicsRoot, anIdentity('ci_physics')));
  const withMechanics = expectValue(withRoot.addConceptNode(mechanics, anIdentity('ci_mechanics')));
  return expectValue(withMechanics.addConceptNode(kinematics, anIdentity('ci_kinematics')));
}

function published(): TaxonomyVersion {
  return expectValue(draft().publish(curator, publishedAt));
}

describe('TaxonomyVersion publication', () => {
  it('starts as a draft', () => {
    expect(draft().state).toBe('draft');
    expect(draft().isMutable).toBe(true);
  });

  it('moves draft → published and stamps time and principal', () => {
    const version = published();

    expect(version.state).toBe('published');
    expect(version.publishedAt?.toISOString()).toBe('2026-08-05T10:00:00.000Z');
    expect(version.publishedBy).toEqual(curator);
    expect(version.isMutable).toBe(false);
  });

  it('does not expose a mutable publication timestamp', () => {
    const version = published();
    const stamp = version.publishedAt as Date;

    stamp.setFullYear(1999);

    expect(version.publishedAt?.getFullYear()).toBe(2026);
  });

  it('moves published → superseded', () => {
    const version = expectValue(published().supersede());

    expect(version.state).toBe('superseded');
    expect(version.isMutable).toBe(false);
  });

  it('leaves the draft unchanged when it is published', () => {
    const original = draft();

    expectValue(original.publish(curator, publishedAt));

    expect(original.state).toBe('draft');
  });

  it.each([
    ['publishing a published version', (version: TaxonomyVersion) => version.publish(curator, publishedAt)],
    ['superseding a draft', (version: TaxonomyVersion) => version.supersede()],
  ])('rejects %s', (_case, transition) => {
    const version = _case === 'superseding a draft' ? draft() : published();

    const error = expectError(transition(version));

    expect(error.code).toBe('ILLEGAL_STATE_TRANSITION');
    expect(error.kind).toBe('RuleViolation');
  });

  it('rejects publishing a superseded version', () => {
    const superseded = expectValue(published().supersede());

    expect(expectError(superseded.publish(curator, publishedAt)).code).toBe('ILLEGAL_STATE_TRANSITION');
  });

  it('rejects superseding a superseded version', () => {
    const superseded = expectValue(published().supersede());

    expect(expectError(superseded.supersede()).code).toBe('ILLEGAL_STATE_TRANSITION');
  });
});

describe('TaxonomyVersion publication preconditions', () => {
  it('blocks publication when an invariant is violated and leaves the version a draft', () => {
    const chemistryUnderPhysics = aChildNode(physicsRoot, 'cn_organic', 'ci_organic');
    const version = expectValue(draft().addConceptNode(chemistryUnderPhysics, anIdentity('ci_organic', 'chemistry')));

    const error = expectError(version.publish(curator, publishedAt));

    expect(error.code).toBe('INVARIANT_VIOLATIONS');
    expect(error.violations?.map((violation) => violation.code)).toContain('NO_ROOT_FOR_SUBJECT_DOMAIN');
    expect(error.offendingNodes.length).toBeGreaterThan(0);
    expect(version.state).toBe('draft');
    expect(version.publishedAt).toBeUndefined();
  });

  it('refuses to remove a concept that a prerequisite edge still references', () => {
    const version = expectValue(draft().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    const error = expectError(version.removeConceptNode('cn_kinematics'));

    expect(error.code).toBe('CONCEPT_REFERENCED_BY_PREREQUISITE');
    expect(expectValue(version.publish(curator, publishedAt)).state).toBe('published');
  });

  it('publishes a version whose prerequisite graph is acyclic and fully resolved', () => {
    const version = expectValue(draft().addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')));

    expect(expectValue(version.publish(curator, publishedAt)).prerequisites).toHaveLength(1);
  });
});

describe('TaxonomyVersion post-publication immutability', () => {
  const mutators: ReadonlyArray<
    readonly [string, (version: TaxonomyVersion) => Result<TaxonomyVersion, TaxonomyVersionError>]
  > = [
    ['addConceptNode', (version) => version.addConceptNode(aRootNode('cn_x', 'ci_x'), anIdentity('ci_x', 'maths'))],
    ['moveConceptNode', (version) => version.moveConceptNode('cn_kinematics', 'cn_physics')],
    ['removeConceptNode', (version) => version.removeConceptNode('cn_kinematics')],
    ['addPrerequisiteEdge', (version) => version.addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics'))],
    ['removePrerequisiteEdge', (version) => version.removePrerequisiteEdge('ci_mechanics', 'ci_kinematics')],
  ];

  it.each(mutators)('rejects %s on a published version', (_name, mutate) => {
    const result = mutate(published());

    expect(expectError(result).code).toBe('VERSION_NOT_MUTABLE');
  });

  it.each(mutators)('rejects %s on a superseded version', (_name, mutate) => {
    const superseded = expectValue(published().supersede());

    expect(mutate(superseded).ok).toBe(false);
  });

  it('accepts each mutator while still a draft', () => {
    const version = draft();

    expect(version.addConceptNode(aRootNode('cn_maths', 'ci_maths'), anIdentity('ci_maths', 'maths')).ok).toBe(true);
    expect(version.moveConceptNode('cn_kinematics', 'cn_physics').ok).toBe(true);
    expect(version.removeConceptNode('cn_kinematics').ok).toBe(true);
    expect(version.addPrerequisiteEdge(anEdge('ci_mechanics', 'ci_kinematics')).ok).toBe(true);
  });

  it('freezes the node collection of a published version', () => {
    const version = published();

    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.nodes)).toBe(true);
  });
});

describe('TaxonomyVersion move', () => {
  it('re-derives depth for the moved node and its descendants', () => {
    const optics = aChildNode(physicsRoot, 'cn_optics', 'ci_optics');
    const withOptics = expectValue(draft().addConceptNode(optics, anIdentity('ci_optics')));

    const moved = expectValue(withOptics.moveConceptNode('cn_mechanics', 'cn_optics'));

    expect(moved.nodeById('cn_mechanics')?.parentNodeId).toBe('cn_optics');
    expect(moved.nodeById('cn_mechanics')?.depth).toBe(2);
    expect(moved.nodeById('cn_kinematics')?.depth).toBe(3);
    expect(moved.validate()).toEqual([]);
  });

  it('rejects a move under the node’s own descendant', () => {
    const error = expectError(draft().moveConceptNode('cn_mechanics', 'cn_kinematics'));

    expect(error.code).toBe('PARENT_CYCLE_WOULD_FORM');
  });

  it('rejects a move of an unknown node or to an unknown parent', () => {
    expect(expectError(draft().moveConceptNode('cn_absent', 'cn_physics')).code).toBe('CONCEPT_NODE_NOT_FOUND');
    expect(expectError(draft().moveConceptNode('cn_kinematics', 'cn_absent')).code).toBe('PARENT_NODE_NOT_FOUND');
  });
});
