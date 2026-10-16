/**
 * Planted violations for `role-rules.spec.ts` (M5-36): the ways a role gets
 * named that the vocabulary exists to stop, beside the one way it does not.
 * `policy` and `ROLES` are local stand-ins, so this file compiles without
 * importing the real ones — the rule reads syntax, not types.
 *
 * Never imported by production code.
 */
const policy = (name: string, roles: readonly unknown[], stepUp = false) => ({ name, roles, stepUp });
const ROLES = { contentOps: 'content_ops', reviewer: 'reviewer' } as const;

// Permitted: a role from the vocabulary. Must NOT be reported.
export const FINE = policy('Fine', [ROLES.contentOps, ROLES.reviewer]);
const FINE_ROLES = [ROLES.contentOps];

// Forbidden: a role written as a string.
export const BARE = policy('Bare', ['content_ops']);

// Forbidden, and worse: not a role at all. A typo, which authorizes nobody and says nothing.
export const TYPO = policy('Typo', ['content_op']);

// Forbidden: a name the vocabulary does not have.
export const UNKNOWN_KEY = policy('UnknownKey', [(ROLES as unknown as { contentOpz: string }).contentOpz]);

// Forbidden: a bare string reached through a constant, which several policies share.
const SHARED = Object.freeze(['reviewer']);
export const THROUGH_A_CONSTANT = policy('ThroughAConstant', SHARED);
export const AND_ANOTHER = policy('AndAnother', [...SHARED, ...FINE_ROLES]);

// Forbidden: a principal built with a bare role, a comparison, and a membership test.
export const PRINCIPAL = { id: 'p', roleContext: ['reviewer'] };
export const isOps = (roleContext: readonly string[]) => roleContext.includes('content_ops');
export const compare = (role: string) => role === 'content_ops';
