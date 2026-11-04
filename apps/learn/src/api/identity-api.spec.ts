import { ApiProblemError, type ApiClient, type RequestOptions } from '@questionbank/contracts/client';
import { describe, expect, it } from 'vitest';
import { createIdentityApi } from './identity-api.js';

function rig(answer: (options: RequestOptions<unknown>) => unknown | Promise<unknown> = () => ({})) {
  const seen: { method?: string; path: string; body?: unknown }[] = [];
  const client = {
    request: async (options: RequestOptions<unknown>) => {
      seen.push({ ...(options.method === undefined ? {} : { method: options.method }), path: options.path, ...(options.body === undefined ? {} : { body: options.body }) });
      return answer(options);
    },
    requestBytes: async () => {
      throw new Error('not used');
    },
  } as unknown as ApiClient;
  return { seen, api: createIdentityApi(client) };
}
const problem = (status: number) => new ApiProblemError({ type: 't', title: 'x', status, code: 'Authentication', retryable: false, correlationId: 'c' } as never);

describe('the identity calls', () => {
  it('each posts to its own route with what it was given, and nothing else', async () => {
    const { seen, api } = rig();
    await api.register('a@example.com', 'a long enough password');
    await api.login('a@example.com', 'a long enough password');
    await api.logout();
    await api.resendVerification();
    await api.requestRecovery('a@example.com');
    await api.reset('CODE-123456', 'a new long password');
    expect(seen).toEqual([
      { method: 'POST', path: '/v1/identity/register', body: { email: 'a@example.com', password: 'a long enough password' } },
      { method: 'POST', path: '/v1/identity/login', body: { email: 'a@example.com', password: 'a long enough password' } },
      { method: 'POST', path: '/v1/identity/logout', body: {} },
      { method: 'POST', path: '/v1/identity/email/verification', body: {} },
      { method: 'POST', path: '/v1/identity/password/recovery', body: { email: 'a@example.com' } },
      { method: 'POST', path: '/v1/identity/password/reset', body: { token: 'CODE-123456', newPassword: 'a new long password' } },
    ]);
  });

  it('spends a code once however often it is asked for it, because a code works once', async () => {
    const { seen, api } = rig();
    await Promise.all([api.verify('CODE-123456'), api.verify('CODE-123456')]);
    await api.verify('CODE-123456');
    await api.verify('OTHER-98765');
    expect(seen.map((call) => call.body)).toEqual([{ token: 'CODE-123456' }, { token: 'OTHER-98765' }]);
  });

  it('gives the refusal back to the caller when verifying fails, and again on a second ask', async () => {
    const { api } = rig(() => {
      throw problem(400);
    });
    await expect(api.verify('CODE-123456')).rejects.toBeInstanceOf(ApiProblemError);
    await expect(api.verify('CODE-123456')).rejects.toBeInstanceOf(ApiProblemError);
  });
});

describe('whether a session is in force', () => {
  it('is yes when the profile can be read, asking the one question', async () => {
    const { seen, api } = rig();
    expect(await api.signedIn()).toBe(true);
    expect(seen).toEqual([{ path: '/v1/learning/profile' }]);
  });

  it('is no on the server\'s "who are you" and on nothing else', async () => {
    expect(await rig(() => Promise.reject(problem(401))).api.signedIn()).toBe(false);
    for (const status of [403, 500, 503]) await expect(rig(() => Promise.reject(problem(status))).api.signedIn(), String(status)).rejects.toBeInstanceOf(ApiProblemError);
    await expect(rig(() => Promise.reject(new TypeError('Failed to fetch'))).api.signedIn()).rejects.toThrow('Failed to fetch');
  });
});
