import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, ConceptReader } from '../ports.js';

/**
 * `SuggestRemediationConcepts` — what a remediation run should be about, as concepts and nothing else (M7-28, DEC-M7-1).
 *
 * The targeted strategy is split on purpose. *Which concepts need work* is Learning's judgement, because it is a statement about mastery; *which items
 * to put in front of the learner* is Assessment's, because it is a question about the published catalogue and what the learner has already seen. This
 * handler is the whole of Learning's half, and its answer is a list of concept identities: no item, no item version, no count of responses, no state
 * name. Learning does not learn what an item is, and Assessment does not learn what mastery means.
 *
 * **The learner is the caller.** There is no learner parameter, so there is no way to ask about someone else; the principal's id is the learner.
 *
 * Weakest first: a concept in the `weak` state before one that is `developing`, and within each the least confident. A concept the learner has no
 * evidence for is not here — a run about nothing the learner has attempted is the filtered strategy's job, and it is the learner's choice.
 * Due reviews and error entries join the judgement when those exist (Tracks E and G); the shape of the answer does not change when they do.
 */
export const SUGGEST_REMEDIATION_CONCEPTS_POLICY = policy('SuggestRemediationConcepts', [ROLES.learner]);

export interface SuggestRemediationConcepts {
  readonly taxonomyVersionId: string;
  readonly limit?: number;
}

export const DEFAULT_REMEDIATION_LIMIT = 5;
export const MAX_REMEDIATION_LIMIT = 20;

/** The only thing that leaves: concept identities, in the order Learning would work on them. */
export interface RemediationConcepts {
  readonly conceptIdentityIds: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class SuggestRemediationConceptsHandler {
  readonly name = 'SuggestRemediationConcepts';
  readonly policy = SUGGEST_REMEDIATION_CONCEPTS_POLICY;

  constructor(private readonly deps: { readonly concepts: ConceptReader }) {}

  async handle(query: SuggestRemediationConcepts, context: ApplicationContext): Promise<Result<RemediationConcepts, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const limit = query.limit ?? DEFAULT_REMEDIATION_LIMIT;
    if (!UUID.test(query.taxonomyVersionId) || !Number.isInteger(limit) || limit < 1 || limit > MAX_REMEDIATION_LIMIT) {
      return err(applicationError('Validation', 'REMEDIATION_QUERY_INVALID', `a taxonomy version, and a limit between 1 and ${MAX_REMEDIATION_LIMIT}`));
    }
    const found = await this.deps.concepts.weakest(context.principal.id, query.taxonomyVersionId, limit);
    if (!found.ok) return err(found.error);
    return ok(Object.freeze({ conceptIdentityIds: Object.freeze([...found.value]) }));
  }
}
