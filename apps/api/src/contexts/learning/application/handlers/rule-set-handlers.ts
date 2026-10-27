import { ROLES } from '../../../../platform/auth/roles.js';
import { validateThresholds, hashThresholds, type MasteryRuleSet } from '../../domain/mastery-rule-set.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory, MasteryRuleSetRepository } from '../ports.js';

/**
 * `PublishMasteryRuleSet` — the next version of a scope's thresholds (M7-12). Changing what counts as knowing something is a consequential act, so it is
 * an administrator's, behind step-up, and audited; and it is a *new version*, never an edit, so every transition keeps the thresholds it was decided
 * under. There is no route: the surface for it is a later track's.
 */
export const PUBLISH_MASTERY_RULE_SET_POLICY = policy('PublishMasteryRuleSet', [ROLES.admin], true);

export interface PublishMasteryRuleSet {
  /** The taxonomy version the thresholds apply to; `null` publishes the platform default. */
  readonly taxonomyVersionId: string | null;
  readonly thresholds: unknown;
}

export interface PublishMasteryRuleSetDependencies {
  readonly ruleSets: MasteryRuleSetRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

export class PublishMasteryRuleSetHandler {
  readonly name = 'PublishMasteryRuleSet';
  readonly policy = PUBLISH_MASTERY_RULE_SET_POLICY;

  constructor(private readonly deps: PublishMasteryRuleSetDependencies) {}

  async handle(command: PublishMasteryRuleSet, context: ApplicationContext): Promise<Result<MasteryRuleSet, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const thresholds = validateThresholds(command.thresholds);
    if (!thresholds.ok) return err(applicationError(thresholds.error.kind, thresholds.error.code, thresholds.error.message));

    const saved = await this.deps.ruleSets.append({
      ruleSetId: this.deps.identifiers.next(),
      taxonomyVersionId: command.taxonomyVersionId,
      thresholds: thresholds.value,
      thresholdsHash: hashThresholds(thresholds.value),
      principal: context.principal,
      createdAt: this.deps.clock.now(),
    });
    if (!saved.ok) return err(saved.error);

    await this.deps.audit.record({
      principal: context.principal,
      action: 'PublishMasteryRuleSet',
      targetContext: 'learning',
      targetType: 'MasteryRuleSet',
      targetId: saved.value.ruleSetId,
      targetVersion: saved.value.versionNo,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(saved.value);
  }
}
