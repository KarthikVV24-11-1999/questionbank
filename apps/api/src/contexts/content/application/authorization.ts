import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../domain/result.js';

/**
 * Policy-based, deny-by-default, evaluated at the handler boundary
 * (BACKEND-ARCHITECTURE §5, §9 rule 6).
 *
 * Declared here rather than imported from scoring or curriculum — a context
 * does not reach into another's application layer (§9 rule 1), and the three
 * policy sets are free to diverge. Content's already does: it needs an
 * ownership rule on top of the role check, because FR-TCH-06 rule 1 scopes a
 * draft to the person who wrote it and not merely to the role that may write
 * drafts at all.
 */

export interface AuthorizationPolicy {
  readonly name: string;
  readonly allowedRoles: readonly string[];
  /** Publication changes what students see, so a standing elevation is not enough. */
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
  /**
   * Carried through from the domain (M3-01). An author who cannot find the
   * problem submits nothing (UX §10.1), and the handler is the last place that
   * knowledge exists before the error becomes a Problem Details body.
   */
  readonly location?: string;
  /**
   * Structured detail a client can branch on — the publication precondition
   * list, for instance, which the Studio validation panel groups by code
   * rather than by string-matching a message.
   */
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
      applicationError(
        'Authorization',
        'NOT_PERMITTED',
        `principal ${context.principal.id} may not run ${declared.name}`,
      ),
    );
  }
  if (declared.requiresStepUp && context.stepUpSatisfied !== true) {
    return err(
      applicationError('Authorization', 'STEP_UP_REQUIRED', `${declared.name} requires step-up authorization`),
    );
  }
  return ok(true);
}

/**
 * The roles that see somebody else's draft (FR-TCH-06 rule 1).
 *
 * Deliberately just Content Ops. `admin` is not on the list: platform
 * administration is not content oversight, and the whole value of rule 1 is
 * that an unfinished item is not circulating. Widening this is a reviewed
 * change to a named constant, not an inference.
 */
export const DRAFT_OVERSIGHT_ROLES = Object.freeze(['content_ops']);

/**
 * How a subject scope is carried on a principal.
 *
 * SECURITY-ARCHITECTURE §4: "roles are additive; scope narrows them (subject,
 * tenant, ownership)". Author and Reviewer are marked scoped in that matrix,
 * Content Ops is not — so a scope entry narrows an authoring role rather than
 * granting one, and holding `subject:physics` without `author` still permits
 * nothing.
 */
export const SUBJECT_SCOPE_PREFIX = 'subject:';

/** Roles whose content capability is unscoped in SECURITY-ARCHITECTURE §4. */
export const CROSS_SUBJECT_ROLES = Object.freeze(['content_ops']);

export function subjectScopesOf(context: AuthorizationContext): readonly string[] {
  return context.principal.roleContext
    .filter((role) => role.startsWith(SUBJECT_SCOPE_PREFIX))
    .map((role) => role.slice(SUBJECT_SCOPE_PREFIX.length));
}

/**
 * FR-TCH-01 rule 1 — a Chemistry author cannot author Physics content.
 *
 * The subject is **declared on the command**, because nothing in the content
 * model records the subject of a passage or an explanation: a stimulus carries
 * a body and a licence, and concept tags name identities that only Curriculum
 * can resolve to a subject domain. So this refuses a principal reaching outside
 * their scope; it does not detect an in-scope author who mistags their own work
 * (debt D23).
 */
export function authorizeSubjectScope(
  subject: string,
  context: AuthorizationContext,
): Result<true, ApplicationError> {
  if (subject.trim().length === 0) {
    return err(
      applicationError('Validation', 'SUBJECT_REQUIRED', 'authoring names the subject it is scoped to', 'subject'),
    );
  }
  if (context.principal.roleContext.some((role) => CROSS_SUBJECT_ROLES.includes(role))) return ok(true);
  if (subjectScopesOf(context).includes(subject)) return ok(true);
  return err(
    applicationError(
      'Authorization',
      'OUT_OF_SUBJECT_SCOPE',
      `principal ${context.principal.id} is not scoped to author ${subject} content (FR-TCH-01 rule 1)`,
      'subject',
    ),
  );
}

/**
 * FR-TCH-01 rule 1, resolved rather than merely declared (M4-14, DEC-M4-8).
 *
 * For a subject-scoped author, their scope **is** the subject of everything
 * they author — a Physics-scoped principal has no legitimate reason to
 * declare anything else, and letting them declare a *different* subject is
 * exactly the mistagging D23 says nothing catches. So:
 *
 *   - **Exactly one `subject:<name>` scope**: the subject is derived from it.
 *     A declaration that agrees is redundant and ignored; one that disagrees
 *     is refused — the principal cannot talk their way out of their own
 *     scope.
 *   - **Unscoped (Content Ops) or scoped to more than one subject**: nothing
 *     can be derived unambiguously, so the command must declare it, and the
 *     declaration is authorized the existing way, through
 *     `authorizeSubjectScope`.
 *   - **Neither derivable nor declared**: refused as `Validation`, located —
 *     this is a missing input, not an authorization failure.
 *
 * This closes the creation-time half of D23 (an in-scope author cannot
 * mistype their own subject); it does not close the half `authorizeSubjectScope`
 * never closed either — nothing here cross-checks a resolved or declared
 * subject against the content itself, which needs a concept → subject-domain
 * lookup Curriculum does not expose yet.
 */
export function resolveAuthoringSubject(
  declared: string | undefined,
  context: AuthorizationContext,
): Result<string, ApplicationError> {
  const scopes = subjectScopesOf(context);

  if (scopes.length === 1) {
    const derived = scopes[0] as string;
    if (declared !== undefined && declared.trim().length > 0 && declared !== derived) {
      return err(
        applicationError(
          'Validation',
          'SUBJECT_DISAGREES_WITH_SCOPE',
          `principal ${context.principal.id} is scoped to ${derived}; the command declared ${declared}`,
          'subject',
        ),
      );
    }
    return ok(derived);
  }

  if (declared === undefined || declared.trim().length === 0) {
    return err(
      applicationError(
        'Validation',
        'SUBJECT_REQUIRED',
        'authoring names the subject it is scoped to (FR-TCH-01 rule 1)',
        'subject',
      ),
    );
  }

  const scoped = authorizeSubjectScope(declared, context);
  if (!scoped.ok) return err(scoped.error);
  return ok(declared);
}

/**
 * The ownership half of draft access. The role check says "may act on drafts";
 * this says "may act on *this* draft".
 *
 * Refusal is `Authorization`, never an empty result — an empty result reads as
 * "no such item" and teaches the author that their colleague's work does not
 * exist rather than that it is not theirs.
 */
export function authorizeDraftAccess(
  authorId: string,
  context: AuthorizationContext,
): Result<true, ApplicationError> {
  if (context.principal.id === authorId) return ok(true);
  if (context.principal.roleContext.some((role) => DRAFT_OVERSIGHT_ROLES.includes(role))) return ok(true);
  return err(
    applicationError(
      'Authorization',
      'NOT_THE_DRAFT_OWNER',
      `principal ${context.principal.id} may not reach a draft authored by ${authorId} (FR-TCH-06 rule 1)`,
      'itemId',
    ),
  );
}
