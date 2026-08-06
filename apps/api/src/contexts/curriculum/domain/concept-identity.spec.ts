import { describe, expect, it } from 'vitest';
import { ConceptIdentity, type CreateConceptIdentityProps } from './concept-identity.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const validProps: CreateConceptIdentityProps = {
  conceptIdentityId: 'ci_rotational_motion',
  canonicalName: 'Rotational Motion',
  subjectDomain: 'physics',
  createdInVersion: 'tv_2026_jee_main',
};

function createValid(overrides: Partial<CreateConceptIdentityProps> = {}): ConceptIdentity {
  return expectValue(ConceptIdentity.create({ ...validProps, ...overrides }));
}

describe('ConceptIdentity construction', () => {
  it('holds the identity, canonical name, subject domain and creating version', () => {
    const identity = createValid();

    expect(identity.conceptIdentityId).toBe('ci_rotational_motion');
    expect(identity.canonicalName).toBe('Rotational Motion');
    expect(identity.subjectDomain).toBe('physics');
    expect(identity.createdInVersion).toBe('tv_2026_jee_main');
  });

  it('is not superseded when created', () => {
    const identity = createValid();

    expect(identity.supersededBy).toBeUndefined();
    expect(identity.isSuperseded).toBe(false);
  });

  it.each([
    ['conceptIdentityId', { conceptIdentityId: '' }, 'CONCEPT_IDENTITY_ID_REQUIRED'],
    ['conceptIdentityId of blanks', { conceptIdentityId: '   ' }, 'CONCEPT_IDENTITY_ID_REQUIRED'],
    ['canonicalName', { canonicalName: '' }, 'CANONICAL_NAME_REQUIRED'],
    ['canonicalName of whitespace only', { canonicalName: ' \t\n ' }, 'CANONICAL_NAME_REQUIRED'],
    ['subjectDomain', { subjectDomain: '' }, 'SUBJECT_DOMAIN_REQUIRED'],
    ['subjectDomain of blanks', { subjectDomain: '  ' }, 'SUBJECT_DOMAIN_REQUIRED'],
    ['createdInVersion', { createdInVersion: '' }, 'CREATED_IN_VERSION_REQUIRED'],
    ['createdInVersion of blanks', { createdInVersion: '  ' }, 'CREATED_IN_VERSION_REQUIRED'],
  ])('rejects an empty %s', (_field, overrides, code) => {
    const error = expectError(ConceptIdentity.create({ ...validProps, ...overrides }));

    expect(error.code).toBe(code);
    expect(error.kind).toBe('Validation');
  });

  it('reports failure as a value rather than throwing', () => {
    expect(() => ConceptIdentity.create({ ...validProps, canonicalName: '' })).not.toThrow();
  });
});

describe('ConceptIdentity canonical name normalization', () => {
  it.each([
    ['  Rotational Motion  ', 'Rotational Motion'],
    ['Rotational    Motion', 'Rotational Motion'],
    ['Rotational\tMotion', 'Rotational Motion'],
    ['Rotational\n  Motion', 'Rotational Motion'],
    ['\t Laws  of \n Motion \t', 'Laws of Motion'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(createValid({ canonicalName: raw }).canonicalName).toBe(expected);
  });

  it('treats names differing only in whitespace as the same canonical name', () => {
    const spaced = createValid({ canonicalName: ' Laws   of Motion ' });
    const tabbed = createValid({ canonicalName: 'Laws\tof\tMotion' });

    expect(spaced.canonicalName).toBe(tabbed.canonicalName);
  });

  it('preserves internal casing and punctuation', () => {
    expect(createValid({ canonicalName: "Newton's  Second Law (F=ma)" }).canonicalName).toBe(
      "Newton's Second Law (F=ma)",
    );
  });

  it('trims the subject domain', () => {
    expect(createValid({ subjectDomain: '  physics ' }).subjectDomain).toBe('physics');
  });
});

describe('ConceptIdentity immutability', () => {
  it('is frozen after creation', () => {
    expect(Object.isFrozen(createValid())).toBe(true);
  });

  it.each(['conceptIdentityId', 'canonicalName', 'subjectDomain', 'createdInVersion', 'supersededBy'])(
    'rejects reassignment of %s',
    (field) => {
      const identity = createValid();
      const mutable = identity as unknown as Record<string, unknown>;

      expect(() => {
        mutable[field] = 'tampered';
      }).toThrow(TypeError);
      expect(mutable[field]).not.toBe('tampered');
    },
  );

  it('rejects the addition of new properties', () => {
    const identity = createValid();

    expect(() => {
      (identity as unknown as Record<string, unknown>)['examWeight'] = 1;
    }).toThrow(TypeError);
  });

  it('rejects deletion of a property', () => {
    const identity = createValid();

    expect(() => {
      delete (identity as unknown as Record<string, unknown>)['canonicalName'];
    }).toThrow(TypeError);
  });
});

describe('ConceptIdentity supersession', () => {
  it('records the superseding identity on a new instance', () => {
    const identity = createValid();

    const superseded = expectValue(identity.supersede('ci_rigid_body_dynamics'));

    expect(superseded.supersededBy).toBe('ci_rigid_body_dynamics');
    expect(superseded.isSuperseded).toBe(true);
    expect(Object.isFrozen(superseded)).toBe(true);
  });

  it('carries every other field through unchanged', () => {
    const identity = createValid();

    const superseded = expectValue(identity.supersede('ci_rigid_body_dynamics'));

    expect(superseded.conceptIdentityId).toBe(identity.conceptIdentityId);
    expect(superseded.canonicalName).toBe(identity.canonicalName);
    expect(superseded.subjectDomain).toBe(identity.subjectDomain);
    expect(superseded.createdInVersion).toBe(identity.createdInVersion);
  });

  it('leaves the original instance unsuperseded', () => {
    const identity = createValid();

    expectValue(identity.supersede('ci_rigid_body_dynamics'));

    expect(identity.supersededBy).toBeUndefined();
    expect(identity.isSuperseded).toBe(false);
  });

  it('rejects a second supersession', () => {
    const superseded = expectValue(createValid().supersede('ci_rigid_body_dynamics'));

    const error = expectError(superseded.supersede('ci_angular_momentum'));

    expect(error.code).toBe('ALREADY_SUPERSEDED');
    expect(error.kind).toBe('RuleViolation');
    expect(superseded.supersededBy).toBe('ci_rigid_body_dynamics');
  });

  it('rejects re-supersession by the same identity it was superseded by', () => {
    const superseded = expectValue(createValid().supersede('ci_rigid_body_dynamics'));

    expect(expectError(superseded.supersede('ci_rigid_body_dynamics')).code).toBe('ALREADY_SUPERSEDED');
  });

  it('rejects self-supersession', () => {
    const identity = createValid();

    const error = expectError(identity.supersede(identity.conceptIdentityId));

    expect(error.code).toBe('SELF_SUPERSESSION');
    expect(error.kind).toBe('RuleViolation');
  });

  it('rejects an empty superseding identity', () => {
    const error = expectError(createValid().supersede('   '));

    expect(error.code).toBe('CONCEPT_IDENTITY_ID_REQUIRED');
    expect(error.kind).toBe('Validation');
  });
});
