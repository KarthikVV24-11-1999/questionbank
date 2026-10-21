import { describe, expect, it } from 'vitest';
import { notFoundError } from '../domain/assessment-error.js';
import { applicationError, authorize, fromAssessment, policy } from './authorization.js';
import { HandlerRegistry, DuplicateHandlerError, MissingAuthorizationPolicyError } from './handler-registry.js';

const principal = (...roles: string[]) => ({ kind: 'human' as const, id: '00000000-0000-4000-8000-000000000001', roleContext: roles });

describe('policy and authorize', () => {
  it('admits a role the policy names and refuses one it does not, by name', () => {
    const declared = policy('Thing', ['content_ops']);
    expect(authorize(declared, { principal: principal('content_ops') }).ok).toBe(true);
    const refused = authorize(declared, { principal: principal('learner') });
    expect(refused).toMatchObject({ ok: false, error: { kind: 'Authorization', code: 'NOT_PERMITTED' } });
  });

  it('admits when any one of several roles is held', () => {
    expect(authorize(policy('Thing', ['a', 'b']), { principal: principal('x', 'b') }).ok).toBe(true);
  });

  it('demands step-up only where the policy does, and only a satisfied one counts', () => {
    const guarded = policy('Publish', ['content_ops'], true);
    expect(authorize(guarded, { principal: principal('content_ops') })).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } });
    expect(authorize(guarded, { principal: principal('content_ops'), stepUpSatisfied: false }).ok).toBe(false);
    expect(authorize(guarded, { principal: principal('content_ops'), stepUpSatisfied: true }).ok).toBe(true);
    expect(authorize(policy('Open', ['content_ops']), { principal: principal('content_ops') }).ok).toBe(true);
  });

  it('freezes a policy so its roles cannot be widened after the fact', () => {
    const declared = policy('Thing', ['content_ops']);
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.allowedRoles)).toBe(true);
  });
});

describe('errors', () => {
  it('carries a location and a detail only when given them', () => {
    expect(applicationError('Validation', 'X', 'm')).toEqual({ kind: 'Validation', code: 'X', message: 'm' });
    expect(applicationError('Validation', 'X', 'm', 'field', { a: 1 })).toEqual({ kind: 'Validation', code: 'X', message: 'm', location: 'field', detail: { a: 1 } });
  });

  it('lets a domain error cross unchanged', () => {
    expect(fromAssessment(notFoundError('NOT_FOUND', 'gone', 'form'))).toEqual({ kind: 'NotFound', code: 'NOT_FOUND', message: 'gone', location: 'form' });
  });
});

describe('the registry refuses an unguarded handler (F36)', () => {
  const handler = (name: string, roles: string[]) => ({ name, policy: policy(name, roles), handle: async () => ({ ok: true as const, value: 1 }) });

  it('registers guarded handlers and finds them by name', () => {
    const registry = HandlerRegistry.of([handler('A', ['x']), handler('B', ['y'])] as never);
    expect(registry.names).toEqual(['A', 'B']);
    expect(registry.get('A')?.name).toBe('A');
    expect(registry.get('Z')).toBeUndefined();
  });

  it('refuses a handler with no policy and one whose policy admits no role', () => {
    expect(() => HandlerRegistry.of([{ name: 'Bare', handle: async () => ({ ok: true, value: 1 }) }] as never)).toThrow(MissingAuthorizationPolicyError);
    expect(() => HandlerRegistry.of([handler('Empty', [])] as never)).toThrow(MissingAuthorizationPolicyError);
  });

  it('refuses a name registered twice', () => {
    expect(() => HandlerRegistry.of([handler('A', ['x']), handler('A', ['x'])] as never)).toThrow(DuplicateHandlerError);
  });

  it('says which handler it refused', () => {
    try {
      HandlerRegistry.of([handler('Empty', [])] as never);
    } catch (error) {
      expect((error as Error).message).toContain('Empty');
      expect((error as Error).name).toBe('MissingAuthorizationPolicyError');
    }
    try {
      HandlerRegistry.of([handler('A', ['x']), handler('A', ['x'])] as never);
    } catch (error) {
      expect((error as Error).name).toBe('DuplicateHandlerError');
    }
  });
});
