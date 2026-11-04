import { ApiProblemError, createClient, ResponseSchemaError, type ApiClient, type RequestOptions } from '@questionbank/contracts/client';
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
  it('asks the one question, of the identity route, and gives back what the server said, including why a session ended', async () => {
    const { seen, api } = rig(() => ({ signedIn: false, endedBy: 'another_sign_in' }));
    expect(await api.signedIn()).toEqual({ signedIn: false, endedBy: 'another_sign_in' });
    expect(seen).toEqual([{ path: '/v1/identity/session' }]);
    expect(await rig(() => ({ signedIn: true, endedBy: null })).api.signedIn()).toEqual({ signedIn: true, endedBy: null });
  });

  it('is an error, and not "signed out", for anything but the server\'s answer: a failure, a lost connection, a shape it does not know', async () => {
    for (const status of [401, 403, 500, 503]) await expect(rig(() => Promise.reject(problem(status))).api.signedIn(), String(status)).rejects.toBeInstanceOf(ApiProblemError);
    await expect(rig(() => Promise.reject(new TypeError('Failed to fetch'))).api.signedIn()).rejects.toThrow('Failed to fetch');
  });

  it('reads only the two reasons it knows through the real client: a shape it does not know is an error, not a sentence', async () => {
    const through = (body: unknown) => createIdentityApi(createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch }));
    expect(await through({ signedIn: false, endedBy: 'another_sign_in' }).signedIn()).toEqual({ signedIn: false, endedBy: 'another_sign_in' });
    await expect(through({ signedIn: false, endedBy: 'session abc123' }).signedIn()).rejects.toBeInstanceOf(ResponseSchemaError);
    await expect(through({ signedIn: 'yes' }).signedIn()).rejects.toBeInstanceOf(ResponseSchemaError);
  });
});
