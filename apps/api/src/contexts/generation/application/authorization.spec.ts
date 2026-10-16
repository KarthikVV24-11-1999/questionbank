import { describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { applicationError, authorize, fromGeneration, policy } from './authorization.js';
import { validationError } from '../domain/generation-error.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const principal = (roleContext: readonly string[]): PrincipalRef => ({ id: 'p-1', kind: 'human', roleContext }) as PrincipalRef;

describe('policy', () => {
  it('freezes the policy and its role list, and defaults step-up to off', () => {
    const declared = policy('Do', ['a', 'b']);
    expect(declared).toEqual({ name: 'Do', allowedRoles: ['a', 'b'], requiresStepUp: false });
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.allowedRoles)).toBe(true);
    expect(policy('Do', ['a'], true).requiresStepUp).toBe(true);
  });
});

describe('authorize — deny by default', () => {
  const declared = policy('Do', ['content_ops']);

  it('permits a principal holding an allowed role, among others', () => {
    expect(expectValue(authorize(declared, { principal: principal(['author', 'content_ops']) }))).toBe(true);
  });

  it('refuses a principal holding none, naming who and what', () => {
    const failure = expectError(authorize(declared, { principal: principal(['author']) }));
    expect(failure.kind).toBe('Authorization');
    expect(failure.code).toBe('NOT_PERMITTED');
    expect(failure.message).toContain('p-1');
    expect(failure.message).toContain('Do');
  });

  it('refuses a principal holding no roles at all', () => {
    expect(expectError(authorize(declared, { principal: principal([]) })).code).toBe('NOT_PERMITTED');
  });

  it('refuses a policy that admits nobody', () => {
    expect(expectError(authorize(policy('Nobody', []), { principal: principal(['content_ops']) })).code).toBe(
      'NOT_PERMITTED',
    );
  });

  it('requires step-up where the policy does, and only then', () => {
    const elevated = policy('Elevated', ['content_ops'], true);
    expect(expectError(authorize(elevated, { principal: principal(['content_ops']) })).code).toBe('STEP_UP_REQUIRED');
    expect(
      expectError(authorize(elevated, { principal: principal(['content_ops']), stepUpSatisfied: false })).code,
    ).toBe('STEP_UP_REQUIRED');
    expect(expectValue(authorize(elevated, { principal: principal(['content_ops']), stepUpSatisfied: true }))).toBe(true);
  });

  it('checks the role before the step-up', () => {
    const elevated = policy('Elevated', ['content_ops'], true);
    expect(expectError(authorize(elevated, { principal: principal(['author']), stepUpSatisfied: true })).code).toBe(
      'NOT_PERMITTED',
    );
  });
});

describe('error constructors', () => {
  it('omits location and detail when absent, and carries them when present', () => {
    expect(applicationError('Validation', 'C', 'm')).toEqual({ kind: 'Validation', code: 'C', message: 'm' });
    const full = applicationError('Conflict', 'C', 'm', 'loc', { id: 1 });
    expect(full).toEqual({ kind: 'Conflict', code: 'C', message: 'm', location: 'loc', detail: { id: 1 } });
    expect(Object.isFrozen(full)).toBe(true);
    expect(Object.hasOwn(applicationError('Validation', 'C', 'm'), 'detail')).toBe(false);
  });

  it('carries a domain error across unchanged, location included', () => {
    expect(fromGeneration(validationError('X', 'bad', 'confidence'))).toEqual({
      kind: 'Validation',
      code: 'X',
      message: 'bad',
      location: 'confidence',
    });
    expect(Object.hasOwn(fromGeneration(validationError('X', 'bad')), 'location')).toBe(false);
  });
});
