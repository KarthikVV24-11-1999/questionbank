import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, ConceptReader, EscalatedConcept, ReviewStore, ScheduledConcept } from '../ports.js';
import { DEFAULT_REMEDIATION_LIMIT } from './remediation-handler.js';
import type { Remediation } from './report-handlers.js';

/**
 * `GetReviewPlan` — what the caller has due for review now (M7-47). The learner is the principal and never a field, so there is no way to ask for someone else's plan.
 * **A concept that keeps lapsing is not in `due`; it is in `escalated`** (M7-48, DEC-M7-25), as a finding of the kind the diagnostic report makes, with the targeted practice
 * it escalates to. Concepts, never items: what is due is a concept, and which questions to put in front of the learner for it is assessment's (DEC-M7-1).
 */
export const GET_REVIEW_PLAN_POLICY = policy('GetReviewPlan', [ROLES.learner]);

export interface ReviewPlanView {
  readonly asOf: string;
  /** Most overdue first. */
  readonly due: readonly ScheduledConcept[];
  readonly escalated: readonly EscalationFinding[];
}

export interface EscalationFinding extends EscalatedConcept {
  readonly remediation: Remediation;
}

export class GetReviewPlanHandler {
  readonly name = 'GetReviewPlan';
  readonly policy = GET_REVIEW_PLAN_POLICY;

  constructor(private readonly deps: { readonly reviews: ReviewStore; readonly concepts: ConceptReader; readonly clock: Clock }) {}

  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<ReviewPlanView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const asOf = this.deps.clock.now();
    const due = await this.deps.reviews.due(context.principal.id, asOf);
    if (!due.ok) return err(due.error);
    const escalations = await this.deps.reviews.escalations(context.principal.id);
    if (!escalations.ok) return err(escalations.error);

    const targeted = new Map<string, ReadonlySet<string>>();
    for (const taxonomy of new Set(escalations.value.map((e) => e.taxonomyVersionId))) {
      const weakest = await this.deps.concepts.weakest(context.principal.id, taxonomy, DEFAULT_REMEDIATION_LIMIT);
      if (!weakest.ok) return err(weakest.error);
      targeted.set(taxonomy, new Set(weakest.value));
    }
    const escalated = escalations.value.map((e) =>
      Object.freeze({ ...e, remediation: Object.freeze({ strategy: 'targeted' as const, taxonomyVersionId: e.taxonomyVersionId, conceptIdentityId: e.conceptIdentityId, selected: targeted.get(e.taxonomyVersionId)!.has(e.conceptIdentityId) }) }),
    );
    return ok(Object.freeze({ asOf: asOf.toISOString(), due: due.value, escalated: Object.freeze(escalated) }));
  }
}
