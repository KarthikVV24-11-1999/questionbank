/**
 * The device's record of an attempt, read the way the app keeps it (M8-15, M8-16): in IndexedDB, in a database called `qb-device` with the facts of each attempt in `attempts`,
 * one row per event in `events` (with whether the server has it), and the attempt being sat under `active` in `device`. `apps/learn/src/session/idb-record-store.ts` is the writer;
 * this is the reader, and the two agree only because a spec reads what the real app wrote.
 *
 * These functions are sent into a page, so each is self-contained: nothing here may name anything outside its own body.
 */
export interface DeviceRecordJson {
  readonly attemptId: string;
  readonly events: Array<{ eventId: string; sequence: number; slot: string; kind: string; answer?: unknown }>;
  readonly acknowledgedIds: string[];
  readonly rejectedIds: string[];
}

/**
 * Reads the record in the page it runs in. With `attemptId` null it reads the active attempt. Writes the app has asked for and the harness has recorded (`window.__qbIntent`, kept
 * by `installIntentLog` and only in a run that plants a slow disk) are laid over what the disk answers, because there the question is what the device was *given*, which is
 * what the learner was told was safe, and not what has reached the disk yet. The result is JSON, or `null` where there is no such record.
 */
export async function readDeviceRecordInPage(attemptId: string | null): Promise<string | null> {
  const opened = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open('qb-device');
    // asking for a database that is not there must not make one
    request.onupgradeneeded = () => request.transaction!.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  type Row = { attemptId: string; eventId: string; sequence: number; state: string; event: Record<string, unknown> };
  const intent = (window as unknown as { __qbIntent?: { attempts: Map<string, Record<string, unknown>>; events: Map<string, Row>; active: string | null } }).__qbIntent;
  let active: string | null = null;
  let meta: Record<string, unknown> | undefined;
  let rows: Row[] = [];
  if (opened !== null) {
    try {
      const names = Array.from(opened.objectStoreNames);
      if (['attempts', 'events', 'device'].every((name) => names.includes(name))) {
        const transaction = opened.transaction(['attempts', 'events', 'device'], 'readonly');
        const ask = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => ((request.onsuccess = () => resolve(request.result)), (request.onerror = () => reject(request.error))));
        active = ((await ask(transaction.objectStore('device').get('active'))) as string | undefined) ?? null;
        const wanted = attemptId ?? intent?.active ?? active;
        if (wanted !== null) {
          meta = (await ask(transaction.objectStore('attempts').get(wanted))) as Record<string, unknown> | undefined;
          rows = (await ask(transaction.objectStore('events').index('byAttempt').getAll(wanted))) as Row[];
        }
      }
    } finally {
      opened.close();
    }
  }
  const wanted = attemptId ?? intent?.active ?? active;
  if (wanted === null) return null;
  if (intent !== undefined) {
    const overlaid = intent.attempts.get(wanted);
    if (overlaid !== undefined) meta = overlaid;
    const byId = new Map(rows.map((row) => [row.eventId, row] as const));
    for (const row of intent.events.values()) if (row.attemptId === wanted) byId.set(row.eventId, row);
    rows = [...byId.values()];
  }
  if (meta === undefined) return null;
  rows.sort((a, b) => a.sequence - b.sequence);
  return JSON.stringify({
    ...meta,
    events: rows.map((row) => row.event),
    acknowledgedIds: rows.filter((row) => row.state === 'acknowledged').map((row) => row.eventId),
    rejectedIds: rows.filter((row) => row.state === 'rejected').map((row) => row.eventId),
  });
}

/**
 * Installed before the app runs, in a run that plants a slow disk. It records every write the app asks of the device's store in `window.__qbIntent`, and, when `delayMs` is above
 * zero, holds each such write in memory for that long before a transaction of its own puts it on disk: a device whose disk is slow to take a write, which is the one condition under which
 * a browser killed without waiting for durability loses anything now.
 */
export function installIntentLog(delayMs: number): void {
  type Row = { attemptId: string; eventId: string; sequence: number; state: string; event: Record<string, unknown> };
  const intent = { attempts: new Map<string, Record<string, unknown>>(), events: new Map<string, Row>(), active: null as string | null };
  (window as unknown as { __qbIntent: typeof intent }).__qbIntent = intent;
  const realPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    const name = this.name;
    if (name === 'attempts') intent.attempts.set((value as { attemptId: string }).attemptId, structuredClone(value) as Record<string, unknown>);
    else if (name === 'events') intent.events.set((value as Row).eventId, structuredClone(value) as Row);
    else if (name === 'device') intent.active = value as string;
    if (delayMs <= 0 || !['attempts', 'events', 'device'].includes(name)) return realPut.call(this, value, key);
    const db = this.transaction.db;
    const held = structuredClone(value);
    window.setTimeout(() => {
      try {
        const transaction = db.transaction(name, 'readwrite');
        realPut.call(transaction.objectStore(name), held, key);
      } catch {
        // the page is gone, or the database was closed: the write is lost, which is what a slow disk and a kill do
      }
    }, delayMs);
    // a request the transaction can complete on, standing in for the write that has been put off
    return this.count() as unknown as IDBRequest<IDBValidKey>;
  };
}

/** Installed after `installIntentLog`: the device never writes down anything, and says nothing of it. */
export function installForgetfulStore(): void {
  IDBObjectStore.prototype.put = function (this: IDBObjectStore) {
    return this.count() as unknown as IDBRequest<IDBValidKey>;
  };
}

/** Everything the device's store holds, as JSON, for a scan that must see all of it (a leaked key kept on the device is a key kept in a row). `null` where there is no such database. */
export async function dumpDeviceStoreInPage(): Promise<string | null> {
  const opened = await new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open('qb-device');
    request.onupgradeneeded = () => request.transaction!.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (opened === null) return null;
  try {
    const names = Array.from(opened.objectStoreNames);
    const transaction = opened.transaction(names, 'readonly');
    const all: Record<string, unknown[]> = {};
    for (const name of names) {
      all[name] = await new Promise<unknown[]>((resolve, reject) => {
        const request = transaction.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return JSON.stringify(all);
  } finally {
    opened.close();
  }
}

/**
 * Installed before the app runs: times every transaction on the device's store from the moment it is opened to the moment it completes, in `window.__qbCommitMs`. For strict durability
 * the second is after the data is on disk, so this is the window an answer is exposed in: the time between the tap and a commit that holds it.
 */
export function installCommitTimer(): void {
  const timings: number[] = [];
  (window as unknown as { __qbCommitMs: number[] }).__qbCommitMs = timings;
  const real = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const transaction = real.apply(this, args);
    if (args[1] === 'readwrite') {
      const started = performance.now();
      transaction.addEventListener('complete', () => timings.push(performance.now() - started));
    }
    return transaction;
  } as typeof IDBDatabase.prototype.transaction;
}
