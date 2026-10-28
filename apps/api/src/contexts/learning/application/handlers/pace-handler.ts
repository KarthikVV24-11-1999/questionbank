import { ROLES } from '../../../../platform/auth/roles.js';
import type { MasteryThresholds } from '../../domain/mastery-rule-set.js';
import { paceAnalytics, type ConceptPace, type SlotPace } from '../../domain/pace-analytics.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, MasteryRuleSetRepository, PaceSlotSource } from '../ports.js';

/**
 * `GetPaceAnalytics` — for one of the caller's attempts, each response's time against its outcome (M7-46, DEC-M7-23, ADR-0054): slow-and-correct, slow-and-wrong, fast,
 * and *not known* where the time was truncated and the line could lie anywhere in what was lost.
 *
 * **The learner is the caller**, as in the rest of the context: there is no learner parameter. The line for "slow" is the rule set's, read per taxonomy version, and the
 * answer names which rule set read it. A taxonomy whose rule set has no pace values (a version published before they existed) is refused and not read against a default
 * written here.
 */
export const GET_PACE_ANALYTICS_POLICY = policy('GetPaceAnalytics', [ROLES.learner]);

export interface PaceAnalyticsView {
  readonly attemptId: string;
  readonly slots: readonly SlotPace[];
  readonly concepts: readonly ConceptPace[];
  /** The rule set that drew the line for each taxonomy version, so a reading can be traced to the numbers it was made under. */
  readonly ruleSets: readonly { readonly taxonomyVersionId: string; readonly ruleSetId: string; readonly thresholdsHash: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class GetPaceAnalyticsHandler {
  readonly name = 'GetPaceAnalytics';
  readonly policy = GET_PACE_ANALYTICS_POLICY;

  constructor(private readonly deps: { readonly slots: PaceSlotSource; readonly ruleSets: MasteryRuleSetRepository }) {}

  async handle(query: { readonly attemptId: string }, context: ApplicationContext): Promise<Result<PaceAnalyticsView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    if (typeof query.attemptId !== 'string' || !UUID.test(query.attemptId)) return err(applicationError('Validation', 'PACE_QUERY_INVALID', 'attemptId is not an identifier'));

    const slots = await this.deps.slots.paceSlotsForAttempt(context.principal.id, query.attemptId);
    if (!slots.ok) return err(slots.error);

    const slotReadings: SlotPace[] = [];
    const conceptReadings: ConceptPace[] = [];
    const ruleSets: { taxonomyVersionId: string; ruleSetId: string; thresholdsHash: string }[] = [];
    for (const taxonomyVersionId of [...new Set(slots.value.map((s) => s.taxonomyVersionId))].sort()) {
      const ruleSet = await this.deps.ruleSets.currentFor(taxonomyVersionId);
      if (!ruleSet.ok) return err(ruleSet.error);
      const pace: MasteryThresholds['pace'] = ruleSet.value.thresholds.pace;
      if (pace === undefined) return err(applicationError('PreconditionFailed', 'PACE_NOT_PUBLISHED', 'the rule set in force for this taxonomy version draws no line for slow'));
      const analytics = paceAnalytics(slots.value.filter((s) => s.taxonomyVersionId === taxonomyVersionId), pace);
      slotReadings.push(...analytics.slots);
      conceptReadings.push(...analytics.concepts);
      ruleSets.push({ taxonomyVersionId, ruleSetId: ruleSet.value.ruleSetId, thresholdsHash: ruleSet.value.thresholdsHash });
    }
    return ok(Object.freeze({ attemptId: query.attemptId, slots: Object.freeze(slotReadings), concepts: Object.freeze(conceptReadings), ruleSets: Object.freeze(ruleSets) }));
  }
}
