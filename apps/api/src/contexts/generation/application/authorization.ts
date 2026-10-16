import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../domain/result.js';
import type { GenerationError } from '../domain/generation-error.js';

/**
 * Policy-based, deny-by-default, evaluated at the handler boundary
 * (BACKEND-ARCHITECTURE §5, §9 rule 6). Controllers are the wrong place: the
 * pre-check battery is a background caller that never passes through one.
 *
 * Declared here rather than imported from content or scoring — a context does
 * not reach into another's application layer (§9 rule 1), and the policy sets
 * are free to diverge.
 */
export interface AuthorizationPolicy {
  readonly name: string;
  readonly allowedRoles: readonly string[];
  /** None of generation's acts needs a standing elevation to be re-proven; publication is content's. */
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
  /** Carried through from the domain, so an operator is told which field to look at. */
  readonly location?: string;
  /** Structured detail a caller can act on — the content item an interrupted acceptance left behind, for instance. */
  readonly detail?: unknown;
}

export function applicationError(
  kind: ApplicationErrorKind,
  code: string,
  message: string,
  location?: string,
  detail?: unknown,
): ApplicationError {
  return Object.freeze({
    kind,
    code,
    message,
    ...(location === undefined ? {} : { location }),
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Domain and repository failures cross into the application taxonomy unchanged. */
export function fromGeneration(error: GenerationError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export function policy(
  name: string,
  allowedRoles: readonly string[],
  requiresStepUp = false,
): AuthorizationPolicy {
  return Object.freeze({ name, allowedRoles: Object.freeze([...allowedRoles]), requiresStepUp });
}

export function authorize(
  declared: AuthorizationPolicy,
  context: AuthorizationContext,
): Result<true, ApplicationError> {
  const holdsRole = context.principal.roleContext.some((role) => declared.allowedRoles.includes(role));
  if (!holdsRole) {
    return err(
      applicationError('Authorization', 'NOT_PERMITTED', `principal ${context.principal.id} may not run ${declared.name}`),
    );
  }
  if (declared.requiresStepUp && context.stepUpSatisfied !== true) {
    return err(
      applicationError('Authorization', 'STEP_UP_REQUIRED', `${declared.name} requires step-up authorization`),
    );
  }
  return ok(true);
}
