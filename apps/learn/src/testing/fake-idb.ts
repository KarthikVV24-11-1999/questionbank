/**
 * Just enough of IndexedDB for `idb-record-store.ts` to run against in a unit test, which jsdom cannot (it has none). It is not a model of IndexedDB: it does what the adapter
 * asks of it and records what it was asked, so that a spec can hold the adapter to the one thing that matters about it, that a commit is one transaction opened with strict
 * durability, written atomically and reported complete only after.
 *
 * A transaction collects its writes and applies them when it completes, so a transaction that fails applies none of them, as a real one does not.
 */
interface StoreSpec {
  readonly keyPath: string | readonly string[] | null;
  readonly rows: Map<string, unknown>;
  readonly indexes: Map<string, string>;
}

const keyString = (key: unknown): string => JSON.stringify(key);

type Handler = ((event?: unknown) => void) | null;

export class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

export class FakeIdb {
  readonly stores = new Map<string, StoreSpec>();
  /** Every transaction opened, with what it was opened for. */
  readonly transactions: Array<{ readonly stores: readonly string[]; readonly mode: string; readonly options: unknown }> = [];
  version = 0;
  /** The next read-write transaction fails (and applies nothing) with this message. */
  failNext: string | null = null;
  /** Opening fails with this message. */
  failOpen: string | null = null;
  /** Opening is blocked. */
  blockOpen = false;

  open(_name: string, version: number): IDBOpenDBRequest {
    const request = new FakeRequest<unknown>();
    setTimeout(() => {
      if (this.blockOpen) return void request.onblocked?.();
      if (this.failOpen !== null) {
        request.error = new Error(this.failOpen);
        return void request.onerror?.();
      }
      const db = this.#database();
      request.result = db;
      if (this.version < version) {
        const oldVersion = this.version;
        this.version = version;
        request.onupgradeneeded?.({ oldVersion });
      }
      request.onsuccess?.();
    }, 0);
    return request as unknown as IDBOpenDBRequest;
  }

  #database(): unknown {
    const self = this;
    return {
      createObjectStore(name: string, options?: { keyPath?: string | string[] }) {
        const spec: StoreSpec = { keyPath: options?.keyPath ?? null, rows: new Map(), indexes: new Map() };
        self.stores.set(name, spec);
        return { createIndex: (index: string, keyPath: string) => void spec.indexes.set(index, keyPath) };
      },
      transaction(names: string | string[], mode: string, options?: unknown) {
        return self.#transaction(Array.isArray(names) ? names : [names], mode, options);
      },
    };
  }

  #transaction(names: string[], mode: string, options: unknown): unknown {
    this.transactions.push({ stores: names, mode, options });
    const writes: Array<() => void> = [];
    const tx = {
      oncomplete: null as Handler,
      onerror: null as Handler,
      onabort: null as Handler,
      error: null as Error | null,
      objectStore: (name: string) => this.#objectStore(name, writes),
    };
    setTimeout(() => {
      if (mode === 'readwrite' && this.failNext !== null) {
        tx.error = new Error(this.failNext);
        this.failNext = null;
        tx.onabort?.();
        return;
      }
      for (const write of writes) write();
      tx.oncomplete?.();
    }, 0);
    return tx;
  }

  #objectStore(name: string, writes: Array<() => void>): unknown {
    const spec = this.stores.get(name)!;
    const answer = <T>(value: () => T): FakeRequest<T> => {
      const request = new FakeRequest<T>();
      setTimeout(() => {
        request.result = value();
        request.onsuccess?.();
      }, 0);
      return request;
    };
    return {
      put: (value: unknown, key?: unknown) => {
        const at = spec.keyPath === null ? key : Array.isArray(spec.keyPath) ? spec.keyPath.map((part) => (value as Record<string, unknown>)[part]) : (value as Record<string, unknown>)[spec.keyPath as string];
        writes.push(() => void spec.rows.set(keyString(at), value));
        return answer(() => at);
      },
      get: (key: unknown) => answer(() => spec.rows.get(keyString(key))),
      delete: (key: unknown) => {
        writes.push(() => void spec.rows.delete(keyString(key)));
        return answer(() => undefined);
      },
      index: (index: string) => ({ getAll: (value: unknown) => answer(() => [...spec.rows.values()].filter((row) => (row as Record<string, unknown>)[spec.indexes.get(index)!] === value)) }),
    };
  }
}
