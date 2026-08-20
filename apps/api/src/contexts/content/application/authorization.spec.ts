import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { resolveAuthoringSubject, type AuthorizationContext } from './authorization.js';

function principal(roleContext: readonly string[]): PrincipalRef {
  return { kind: 'human', id: 'principal-1', roleContext };
}

function ctx(roleContext: readonly string[]): AuthorizationContext {
  return { principal: principal(roleContext) };
}

describe('resolveAuthoringSubject — FR-TCH-01 rule 1, resolved rather than declared (M4-14)', () => {
  it('derives the subject from a single subject scope, no declaration needed', () => {
    const resolved = expectValue(resolveAuthoringSubject(undefined, ctx(['author', 'subject:physics'])));
    expect(resolved).toBe('physics');
  });

  it('ignores a declaration that agrees with the single scope', () => {
    const resolved = expectValue(resolveAuthoringSubject('physics', ctx(['author', 'subject:physics'])));
    expect(resolved).toBe('physics');
  });

  it('refuses a declaration that disagrees with the single scope', () => {
    const error = expectError(resolveAuthoringSubject('chemistry', ctx(['author', 'subject:physics'])));
    expect(error.code).toBe('SUBJECT_DISAGREES_WITH_SCOPE');
    expect(error.kind).toBe('Validation');
    expect(error.location).toBe('subject');
  });

  it('requires a declaration when the principal is unscoped (Content Ops)', () => {
    const error = expectError(resolveAuthoringSubject(undefined, ctx(['content_ops'])));
    expect(error.code).toBe('SUBJECT_REQUIRED');
  });

  it('authorizes an unscoped principal’s declaration unconditionally (cross-subject role)', () => {
    const resolved = expectValue(resolveAuthoringSubject('physics', ctx(['content_ops'])));
    expect(resolved).toBe('physics');
  });

  it('requires a declaration when the principal holds several subject scopes', () => {
    const error = expectError(
      resolveAuthoringSubject(undefined, ctx(['author', 'subject:physics', 'subject:chemistry'])),
    );
    expect(error.code).toBe('SUBJECT_REQUIRED');
  });

  it('authorizes a multiply-scoped principal’s declaration against the held scopes', () => {
    const resolved = expectValue(
      resolveAuthoringSubject('chemistry', ctx(['author', 'subject:physics', 'subject:chemistry'])),
    );
    expect(resolved).toBe('chemistry');
  });

  it('refuses a multiply-scoped principal declaring a subject they do not hold', () => {
    const error = expectError(
      resolveAuthoringSubject('biology', ctx(['author', 'subject:physics', 'subject:chemistry'])),
    );
    expect(error.code).toBe('OUT_OF_SUBJECT_SCOPE');
  });

  it('refuses a principal with no subject scope at all and no declaration', () => {
    const error = expectError(resolveAuthoringSubject(undefined, ctx(['author'])));
    expect(error.code).toBe('SUBJECT_REQUIRED');
  });

  it('refuses a principal with no subject scope at all declaring one anyway', () => {
    const error = expectError(resolveAuthoringSubject('physics', ctx(['author'])));
    expect(error.code).toBe('OUT_OF_SUBJECT_SCOPE');
  });

  it('treats a blank declaration the same as an absent one, against a single scope', () => {
    const resolved = expectValue(resolveAuthoringSubject('   ', ctx(['author', 'subject:physics'])));
    expect(resolved).toBe('physics');
  });

  it('treats a blank declaration the same as an absent one, when a declaration is required', () => {
    const error = expectError(resolveAuthoringSubject('   ', ctx(['content_ops'])));
    expect(error.code).toBe('SUBJECT_REQUIRED');
  });
});
