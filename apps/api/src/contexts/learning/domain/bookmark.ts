/**
 * `Bookmark` — a learner's pointer at an item (M7-38).
 *
 * **It points at the item and not at a version (DEC-M7-18).** What it shows is the item's current published version, so a bookmark does not go stale when the item is revised.
 * When the item is retired the bookmark is **kept and marked** and shows the last version that was published: a learner's saved question does not vanish because
 * content moved on. Which of those an item is, is content's to say; Learning asks through the seam content offers it and holds no copy.
 */
export interface Bookmark {
  readonly bookmarkId: string;
  readonly learnerRef: string;
  readonly itemId: string;
  readonly createdAt: string;
}

export type BookmarkState = 'published' | 'suspended' | 'retired' | 'unknown';

/** What content says of an item, in the shape Learning needs: its lifecycle and the version a learner should be shown. */
export interface ItemStanding {
  readonly itemId: string;
  readonly state: BookmarkState;
  /** The current published version while published; the last one published after that; `null` if the item was never published. */
  readonly itemVersionId: string | null;
}

/** A bookmark with the standing of its item at the time it was read. `retired` is the marker: the bookmark is retained, and the version is the last one. */
export interface ResolvedBookmark extends Bookmark {
  readonly state: BookmarkState;
  readonly itemVersionId: string | null;
}

export function resolveBookmark(bookmark: Bookmark, standing: ItemStanding | undefined): ResolvedBookmark {
  return Object.freeze({
    ...bookmark,
    state: standing?.state ?? 'unknown',
    itemVersionId: standing?.itemVersionId ?? null,
  });
}
