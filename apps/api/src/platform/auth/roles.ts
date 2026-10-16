/**
 * The role vocabulary (M5-36): every role a policy anywhere in the application
 * may name, in one place.
 *
 * **Why it exists.** Roles were bare strings, written out wherever a policy
 * needed one — 305 occurrences across four contexts, with no list and no check.
 * The failure that allows is silent and specific: a typo yields a role nothing
 * holds, the policy authorizes nobody, and the feature simply does not work for
 * anyone. That fails *closed*, which is correct, and therefore invisible — no
 * test notices unless that exact path is exercised under that exact role.
 *
 * **Closed.** An eleventh role is a reviewed change to `ROLES` below, and the
 * spec holds the set to a literal list so it cannot grow without somebody
 * deciding it should. A policy names a role as `ROLES.contentOps`, never as the
 * string, and `fitness/role-rules.ts` fails the build on a bare string in any
 * policy position — and on a property `ROLES` does not have, which TypeScript
 * would refuse too, but which the rule can be shown to catch in a fixture.
 *
 * **Why platform.** A role is a platform concept; a vocabulary owned by one
 * context would be the wrong context owning it, and the shared kernel is capped
 * at three types without an ADR (`domain-types`). This module is a leaf: it
 * imports nothing, holds no logic, and is the one module of `platform/` a context
 * may import (ADR-0026).
 *
 * **What it does not do.** It does not say what any role may do — that is each
 * context's policy — and it does not validate a token's roles claim, which would
 * change what a token is accepted for. Both are separate decisions.
 *
 * Scoped entries (`subject:physics`) narrow a role; they are not roles and are
 * not here.
 */

export const ROLES = {
  author: 'author',
  reviewer: 'reviewer',
  contentOps: 'content_ops',
  learner: 'learner',
  /** An unauthenticated visitor, admitted only to content's published delivery reads. */
  guest: 'guest',
  curriculumCurator: 'curriculum_curator',
  examOwner: 'exam_owner',
  /** The machine that proposes and checks generated content; it holds no capability to decide (INV-01). */
  generationPipeline: 'generation_pipeline',
  /** Scoring's operator. Distinct from `content_ops`, which is content's. */
  ops: 'ops',
  admin: 'admin',
  system: 'system',
} as const;

export type RoleKey = keyof typeof ROLES;
export type Role = (typeof ROLES)[RoleKey];

export const ROLE_KEYS = Object.freeze(Object.keys(ROLES) as RoleKey[]);
export const ROLE_VALUES: readonly Role[] = Object.freeze(Object.values(ROLES));

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}
