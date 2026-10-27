import { err, ok, type Result } from '../domain/result.js';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, RemediationSource } from '../application/ports.js';

/**
 * Learning's one answer assessment asks for, in the shape assessment needs of it (M7-28, DEC-M7-1): the concepts a remediation run should be about.
 * Learning's handler arrives through the composition seam; nothing here imports learning, and nothing in the answer is an item.
 */
export type RemediationConceptsHandler = {
  handle(
    query: { readonly taxonomyVersionId: string; readonly limit?: number },
    context: ApplicationContext,
  ): Promise<Result<{ readonly conceptIdentityIds: readonly string[] }, ApplicationError>>;
};

export class LearningRemediationSource implements RemediationSource {
  constructor(private readonly learning: RemediationConceptsHandler) {}

  async conceptsFor(taxonomyVersionId: string, limit: number, context: ApplicationContext): Promise<Result<readonly string[], ApplicationError>> {
    const answer = await this.learning.handle({ taxonomyVersionId, limit }, context);
    if (!answer.ok) return err(applicationError(answer.error.kind, answer.error.code, answer.error.message));
    return ok(Object.freeze([...answer.value.conceptIdentityIds]));
  }
}
