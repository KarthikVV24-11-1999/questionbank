import type { ProfileChange } from '../api/learning-schemas.js';
import type { DraftStore } from '../onboarding/draft.js';
import type { RecordChange, RecordStore, StoredAttempt } from './persistence.js';

/**
 * The device's disk for the response log: IndexedDB behind `RecordStore` (M8-15).
 *
 * **Strict durability.** Every commit is one read-write transaction over all three stores, opened with `durability: 'strict'`, and it resolves on the transaction's `complete`,
 * which for a strict transaction is after the data has been flushed to disk. Chrome's default is `relaxed`, which completes before the flush; that default is the very window this module
 * exists to close, so it is asked for by name and a spec holds the call to it. A browser that does not know the option ignores it and gives its default, which is its best.
 *
 * **All or none.** The facts, the event rows and the active marker are in the one transaction, so a kill leaves the log as it was or as it will be, never a row whose facts are missing.
 *
 * Stores (version 1): `attempts` (the facts, keyed by attempt), `events` (a row per event, keyed by attempt and event id, with an index on the attempt to read them back), and `device` (one
 *  key, `active`). Version 2 adds `drafts`: what a learner has said in onboarding and the server has not yet been told (M8-22), one key. The two are opened separately and share the database.
 */
const DATABASE = 'qb-device';
const VERSION = 2;
const ACTIVE = 'active';

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the request failed'));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('the transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('the transaction was aborted'));
  });
}

export function openRecordStore(factory: IDBFactory): Promise<RecordStore> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DATABASE, VERSION);
    opening.onupgradeneeded = (event) => upgrade(opening.result, (event as IDBVersionChangeEvent | undefined)?.oldVersion ?? 0);
    opening.onerror = () => reject(opening.error ?? new Error('the device store could not be opened'));
    opening.onblocked = () => reject(new Error('the device store is blocked by another tab'));
    opening.onsuccess = () => resolve(new IdbRecordStore(opening.result));
  });
}

/** Each version adds to the last and removes nothing: an attempt written by an earlier build is read by this one. */
function upgrade(db: IDBDatabase, from: number): void {
  if (from < 1) {
    db.createObjectStore('attempts', { keyPath: 'attemptId' });
    db.createObjectStore('events', { keyPath: ['attemptId', 'eventId'] }).createIndex('byAttempt', 'attemptId');
    db.createObjectStore('device');
  }
  if (from < 2) db.createObjectStore('drafts');
}

const PROFILE_DRAFT = 'profile';

/** The onboarding draft on the same disk, with the same strict durability: a learner on a bad connection is the one who needs it to survive. */
export function openDraftStore(factory: IDBFactory): Promise<DraftStore> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DATABASE, VERSION);
    opening.onupgradeneeded = (event) => upgrade(opening.result, (event as IDBVersionChangeEvent | undefined)?.oldVersion ?? 0);
    opening.onerror = () => reject(opening.error ?? new Error('the device store could not be opened'));
    opening.onblocked = () => reject(new Error('the device store is blocked by another tab'));
    opening.onsuccess = () => {
      const db = opening.result;
      const change = async (work: (store: IDBObjectStore) => void): Promise<void> => {
        const transaction = db.transaction('drafts', 'readwrite', { durability: 'strict' });
        const done = finished(transaction);
        work(transaction.objectStore('drafts'));
        await done;
      };
      resolve({
        read: async () => {
          const found = await promised<unknown>(db.transaction('drafts', 'readonly').objectStore('drafts').get(PROFILE_DRAFT));
          return typeof found === 'object' && found !== null ? (found as ProfileChange) : null;
        },
        write: (draft) => change((store) => void store.put(draft, PROFILE_DRAFT)),
        clear: () => change((store) => void store.delete(PROFILE_DRAFT)),
      });
    };
  });
}

class IdbRecordStore implements RecordStore {
  constructor(private readonly db: IDBDatabase) {}

  async commit(change: RecordChange): Promise<void> {
    const transaction = this.db.transaction(['attempts', 'events', 'device'], 'readwrite', { durability: 'strict' });
    const done = finished(transaction);
    transaction.objectStore('attempts').put(change.meta);
    for (const row of change.rows) transaction.objectStore('events').put(row);
    if (change.active) transaction.objectStore('device').put(change.meta.attemptId, ACTIVE);
    await done;
  }

  async read(attemptId: string): Promise<StoredAttempt | null> {
    const transaction = this.db.transaction(['attempts', 'events'], 'readonly');
    const meta = await promised(transaction.objectStore('attempts').get(attemptId));
    if (meta === undefined) return null;
    const rows = await promised(transaction.objectStore('events').index('byAttempt').getAll(attemptId));
    return { meta, rows };
  }

  async active(): Promise<string | null> {
    const found = await promised(this.db.transaction('device', 'readonly').objectStore('device').get(ACTIVE));
    return typeof found === 'string' ? found : null;
  }
}

/**
 * The store when there is none to open (no IndexedDB, or the browser refused it): it keeps nothing, says so on every commit, and reads as empty. The session turns that into the
 * words the learner reads and into sending every answer as it is given, which is all that is left to do for them.
 */
export function unavailableRecordStore(reason: unknown): RecordStore {
  const failure = reason instanceof Error ? reason : new Error('this device could not open its store');
  return {
    commit: () => Promise.reject(failure),
    read: () => Promise.resolve(null),
    active: () => Promise.resolve(null),
  };
}
