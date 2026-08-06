import { describe, expect, it } from 'vitest';
import { PrerequisiteEdge, type CreatePrerequisiteEdgeProps } from './prerequisite-edge.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const validProps: CreatePrerequisiteEdgeProps = {
  fromConceptIdentityId: 'ci_vectors',
  toConceptIdentityId: 'ci_kinematics',
  strength: 0.8,
};

function edge(overrides: Partial<CreatePrerequisiteEdgeProps> = {}): PrerequisiteEdge {
  return expectValue(PrerequisiteEdge.create({ ...validProps, ...overrides }));
}

describe('PrerequisiteEdge construction', () => {
  it('carries the from and to concept identities and the strength', () => {
    const created = edge();

    expect(created.fromConceptIdentityId).toBe('ci_vectors');
    expect(created.toConceptIdentityId).toBe('ci_kinematics');
    expect(created.strength).toBe(0.8);
  });

  it('is frozen after creation', () => {
    const created = edge();

    expect(Object.isFrozen(created)).toBe(true);
    expect(() => {
      (created as unknown as Record<string, unknown>)['strength'] = 0.1;
    }).toThrow(TypeError);
  });

  it.each([
    ['from', { fromConceptIdentityId: '  ' }, 'FROM_CONCEPT_IDENTITY_ID_REQUIRED'],
    ['to', { toConceptIdentityId: '' }, 'TO_CONCEPT_IDENTITY_ID_REQUIRED'],
  ])('rejects an empty %s concept identity', (_side, overrides, code) => {
    expect(expectError(PrerequisiteEdge.create({ ...validProps, ...overrides })).code).toBe(code);
  });
});

describe('PrerequisiteEdge strength range', () => {
  it.each([0, 0.5, 1])('accepts %s', (strength) => {
    expect(edge({ strength }).strength).toBe(strength);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (strength) => {
    const error = expectError(PrerequisiteEdge.create({ ...validProps, strength }));

    expect(error.code).toBe('STRENGTH_OUT_OF_RANGE');
    expect(error.kind).toBe('Validation');
  });
});

describe('PrerequisiteEdge self-reference', () => {
  it('rejects an edge from a concept to itself', () => {
    const error = expectError(
      PrerequisiteEdge.create({ ...validProps, toConceptIdentityId: 'ci_vectors' }),
    );

    expect(error.code).toBe('SELF_REFERENCING_EDGE');
    expect(error.message).toContain('ci_vectors');
  });

  it('rejects a self-edge that differs only by surrounding whitespace', () => {
    expect(
      expectError(
        PrerequisiteEdge.create({ ...validProps, toConceptIdentityId: '  ci_vectors  ' }),
      ).code,
    ).toBe('SELF_REFERENCING_EDGE');
  });
});
