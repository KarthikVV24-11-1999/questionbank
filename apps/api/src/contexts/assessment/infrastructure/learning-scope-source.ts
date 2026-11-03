import { err, ok, type Result } from '../domain/result.js';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, LearnerScopeSource } from '../application/ports.js';

/**
 * Learning's answer to "what has this learner studied", in the shape practice needs of it (M8-21, ADR-0060): concept identities, or none where there is no scope in force. Learning's
 * handler arrives through the composition seam and is called with the learner's own context, as the remediation read is; nothing here imports learning.
 */
export type LearnerScopeHandler = {
  handle(query: { readonly taxonomyVersionId: string }, context: ApplicationContext): Promise<Result<{ readonly conceptIdentityIds: readonly string[] | null }, ApplicationError>>;
};

export class LearningScopeSource implements LearnerScopeSource {
  constructor(private readonly learning: LearnerScopeHandler) {}

  async conceptsInScope(taxonomyVersionId: string, context: ApplicationContext): Promise<Result<readonly string[] | null, ApplicationError>> {
    const answer = await this.learning.handle({ taxonomyVersionId }, context);
    if (!answer.ok) return err(applicationError(answer.error.kind, answer.error.code, answer.error.message));
    return ok(answer.value.conceptIdentityIds === null ? null : Object.freeze([...answer.value.conceptIdentityIds]));
  }
}
