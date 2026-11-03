import { ROLES } from '../../../../platform/auth/roles.js';
import { normalizeEmail } from '../../domain/email.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, RoleOperation, RoleStore } from '../ports.js';

/**
 * Giving a person a role, and taking it away (M8-12, closes D96 in docs/DEBT.md), and making the first administrator.
 *
 * **Who.** `admin`, alone. The policy names no other role, and the spec holds it to that.
 *
 * **What.** The roles a person can hold: the human ones. `guest` is what nobody has logged in is, and `system` and `generation_pipeline` are machines; none of them is assigned to a
 * person, so the command refuses them as it refuses a word that is not a role. Taking a person's last role is refused (the table requires one), and so is taking the last enabled
 * `admin`: the one change that leaves nobody able to make another. Nobody changes their own roles (docs/SECURITY-ARCHITECTURE.md §4: no role can alter its own role set), so a stolen
 * session cannot widen its own reach; it needs a second administrator.
 *
 * **When it takes effect.** At the person's next request. A session does not carry the roles it was made with; `SessionAuthenticator` reads the user on every request, so a revoked
 * `admin` acts as one for no longer than the request in flight when it was revoked (DEC-M8-5 in docs/IMPLEMENTATION-DECISIONS.md).
 *
 * **What it tells the caller.** Whether the address is registered: an administrator who names an unknown address is told so. That is the opposite of DEC-M8-2, which is about a
 * stranger, and the caller here has been authenticated and holds the role that may ask.
 *
 * Every change that changes something is audited, naming the person and the role; one that changes nothing (a role already held) is not.
 */
export const ASSIGN_ROLE_POLICY = policy('AssignRole', [ROLES.admin]);
export const REMOVE_ROLE_POLICY = policy('RemoveRole', [ROLES.admin]);
export const BOOTSTRAP_ADMIN_POLICY = policy('BootstrapFirstAdmin', [ROLES.system]);

/** The roles a person can hold. */
export const ASSIGNABLE_ROLES: readonly string[] = Object.freeze([ROLES.learner, ROLES.author, ROLES.reviewer, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.ops, ROLES.admin]);

const isAssignable = (value: unknown): value is string => typeof value === 'string' && ASSIGNABLE_ROLES.includes(value);

interface Deps {
  readonly roles: RoleStore;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

export interface RoleChanged {
  readonly userId: string;
  readonly roles: readonly string[];
  readonly changed: boolean;
}

async function change(deps: Deps, operation: RoleOperation, command: { readonly email: unknown; readonly role: unknown }, context: ApplicationContext, declared: typeof ASSIGN_ROLE_POLICY): Promise<Result<RoleChanged, ApplicationError>> {
  const permitted = authorize(declared, context);
  if (!permitted.ok) return err(permitted.error);
  const email = normalizeEmail(command.email);
  if (!email.ok) return err(applicationError('Validation', email.error, 'That is not an email address.'));
  if (!isAssignable(command.role)) return err(applicationError('Validation', 'ROLE_NOT_ASSIGNABLE', 'That is not a role a person can hold.'));

  const outcome = await deps.roles.change({ actorId: context.principal.id, email: email.value, role: command.role, operation });
  switch (outcome.status) {
    case 'not_found':
      return err(applicationError('NotFound', 'USER_NOT_FOUND', 'There is no one with that address.'));
    case 'self':
      return err(applicationError('RuleViolation', 'OWN_ROLES', 'Your own roles are changed by another administrator.'));
    case 'last_role':
      return err(applicationError('RuleViolation', 'LAST_ROLE', 'A person must keep at least one role.'));
    case 'last_admin':
      return err(applicationError('RuleViolation', 'LAST_ADMIN', 'The last administrator cannot be removed.'));
    case 'unchanged':
      return ok({ userId: outcome.userId, roles: outcome.roles, changed: false });
    case 'changed':
      await deps.audit.record({
        principal: context.principal,
        action: operation === 'assign' ? 'RoleAssigned' : 'RoleRemoved',
        targetContext: 'identity',
        targetType: 'UserRole',
        targetId: `${outcome.userId}:${command.role}`,
        correlationId: context.correlationId,
        occurredAt: deps.clock.now(),
      });
      return ok({ userId: outcome.userId, roles: outcome.roles, changed: true });
  }
}

export class AssignRoleHandler {
  readonly name = 'AssignRole';
  readonly policy = ASSIGN_ROLE_POLICY;

  constructor(private readonly deps: Deps) {}

  handle(command: { readonly email: unknown; readonly role: unknown }, context: ApplicationContext): Promise<Result<RoleChanged, ApplicationError>> {
    return change(this.deps, 'assign', command, context, this.policy);
  }
}

export class RemoveRoleHandler {
  readonly name = 'RemoveRole';
  readonly policy = REMOVE_ROLE_POLICY;

  constructor(private readonly deps: Deps) {}

  handle(command: { readonly email: unknown; readonly role: unknown }, context: ApplicationContext): Promise<Result<RoleChanged, ApplicationError>> {
    return change(this.deps, 'remove', command, context, this.policy);
  }
}

/**
 * The first administrator. By definition nobody can make one, so this is not a route: it is a command an operator runs with access to the database (`bootstrap-admin.ts`), acting as
 * `system`, and it does exactly one thing. It makes a registered person with a verified address an `admin` if no enabled admin exists, and refuses otherwise, so running it again
 * later, or running it by mistake on a live system, changes nothing. Nothing reaches it over HTTP.
 */
export class BootstrapFirstAdminHandler {
  readonly name = 'BootstrapFirstAdmin';
  readonly policy = BOOTSTRAP_ADMIN_POLICY;

  constructor(private readonly deps: Deps) {}

  async handle(command: { readonly email: unknown }, context: ApplicationContext): Promise<Result<{ readonly userId: string }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const email = normalizeEmail(command.email);
    if (!email.ok) return err(applicationError('Validation', email.error, 'That is not an email address.'));
    const outcome = await this.deps.roles.grantFirstAdmin(email.value);
    switch (outcome.status) {
      case 'not_found':
        return err(applicationError('NotFound', 'USER_NOT_FOUND', 'There is no one with that address; register it first.'));
      case 'not_verified':
        return err(applicationError('RuleViolation', 'EMAIL_NOT_VERIFIED', 'That address is not verified yet.'));
      case 'admin_exists':
        return err(applicationError('RuleViolation', 'ADMIN_EXISTS', 'There is already an administrator; roles are assigned by one.'));
      case 'granted':
        await this.deps.audit.record({ principal: context.principal, action: 'FirstAdminGranted', targetContext: 'identity', targetType: 'UserRole', targetId: `${outcome.userId}:${ROLES.admin}`, correlationId: context.correlationId, occurredAt: this.deps.clock.now() });
        return ok({ userId: outcome.userId });
    }
  }
}
