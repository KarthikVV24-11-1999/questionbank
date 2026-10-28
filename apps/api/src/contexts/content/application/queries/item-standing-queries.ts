import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { ItemStandingReader } from '../../domain/repository-ports.js';
import { ROLES } from '../../../../platform/auth/roles.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';
import { MAX_CATALOGUE_PAGE } from './catalogue-queries.js';

/**
 * `GetItemStanding` — what Learning may ask content about a bookmark (M7-38): for a set of items, whether each is published, suspended or retired, and the
 * version a learner should be shown. Identifiers and a word. The system's alone, with no route.
 *
 * Items the store does not know, or that were never published, are absent from the answer; Learning shows such a bookmark as `unknown` and keeps it.
 */
export const GET_ITEM_STANDING_POLICY = policy('GetItemStanding', [ROLES.system]);

export interface GetItemStanding {
  readonly itemIds: readonly string[];
}

export interface ItemStandingView {
  readonly itemId: string;
  readonly state: 'published' | 'suspended' | 'retired';
  readonly itemVersionId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class GetItemStandingHandler implements Handler<GetItemStanding, readonly ItemStandingView[]> {
  readonly name = 'GetItemStanding';
  readonly policy = GET_ITEM_STANDING_POLICY;

  constructor(private readonly deps: { readonly standing: ItemStandingReader }) {}

  async handle(query: GetItemStanding, context: ApplicationContext): Promise<Result<readonly ItemStandingView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    if (query.itemIds.length > MAX_CATALOGUE_PAGE) {
      return err(applicationError('Validation', 'ITEM_STANDING_QUERY_INVALID', `at most ${MAX_CATALOGUE_PAGE} items per call`, 'itemIds'));
    }
    if (query.itemIds.some((id) => !UUID.test(id))) {
      return err(applicationError('Validation', 'ITEM_STANDING_QUERY_INVALID', 'itemIds holds a value that is not an identifier', 'itemIds'));
    }
    const found = await this.deps.standing.forItems(query.itemIds);
    if (!found.ok) return err(fromContent(found.error));
    return ok(Object.freeze(found.value.map((entry) => Object.freeze({ itemId: entry.itemId, state: entry.state, itemVersionId: entry.itemVersionId }))));
  }
}
