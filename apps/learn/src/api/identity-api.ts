import { ApiProblemError, type ApiClient } from '@questionbank/contracts/client';
import { z } from 'zod';

/**
 * The learner's sign-in and the messages around it (M8-43), through the one typed client (F15). The session itself is a cookie the browser keeps and this code never sees
 * (ADR-0065): a login answers with the session's token for clients that are not browsers, and nothing here reads or keeps it.
 */
export interface IdentityApi {
  /** Whether a session is in force, and if it was ended by a later sign-in, that. An error for anything but the server's answer, so a lost connection is not read as being signed out. */
  signedIn(): Promise<SessionStatus>;
  register(email: string, password: string): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** A new confirmation message for the signed-in person's own address. */
  resendVerification(): Promise<void>;
  /** Spends the code in a link. Asked once for a code: a second ask for the same code on this page is the first one's answer, because a code works once. */
  verify(code: string): Promise<void>;
  requestRecovery(email: string): Promise<void>;
  reset(code: string, newPassword: string): Promise<void>;
}

const answered = z.object({}).passthrough();
const sessionStatus = z.object({ signedIn: z.boolean(), endedBy: z.literal('another_sign_in').nullable() });
export type SessionStatus = z.infer<typeof sessionStatus>;

/**
 * A refusal for being busy is the password hasher's queue being full (a derive takes 160 to 220 ms of CPU, and a class signing in together is a queue, D129): the server answers 503 and says it is
 * `retryable`, and it clears in seconds. Signing in, registering and choosing a new password are tried again once, after a short jittered wait, before a person is told anything; only then is the sentence one
 * they can act on.
 *
 * The worst case is the server's own hold, not ours: it keeps a sign-in for PASSWORD_HASH_WAIT_MS (15 s) before it answers 503. One retry is 15 s + up to 3 s (2 s x 1.5) + 15 s = about 33 s before a
 * person is told; two retries were 51 s. The measured stampede drained in 15.6 s, so one retry lands after the drain; a second refusal means the server is saturated, and the person is told. Nothing else is retried: a wrong password is not busy, a rate limit is a different answer with a different wait, and a lost connection is the connection's.
 */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([2_000]);
/** Each delay is multiplied by a factor from this range, so people refused in the same instant do not all come back in the same instant. */
export const JITTER_MIN = 0.5;
export const JITTER_SPAN = 1;
export const STILL_BUSY = 'So many people are signing in that we could not take yours just yet. Wait a minute, then try again.';
const isBusy = (error: unknown): boolean => error instanceof ApiProblemError && error.problem.status === 503 && error.problem.retryable;

async function whileBusy<T>(run: () => Promise<T>, pause: (ms: number) => Promise<void>, random: () => number): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isBusy(error)) throw error;
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw new Error(STILL_BUSY);
      await pause(delay * (JITTER_MIN + JITTER_SPAN * random()));
    }
  }
}

/** `pause` is the host's timer: this file has none, and it is required, because a retry with no wait is a herd. */
export function createIdentityApi(client: ApiClient, pause: (ms: number) => Promise<void>, random: () => number = Math.random): IdentityApi {
  const post = (path: string, body: object = {}): Promise<void> => client.request({ method: 'POST', path: `/v1/identity${path}`, body, responseSchema: answered }).then(() => undefined);
  const verified = new Map<string, Promise<void>>();
  return {
    signedIn: () => client.request({ path: '/v1/identity/session', responseSchema: sessionStatus }),
    register: (email, password) => whileBusy(() => post('/register', { email, password }), pause, random),
    login: (email, password) => whileBusy(() => post('/login', { email, password }), pause, random),
    logout: () => post('/logout'),
    resendVerification: () => post('/email/verification'),
    verify: (code) => {
      const earlier = verified.get(code);
      if (earlier !== undefined) return earlier;
      const first = post('/email/verify', { token: code });
      verified.set(code, first);
      return first;
    },
    requestRecovery: (email) => post('/password/recovery', { email }),
    reset: (code, newPassword) => whileBusy(() => post('/password/reset', { token: code, newPassword }), pause, random),
  };
}
