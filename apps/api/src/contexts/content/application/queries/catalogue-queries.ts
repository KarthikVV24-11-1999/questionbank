import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import { DIFFICULTY_BANDS, type DifficultyBand } from '../../domain/item-version.js';
import { ITEM_TYPES, type ItemType } from '../../domain/response-specification.js';
import type { PublishedCatalogueEntry, PublishedCatalogueReader } from '../../domain/repository-ports.js';
import { ROLES } from '../../../../platform/auth/roles.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';

/**
 * `ListPublishedCatalogue` — what content has published, and the facts about
 * each item that a consumer needs to choose among them.
 *
 * Content could serve one published item by id and could not enumerate its own
 * catalogue for anything: not form assembly, not a catalogue screen, not an
 * export. This is that query, and it is **shaped by content's own facts, not
 * by any consumer's needs.** A filter here is something an item *is* — its
 * type, its authored difficulty band, a concept it is tagged with, its
 * subject. Sections, marks totals and difficulty tolerances are a blueprint's,
 * and a query that grew to serve them would make the next blueprint change an
 * edit to this context.
 *
 * **Every view is built field by field, and no field is key material or a
 * solution** (§9 rule 10, ADR-0009, F6, F35). That is deliberate: a listing is
 * where a key leaks by accident, because it is the one query that returns
 * hundreds of items and nobody reads them all.
 *
 * Not for learners: enumerating the whole published bank is not a thing a
 * student does, and exposing it would let one be built.
 */
export const LIST_PUBLISHED_CATALOGUE_POLICY = policy('ListPublishedCatalogue', [ROLES.contentOps, ROLES.system]);

export const MAX_CATALOGUE_PAGE = 500;

export interface ListPublishedCatalogue {
  readonly subject?: string;
  readonly itemTypes?: readonly ItemType[];
  readonly difficultyBands?: readonly DifficultyBand[];
  readonly conceptIdentityIds?: readonly string[];
  readonly cursor?: string;
  /** Defaults to 100; at most 500. */
  readonly limit?: number;
}

export interface PublishedCatalogueEntryView {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly versionNo: number;
  readonly itemType: ItemType;
  readonly difficultyBand: DifficultyBand;
  readonly subject: string;
  readonly taxonomyVersionId: string;
  readonly primaryConceptIdentityId: string;
  readonly conceptIdentityIds: readonly string[];
  readonly stimulusVersionId?: string;
}

export interface PublishedCatalogueView {
  readonly entries: readonly PublishedCatalogueEntryView[];
  readonly nextCursor?: string;
}

export interface CatalogueQueryDependencies {
  readonly catalogue: PublishedCatalogueReader;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

function invalid(message: string, location: string): ApplicationError {
  return applicationError('Validation', 'CATALOGUE_QUERY_INVALID', message, location);
}

/** Named field by field: a spread would carry whatever the source gains next year. */
export function toCatalogueEntryView(entry: PublishedCatalogueEntry): PublishedCatalogueEntryView {
  return Object.freeze({
    itemId: entry.itemId,
    itemVersionId: entry.itemVersionId,
    versionNo: entry.versionNo,
    itemType: entry.itemType,
    difficultyBand: entry.difficultyBand,
    subject: entry.subject,
    taxonomyVersionId: entry.taxonomyVersionId,
    primaryConceptIdentityId: entry.primaryConceptIdentityId,
    conceptIdentityIds: Object.freeze([...entry.conceptIdentityIds]),
    ...(entry.stimulusVersionId === undefined ? {} : { stimulusVersionId: entry.stimulusVersionId }),
  });
}

const DEFAULT_PAGE = 100;

export class ListPublishedCatalogueHandler implements Handler<ListPublishedCatalogue, PublishedCatalogueView> {
  readonly name = 'ListPublishedCatalogue';
  readonly policy = LIST_PUBLISHED_CATALOGUE_POLICY;

  constructor(private readonly deps: CatalogueQueryDependencies) {}

  async handle(
    query: ListPublishedCatalogue,
    context: ApplicationContext,
  ): Promise<Result<PublishedCatalogueView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const limit = query.limit ?? DEFAULT_PAGE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOGUE_PAGE) {
      return err(invalid(`limit is a whole number from 1 to ${MAX_CATALOGUE_PAGE}`, 'limit'));
    }
    if (query.itemTypes?.some((type) => !(ITEM_TYPES as readonly string[]).includes(type)) === true) {
      return err(invalid('itemTypes names a type content does not have', 'itemTypes'));
    }
    if (query.difficultyBands?.some((band) => !(DIFFICULTY_BANDS as readonly string[]).includes(band)) === true) {
      return err(invalid('difficultyBands names a band content does not have', 'difficultyBands'));
    }

    const page = await this.deps.catalogue.list({
      ...(query.subject === undefined ? {} : { subject: query.subject }),
      ...(query.itemTypes === undefined ? {} : { itemTypes: query.itemTypes }),
      ...(query.difficultyBands === undefined ? {} : { difficultyBands: query.difficultyBands }),
      ...(query.conceptIdentityIds === undefined ? {} : { conceptIdentityIds: query.conceptIdentityIds }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit,
    });
    if (!page.ok) return err(fromContent(page.error));

    return ok(
      Object.freeze({
        entries: Object.freeze(page.value.entries.map(toCatalogueEntryView)),
        ...(page.value.nextCursor === undefined ? {} : { nextCursor: page.value.nextCursor }),
      }),
    );
  }
}
