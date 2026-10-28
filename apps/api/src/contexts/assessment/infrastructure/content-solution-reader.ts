import { err, ok, type Result } from '../domain/result.js';
import type { ReleasedSlot } from '../domain/solution-release.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, SolutionContent, SolutionSource } from '../application/ports.js';

/**
 * Reads a published solution from content by the item version a released slot pinned, through the handler the composition root passes
 * (`contentForAssessment`). Declared by the shape assessment needs of it, as `ContentFormReader` is: nothing in assessment names a content class.
 *
 * It accepts a `ReleasedSlot` and nothing else, so the gate is not something this adapter checks and cannot be asked to skip.
 */
interface SolutionHandler {
  handle(
    query: { readonly itemVersionId: string; readonly depth: 'basic' | 'full' },
    context: ApplicationContext,
  ): Promise<{ readonly ok: true; readonly value: SolutionContent } | { readonly ok: false; readonly error: ApplicationError }>;
}

export class ContentSolutionReader implements SolutionSource {
  readonly #solution: SolutionHandler;

  constructor(deps: { readonly solution: SolutionHandler }) {
    this.#solution = deps.solution;
  }

  async solutionFor(slot: ReleasedSlot, depth: 'basic' | 'full', context: ApplicationContext): Promise<Result<SolutionContent, ApplicationError>> {
    const found = await this.#solution.handle({ itemVersionId: slot.itemVersionId, depth }, context);
    return found.ok ? ok(found.value) : err(found.error);
  }
}
