import type { ApiClient } from '@questionbank/contracts/client';
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

export function createIdentityApi(client: ApiClient): IdentityApi {
  const post = (path: string, body: object = {}): Promise<void> => client.request({ method: 'POST', path: `/v1/identity${path}`, body, responseSchema: answered }).then(() => undefined);
  const verified = new Map<string, Promise<void>>();
  return {
    signedIn: () => client.request({ path: '/v1/identity/session', responseSchema: sessionStatus }),
    register: (email, password) => post('/register', { email, password }),
    login: (email, password) => post('/login', { email, password }),
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
    reset: (code, newPassword) => post('/password/reset', { token: code, newPassword }),
  };
}
