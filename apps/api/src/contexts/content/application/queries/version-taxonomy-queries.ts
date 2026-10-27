import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { DifficultyBand } from '../../domain/item-version.js';
import type { VersionTaxonomyReader } from '../../domain/repository-ports.js';
import { ROLES } from '../../../../platform/auth/roles.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';
import { MAX_CATALOGUE_PAGE } from './catalogue-queries.js';

/**
 * `GetVersionTaxonomy` — what Learning may ask content (M7-03, DEC-M7-1): for a set of item versions, the concept each is
 * primarily about, the taxonomy version that concept belongs to, and the difficulty its author estimated.
 *
 * Identifiers, a code and a band. No stem, no option, no key, no solution (P4), and built field by field so a column added to
 * the source next year is not carried across by a spread. The system's alone, with no route.
 *
 * Versions the store does not know, or knows without a primary tag, are simply absent from the answer: deciding what an absent
 * version means for evidence is the consumer's, not content's.
 */
export const GET_VERSION_TAXONOMY_POLICY = policy('GetVersionTaxonomy', [ROLES.system]);

export interface GetVersionTaxonomy {
  readonly itemVersionIds: readonly string[];
}

export interface VersionTaxonomyView {
  readonly itemVersionId: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly difficultyEstimate: DifficultyBand;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class GetVersionTaxonomyHandler implements Handler<GetVersionTaxonomy, readonly VersionTaxonomyView[]> {
  readonly name = 'GetVersionTaxonomy';
  readonly policy = GET_VERSION_TAXONOMY_POLICY;

  constructor(private readonly deps: { readonly taxonomy: VersionTaxonomyReader }) {}

  async handle(
    query: GetVersionTaxonomy,
    context: ApplicationContext,
  ): Promise<Result<readonly VersionTaxonomyView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    if (query.itemVersionIds.length > MAX_CATALOGUE_PAGE) {
      return err(applicationError('Validation', 'VERSION_TAXONOMY_QUERY_INVALID', `at most ${MAX_CATALOGUE_PAGE} versions per call`, 'itemVersionIds'));
    }
    if (query.itemVersionIds.some((id) => !UUID.test(id))) {
      return err(applicationError('Validation', 'VERSION_TAXONOMY_QUERY_INVALID', 'itemVersionIds holds a value that is not an identifier', 'itemVersionIds'));
    }

    const found = await this.deps.taxonomy.forVersions(query.itemVersionIds);
    if (!found.ok) return err(fromContent(found.error));

    return ok(
      Object.freeze(
        found.value.map((entry) =>
          Object.freeze({
            itemVersionId: entry.itemVersionId,
            conceptIdentityId: entry.conceptIdentityId,
            taxonomyVersionId: entry.taxonomyVersionId,
            difficultyEstimate: entry.difficultyEstimate,
          }),
        ),
      ),
    );
  }
}
