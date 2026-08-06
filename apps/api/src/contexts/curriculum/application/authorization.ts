import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../domain/result.js';

/**
 * Policy-based, deny-by-default, evaluated at the handler boundary
 * (BACKEND-ARCHITECTURE §5). Controllers are the wrong place: background jobs
 * and internal callers bypass them.
 */
export interface AuthorizationPolicy {
  readonly name: string;
  readonly allowedRoles: readonly string[];
  /** A standing elevation is the same as no elevation, so publishes ask again. */
  readonly requiresStepUp: boolean;
}

export interface AuthorizationContext {
  readonly principal: PrincipalRef;
  readonly stepUpSatisfied?: boolean;
}

/** The closed error taxonomy (ENGINEERING-HANDBOOK §8). */
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
  readonly detail?: unknown;
}

export function authorizationError(code: string, message: string): ApplicationError {
  return { kind: 'Authorization', code, message };
}

export function policy(
  name: string,
  allowedRoles: readonly string[],
  requiresStepUp = false,
): AuthorizationPolicy {
  return Object.freeze({ name, allowedRoles: Object.freeze([...allowedRoles]), requiresStepUp });
}

/** Deny by default: no matching role means denied, and step-up is not implied. */
export function authorize(
  declared: AuthorizationPolicy,
  context: AuthorizationContext,
): Result<true, ApplicationError> {
  const holdsRole = context.principal.roleContext.some((role) => declared.allowedRoles.includes(role));
  if (!holdsRole) {
    return err(
      authorizationError(
        'NOT_PERMITTED',
        `principal ${context.principal.id} may not run ${declared.name}`,
      ),
    );
  }

  if (declared.requiresStepUp && context.stepUpSatisfied !== true) {
    return err(
      authorizationError(
        'STEP_UP_REQUIRED',
        `${declared.name} requires step-up authorization`,
      ),
    );
  }

  return ok(true);
}
