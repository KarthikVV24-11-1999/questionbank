import type { GetTaxonomyVersion, TaxonomyVersionDetailView } from '../../curriculum/public/index.js';
import { err, ok, type Result } from '../domain/result.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, SyllabusReader, SyllabusVersion } from '../application/ports.js';
import type { CommandHandler } from './content-command-authoring.js';

/**
 * Concept membership from curriculum (M5-30): curriculum's own
 * `GetTaxonomyVersion` handler, injected, run under the caller's own context.
 *
 * Curriculum's barrel exposes the query and its view as types, and its handler
 * not at all, so — as with content — the composition root supplies the handler
 * and this adapter only calls it. It does not decide who may read: curriculum's
 * policy does, and a refusal comes back unchanged. Curriculum admits learners,
 * curators, Content Ops, exam owners and — since M5-35 — the generation pipeline,
 * to this one read, so check 5 runs under the pipeline's own principal. That was
 * debt D43, closed.
 */
export class CurriculumSyllabusReader implements SyllabusReader {
  readonly #taxonomyVersions: CommandHandler<GetTaxonomyVersion, TaxonomyVersionDetailView>;

  constructor(taxonomyVersions: CommandHandler<GetTaxonomyVersion, TaxonomyVersionDetailView>) {
    this.#taxonomyVersions = taxonomyVersions;
  }

  async read(taxonomyVersionId: string, context: ApplicationContext): Promise<Result<SyllabusVersion, ApplicationError>> {
    const loaded = await this.#taxonomyVersions.handle({ taxonomyVersionId }, context);
    if (!loaded.ok) return err(loaded.error);
    return ok({
      taxonomyVersionId: loaded.value.taxonomyVersionId,
      state: loaded.value.state,
      concepts: loaded.value.nodes.map((node) => ({ conceptIdentityId: node.conceptIdentityId, displayName: node.displayName })),
    });
  }
}
