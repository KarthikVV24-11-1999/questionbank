/**
 * Planted violations for `role-rules.spec.ts` (M8-12): the ways a role is given to a person, beside the ways that are fine. `ROLES` and the functions are local stand-ins; the rule
 * reads syntax, not types. Never imported by production code.
 */
const ROLES = { author: 'author', learner: 'learner' } as const;
declare function assignRole(email: string, role: unknown): void;
declare function grantRole(email: string, role: unknown): void;
declare function revokeRole(email: string, role: unknown): void;
declare function addRoles(email: string, role: unknown): void;
declare const roles: { removeRole(email: string, role: unknown): void };
declare const held: { roles: string[]; push(role: string): void };
declare const found: { user: { roles: string[] } };

// Permitted: the vocabulary, a value passed through, and a call that is not about roles.
export const FINE_PROPERTY = { roles: [ROLES.learner] };
export const FINE_PASSED_THROUGH = { roles: found.user.roles };
export const FINE_CALL = assignRole('a@example.com', ROLES.author);
export const FINE_ROLE_ITEM = { role: ROLES.author };

// Forbidden: a role written as a string where one is given to a person.
export const BARE_PROPERTY = { roles: ['author'] };
export const BARE_SINGLE_PROPERTY = { role: 'author' };
export const TYPO_PROPERTY = { assignableRoles: ['autor'] };
export const BARE_CALL = assignRole('a@example.com', 'author');
export const BARE_METHOD = roles.removeRole('a@example.com', 'learner');
export const UNKNOWN_IN_CALL = assignRole('a@example.com', (ROLES as unknown as { authro: string }).authro);
export const BARE_PUSH = held.roles.push('author');
export const BARE_ALLOWED = { allowedRoles: ['author'] };
export const BARE_DEFAULT = { defaultRoles: ['learner'] };
export const BARE_GRANT = grantRole('a@example.com', 'author');
export const BARE_REVOKE = revokeRole('a@example.com', 'author');
export const BARE_ADD = addRoles('a@example.com', 'author');
