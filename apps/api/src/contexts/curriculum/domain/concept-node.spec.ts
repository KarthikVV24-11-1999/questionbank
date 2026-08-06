import { describe, expect, it } from 'vitest';
import { ConceptNode, type CreateConceptNodeProps } from './concept-node.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const rootProps: CreateConceptNodeProps = {
  conceptNodeId: 'cn_physics',
  conceptIdentityId: 'ci_physics',
  displayName: 'Physics',
  examWeight: 1,
  estimatedTeachingHours: 300,
};

const childProps: CreateConceptNodeProps = {
  conceptNodeId: 'cn_mechanics',
  conceptIdentityId: 'ci_mechanics',
  displayName: 'Mechanics',
  examWeight: 0.25,
  estimatedTeachingHours: 80,
};

function root(overrides: Partial<CreateConceptNodeProps> = {}): ConceptNode {
  return expectValue(ConceptNode.createRoot({ ...rootProps, ...overrides }));
}

function child(parent: ConceptNode, overrides: Partial<CreateConceptNodeProps> = {}): ConceptNode {
  return expectValue(ConceptNode.createUnder(parent, { ...childProps, ...overrides }));
}

describe('ConceptNode fields', () => {
  it('carries identity, placement, display name, weight and teaching hours', () => {
    const node = child(root());

    expect(node.conceptNodeId).toBe('cn_mechanics');
    expect(node.conceptIdentityId).toBe('ci_mechanics');
    expect(node.parentNodeId).toBe('cn_physics');
    expect(node.displayName).toBe('Mechanics');
    expect(node.examWeight).toBe(0.25);
    expect(node.estimatedTeachingHours).toBe(80);
  });

  it('has no parent when created as a root', () => {
    expect(root().parentNodeId).toBeUndefined();
    expect(root().isRoot).toBe(true);
  });

  it('is frozen after creation', () => {
    const node = root();

    expect(Object.isFrozen(node)).toBe(true);
    expect(() => {
      (node as unknown as Record<string, unknown>)['depth'] = 9;
    }).toThrow(TypeError);
  });

  it.each([
    ['conceptNodeId', { conceptNodeId: ' ' }, 'CONCEPT_NODE_ID_REQUIRED'],
    ['conceptIdentityId', { conceptIdentityId: '' }, 'CONCEPT_IDENTITY_ID_REQUIRED'],
    ['displayName', { displayName: '  \t ' }, 'DISPLAY_NAME_REQUIRED'],
  ])('rejects an empty %s', (_field, overrides, code) => {
    expect(expectError(ConceptNode.createRoot({ ...rootProps, ...overrides })).code).toBe(code);
  });

  it('normalizes the display name', () => {
    expect(root({ displayName: '  Rotational   Motion ' }).displayName).toBe('Rotational Motion');
  });
});

describe('ConceptNode examWeight range', () => {
  it.each([0, 0.001, 0.5, 1])('accepts %s', (examWeight) => {
    expect(root({ examWeight }).examWeight).toBe(examWeight);
  });

  it.each([-0.0001, -1, 1.0001, 2, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (examWeight) => {
    const error = expectError(ConceptNode.createRoot({ ...rootProps, examWeight }));

    expect(error.code).toBe('EXAM_WEIGHT_OUT_OF_RANGE');
    expect(error.kind).toBe('Validation');
  });

  it('rejects an out-of-range weight on a child node too', () => {
    expect(expectError(ConceptNode.createUnder(root(), { ...childProps, examWeight: 3 })).code).toBe(
      'EXAM_WEIGHT_OUT_OF_RANGE',
    );
  });
});

describe('ConceptNode estimatedTeachingHours', () => {
  it('accepts zero and positive finite values', () => {
    expect(root({ estimatedTeachingHours: 0 }).estimatedTeachingHours).toBe(0);
    expect(root({ estimatedTeachingHours: 12.5 }).estimatedTeachingHours).toBe(12.5);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (estimatedTeachingHours) => {
    expect(expectError(ConceptNode.createRoot({ ...rootProps, estimatedTeachingHours })).code).toBe(
      'ESTIMATED_TEACHING_HOURS_INVALID',
    );
  });
});

describe('ConceptNode depth derivation', () => {
  it('gives a root depth 0', () => {
    expect(root().depth).toBe(0);
  });

  it('derives depth from the parent chain', () => {
    const level0 = root();
    const level1 = child(level0);
    const level2 = expectValue(
      ConceptNode.createUnder(level1, { ...childProps, conceptNodeId: 'cn_kinematics' }),
    );
    const level3 = expectValue(
      ConceptNode.createUnder(level2, { ...childProps, conceptNodeId: 'cn_projectiles' }),
    );

    expect([level0.depth, level1.depth, level2.depth, level3.depth]).toEqual([0, 1, 2, 3]);
  });

  it('cannot be supplied by the caller', () => {
    const node = expectValue(
      ConceptNode.createUnder(root(), { ...childProps, depth: 99 } as CreateConceptNodeProps),
    );

    expect(node.depth).toBe(1);
  });

  it('re-derives depth and parent when moved', () => {
    const level1 = child(root());
    const level2 = expectValue(ConceptNode.createUnder(level1, { ...childProps, conceptNodeId: 'cn_kin' }));
    const moved = level2.moveUnder(root());

    expect(moved.depth).toBe(1);
    expect(moved.parentNodeId).toBe('cn_physics');
    expect(level2.depth).toBe(2);
  });
});
