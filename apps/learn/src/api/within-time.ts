/**
 * Gives a request up after a time, for a request whose answer a screen can do without (M8-33). The request is not cancelled; its answer is ignored. The clock is the host's: `schedule` is `setTimeout`'s
 * shape and is handed in, so this file has no timer of its own and a test drives time by calling what it was given.
 */
/** What a request is rejected with when it was given up on: the connection is the reason, as when it fails to connect. */
export class GaveUpWaiting extends Error {
  constructor() {
    super('The server did not answer in time.');
    this.name = 'GaveUpWaiting';
  }
}

export function withinTime<T>(request: Promise<T>, ms: number, schedule: (fn: () => void, ms: number) => () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = schedule(() => reject(new GaveUpWaiting()), ms);
    request.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}
