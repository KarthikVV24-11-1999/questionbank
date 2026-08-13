import { describe, expect, it } from 'vitest';
import type { PrincipalKind, PrincipalRef, RoleSet, UserId } from './index.js';

/**
 * The shared kernel had no test at all until M0-01 gave every workspace
 * package a `test` script — a gap this file closes rather than papering
 * over with `passWithNoTests`. Types have no runtime shape to assert beyond
 * "a value satisfying the contract compiles and holds together", which is
 * what this is.
 */
describe('the shared kernel (Handbook §9 rule 5)', () => {
  it('PrincipalRef holds an id, a kind and a role context together', () => {
    const kinds: readonly PrincipalKind[] = ['human', 'ai_agent', 'system'];
    for (const kind of kinds) {
      const id: UserId = 'user-1';
      const roles: RoleSet = ['author'];
      const principal: PrincipalRef = { kind, id, roleContext: roles };
      expect(principal.kind).toBe(kind);
      expect(principal.id).toBe(id);
      expect(principal.roleContext).toEqual(roles);
    }
  });

  it('PrincipalKind is a closed set — an unlisted kind does not typecheck', () => {
    // @ts-expect-error 'moderator' is not one of the three closed PrincipalKind values.
    const kind: PrincipalKind = 'moderator';
    expect(kind).toBe('moderator');
  });
});
