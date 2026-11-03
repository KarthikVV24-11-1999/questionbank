import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import { conceptsInScope } from '../../domain/learner-profile.js';
import type { ApplicationContext, Clock, ConceptReader, EscalatedConcept, LearnerProfileStore, ReviewStore, ScheduledConcept } from '../ports.js';
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

  constructor(private readonly deps: { readonly reviews: ReviewStore; readonly concepts: ConceptReader; readonly clock: Clock; readonly profiles: LearnerProfileStore }) {}

  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<ReviewPlanView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const asOf = this.deps.clock.now();
    const due = await this.deps.reviews.due(context.principal.id, asOf);
    if (!due.ok) return err(due.error);
    const escalations = await this.deps.reviews.escalations(context.principal.id);
    if (!escalations.ok) return err(escalations.error);

    // The learner's declared scope narrows the plan (M8-21, FR-STU-02 rule 1): a concept outside it, for the taxonomy version it was declared against, is not due and not escalated.
    // No profile, no scope, or another version's scope filters nothing. A skip leaves a scope the learner declared where it was.
    const profile = await this.deps.profiles.find(context.principal.id);
    if (!profile.ok) return err(profile.error);
    const scopeFor = (taxonomyVersionId: string): ReadonlySet<string> | null => (profile.value === null ? null : conceptsInScope(profile.value, taxonomyVersionId));
    const kept = (taxonomyVersionId: string, conceptIdentityId: string): boolean => scopeFor(taxonomyVersionId)?.has(conceptIdentityId) ?? true;
    const dueInScope = due.value.filter((entry) => kept(entry.taxonomyVersionId, entry.conceptIdentityId));
    const escalationsInScope = escalations.value.filter((entry) => kept(entry.taxonomyVersionId, entry.conceptIdentityId));

    const targeted = new Map<string, ReadonlySet<string>>();
    for (const taxonomy of new Set(escalationsInScope.map((e) => e.taxonomyVersionId))) {
      const weakest = await this.deps.concepts.weakest(context.principal.id, taxonomy, DEFAULT_REMEDIATION_LIMIT, scopeFor(taxonomy) ?? undefined);
      if (!weakest.ok) return err(weakest.error);
      targeted.set(taxonomy, new Set(weakest.value));
    }
    const escalated = escalationsInScope.map((e) =>
      Object.freeze({ ...e, remediation: Object.freeze({ strategy: 'targeted' as const, taxonomyVersionId: e.taxonomyVersionId, conceptIdentityId: e.conceptIdentityId, selected: targeted.get(e.taxonomyVersionId)!.has(e.conceptIdentityId) }) }),
    );
    return ok(Object.freeze({ asOf: asOf.toISOString(), due: Object.freeze(dueInScope), escalated: Object.freeze(escalated) }));
  }
}
