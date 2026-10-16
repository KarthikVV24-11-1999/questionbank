import { describe, expect, it } from 'vitest';
import { ok } from '../domain/result.js';
import { policy } from './authorization.js';
import {
  DuplicateHandlerError,
  HandlerRegistry,
  MissingAuthorizationPolicyError,
  type Handler,
} from './handler-registry.js';

function handler(name: string, declared = policy(name, ['content_ops'])): Handler<never, unknown> {
  return { name, policy: declared, async handle() { return ok(undefined); } };
}

describe('F36 — a handler without a policy cannot be registered, so the module cannot boot', () => {
  it('registers handlers that declare a policy, and resolves them by name', () => {
    const registry = HandlerRegistry.of([handler('A'), handler('B')]);
    expect(registry.names).toEqual(['A', 'B']);
    expect(registry.get('A')?.name).toBe('A');
    expect(registry.get('Missing')).toBeUndefined();
  });

  // The planted violations: a handler with no policy, and one whose policy
  // admits nobody. Both are red at registration, which is the only moment
  // that stops them being served.
  it('is red on a handler with no policy at all', () => {
    const planted = { name: 'Unguarded', async handle() { return ok(undefined); } } as unknown as Handler<never, unknown>;
    expect(() => HandlerRegistry.of([handler('A'), planted])).toThrow(MissingAuthorizationPolicyError);
    expect(() => HandlerRegistry.of([planted])).toThrow(/Unguarded declares no authorization policy/u);
  });

  it('is red on a handler whose policy names no role', () => {
    expect(() => HandlerRegistry.of([handler('Roleless', policy('Roleless', []))])).toThrow(
      MissingAuthorizationPolicyError,
    );
  });

  it('is red on the same handler registered twice', () => {
    expect(() => HandlerRegistry.of([handler('A'), handler('A')])).toThrow(DuplicateHandlerError);
    expect(() => HandlerRegistry.of([handler('A'), handler('A')])).toThrow(/A is registered twice/u);
  });

  it('names the errors, so a boot log says which failed', () => {
    expect(new MissingAuthorizationPolicyError('X').name).toBe('MissingAuthorizationPolicyError');
    expect(new DuplicateHandlerError('X').name).toBe('DuplicateHandlerError');
  });
});
