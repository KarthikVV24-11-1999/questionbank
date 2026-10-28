import { ROLES } from '../../../../platform/auth/roles.js';
import { resolveBookmark, type Bookmark, type ResolvedBookmark } from '../../domain/bookmark.js';
import { chooseErrorCause, type ErrorEntry } from '../../domain/error-entry.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, BookmarkStore, Clock, ErrorEntryStore, IdentifierFactory, ItemStandingSource } from '../ports.js';

/**
 * The learner's own notebook and bookmarks (M7-38). Each names `learner` and acts on the caller's own rows only: the learner is the principal, never a field of
 * the request, so there is no way to name someone else's. Learning has no routes yet (the learner surfaces are Track H); these are the handlers the routes will call.
 */
export const SET_ERROR_CAUSE_POLICY = policy('SetErrorCause', [ROLES.learner]);
export const LIST_ERROR_ENTRIES_POLICY = policy('ListErrorEntries', [ROLES.learner]);
export const CREATE_BOOKMARK_POLICY = policy('CreateBookmark', [ROLES.learner]);
export const LIST_BOOKMARKS_POLICY = policy('ListBookmarks', [ROLES.learner]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class SetErrorCauseHandler {
  readonly name = 'SetErrorCause';
  readonly policy = SET_ERROR_CAUSE_POLICY;

  constructor(private readonly deps: { readonly entries: ErrorEntryStore }) {}

  /** Gives a wrong response its cause. A give-up keeps the system's, and an entry that is not the caller's is not found. */
  async handle(command: { readonly errorEntryId: string; readonly cause: unknown }, context: ApplicationContext): Promise<Result<ErrorEntry, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const learnerRef = context.principal.id;
    const found = await this.deps.entries.find(learnerRef, command.errorEntryId);
    if (!found.ok) return found;
    const chosen = chooseErrorCause(found.value.kind, command.cause);
    if (!chosen.ok) return err(applicationError('Validation', chosen.error.code, chosen.error.message));
    return this.deps.entries.setCause(learnerRef, command.errorEntryId, chosen.value);
  }
}

export class ListErrorEntriesHandler {
  readonly name = 'ListErrorEntries';
  readonly policy = LIST_ERROR_ENTRIES_POLICY;

  constructor(private readonly deps: { readonly entries: ErrorEntryStore }) {}

  async handle(query: { readonly openOnly?: boolean }, context: ApplicationContext): Promise<Result<readonly ErrorEntry[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    return this.deps.entries.list(context.principal.id, { openOnly: query.openOnly ?? false });
  }
}

export class CreateBookmarkHandler {
  readonly name = 'CreateBookmark';
  readonly policy = CREATE_BOOKMARK_POLICY;

  constructor(private readonly deps: { readonly bookmarks: BookmarkStore; readonly clock: Clock; readonly identifiers: IdentifierFactory }) {}

  async handle(command: { readonly itemId: string }, context: ApplicationContext): Promise<Result<Bookmark, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    if (typeof command.itemId !== 'string' || !UUID.test(command.itemId)) {
      return err(applicationError('Validation', 'BOOKMARK_ITEM_INVALID', 'itemId is not an identifier'));
    }
    return this.deps.bookmarks.add(
      Object.freeze({ bookmarkId: this.deps.identifiers.next(), learnerRef: context.principal.id, itemId: command.itemId, createdAt: this.deps.clock.now().toISOString() }),
    );
  }
}

export class ListBookmarksHandler {
  readonly name = 'ListBookmarks';
  readonly policy = LIST_BOOKMARKS_POLICY;

  constructor(private readonly deps: { readonly bookmarks: BookmarkStore; readonly standings: ItemStandingSource }) {}

  /** Every bookmark, each shown at its item's standing now: the current published version, or — retired — the last, marked. None is dropped for what happened to its item. */
  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<readonly ResolvedBookmark[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const bookmarks = await this.deps.bookmarks.list(context.principal.id);
    if (!bookmarks.ok) return bookmarks;
    if (bookmarks.value.length === 0) return ok(Object.freeze([]));
    const standings = await this.deps.standings.standings(bookmarks.value.map((b) => b.itemId), context);
    if (!standings.ok) return standings;
    const byItem = new Map(standings.value.map((s) => [s.itemId, s]));
    return ok(Object.freeze(bookmarks.value.map((bookmark) => resolveBookmark(bookmark, byItem.get(bookmark.itemId)))));
  }
}
