import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../domain/result.js';

/**
 * Policy-based, deny-by-default, evaluated at the handler boundary (BACKEND-ARCHITECTURE §5, §9 rule 6). Declared here rather than imported from
 * another context: a context does not reach into another's application layer (§9 rule 1), and the policy sets are free to diverge.
 */
export interface AuthorizationPolicy {
  readonly name: string;
  readonly allowedRoles: readonly string[];
  /** Publishing a rule set changes what counts as knowing something, so a standing elevation is not enough. */
  readonly requiresStepUp: boolean;
}

export interface AuthorizationContext {
  readonly principal: PrincipalRef;
  readonly stepUpSatisfied?: boolean;
}

export type ApplicationErrorKind =
  | 'Validation'
  | 'Authentication'
  | 'Authorization'
  | 'Entitlement'
  | 'NotFound'
  | 'Conflict'
  | 'PreconditionFailed'
  | 'RuleViolation'
  | 'RateLimited'
  | 'Unavailable';

export interface ApplicationError {
  readonly kind: ApplicationErrorKind;
  readonly code: string;
  readonly message: string;
}

export function applicationError(kind: ApplicationErrorKind, code: string, message: string): ApplicationError {
  return Object.freeze({ kind, code, message });
}

export function policy(name: string, allowedRoles: readonly string[], requiresStepUp = false): AuthorizationPolicy {
  return Object.freeze({ name, allowedRoles: Object.freeze([...allowedRoles]), requiresStepUp });
}

export function authorize(declared: AuthorizationPolicy, context: AuthorizationContext): Result<true, ApplicationError> {
  const holdsRole = context.principal.roleContext.some((role) => declared.allowedRoles.includes(role));
  if (!holdsRole) {
    return err(applicationError('Authorization', 'NOT_PERMITTED', `principal ${context.principal.id} may not run ${declared.name}`));
  }
  if (declared.requiresStepUp && context.stepUpSatisfied !== true) {
    return err(applicationError('Authorization', 'STEP_UP_REQUIRED', `${declared.name} requires step-up authorization`));
  }
  return ok(true);
}
