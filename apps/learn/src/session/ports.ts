import type { SyncPolicy } from '@questionbank/attempt-engine';
import type { AttemptDto, ResultDto } from '../api/schemas.js';

/**
 * What the attempt session is given, and the only things it reaches outside itself for. A session reads no clock, opens no
 * connection and touches no storage of its own: time, the network and the disk arrive as these ports, which is what makes an
 * outage, a reload and an expiry testable by passing values.
 */
export interface MonotonicClock {
  /** Milliseconds on a clock that only goes forward within one run of the app. Never wall-clock time. */
  now(): number;
}

export interface AttemptTransport {
  getAttempt(attemptId: string): Promise<AttemptDto>;
  /** Sends events as the engine produced them. Resolves with the ids the server holds; throws if it could not be reached or refused the request. */
  sendEvents(attemptId: string, deviceRef: string, events: readonly unknown[]): Promise<{ readonly acknowledged: readonly string[]; readonly rejected: readonly string[] }>;
  submit(attemptId: string, reason: 'manual' | 'expiry' | 'recovered', idempotencyKey: string): Promise<AttemptDto>;
  getResult(attemptId: string): Promise<ResultDto>;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionPorts {
  readonly clock: MonotonicClock;
  readonly transport: AttemptTransport;
  readonly storage: KeyValueStore;
  readonly newId: () => string;
  readonly syncPolicy: SyncPolicy;
}

/** How a send that did not get through is told apart from one the server refused: the second is not retried. */
export const DEFAULT_SYNC_POLICY: SyncPolicy = Object.freeze({ batchSize: 50, baseDelayMs: 1_000, maxDelayMs: 30_000, maxConsecutiveFailures: 12 });
