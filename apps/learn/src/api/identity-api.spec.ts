import { ApiProblemError, createClient, ResponseSchemaError, type ApiClient, type RequestOptions } from '@questionbank/contracts/client';
import { describe, expect, it } from 'vitest';
import { BUSY_RETRY_DELAYS_MS, createIdentityApi, STILL_BUSY } from './identity-api.js';

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
  return { seen, api: createIdentityApi(client, async () => undefined) };
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
    const through = (body: unknown) => createIdentityApi(createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch }), async () => undefined);
    expect(await through({ signedIn: false, endedBy: 'another_sign_in' }).signedIn()).toEqual({ signedIn: false, endedBy: 'another_sign_in' });
    await expect(through({ signedIn: false, endedBy: 'session abc123' }).signedIn()).rejects.toBeInstanceOf(ResponseSchemaError);
    await expect(through({ signedIn: 'yes' }).signedIn()).rejects.toBeInstanceOf(ResponseSchemaError);
  });
});

describe('a busy refusal is waited out, and only that (M8-57, D129)', () => {
  const refused = (status: number, retryable: boolean) => new ApiProblemError({ type: 't', title: 'x', status, code: 'Unavailable', retryable, correlationId: 'c' } as never);
  function busyThen(failures: unknown[], random: () => number = () => 0.5) {
    const waits: number[] = [];
    let calls = 0;
    const client = {
      request: async () => {
        const failure = failures[calls];
        calls += 1;
        if (failure !== undefined) throw failure;
        return {};
      },
      requestBytes: async () => undefined,
    } as unknown as ApiClient;
    return { api: createIdentityApi(client, async (ms) => void waits.push(ms), random), waits, calls: () => calls };
  }

  it('tries again once, and gets through when the queue has cleared', async () => {
    const { api, waits, calls } = busyThen([refused(503, true)]);
    await api.login('a@example.com', 'a long enough password');
    expect(calls()).toBe(2);
    expect(waits).toHaveLength(1);
  });

  it('waits the delay times a factor from 0.5 to 1.5, so a crowd refused together does not come back together', async () => {
    const low = busyThen([refused(503, true)], () => 0);
    await low.api.login('a@example.com', 'x');
    const high = busyThen([refused(503, true)], () => 1);
    await high.api.login('a@example.com', 'x');
    expect(low.waits).toEqual([1_000]);
    expect(high.waits).toEqual([3_000]);
    expect(BUSY_RETRY_DELAYS_MS).toEqual([2_000]);
  });

  it('retries registering and choosing a new password the same way', async () => {
    const a = busyThen([refused(503, true)]);
    await a.api.register('a@example.com', 'a long enough password');
    expect(a.calls()).toBe(2);
    const b = busyThen([refused(503, true)]);
    await b.api.reset('CODE-123456', 'a new long password');
    expect(b.calls()).toBe(2);
  });

  it('says something a person can act on only when it is still busy after the last try', async () => {
    const { api, calls } = busyThen([refused(503, true), refused(503, true), refused(503, true)]);
    await expect(api.login('a@example.com', 'x')).rejects.toThrow(STILL_BUSY);
    expect(calls()).toBe(BUSY_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a wrong password, a refusal that is not retryable, or a lost connection', async () => {
    for (const failure of [problem(401), refused(503, false), refused(429, true), new TypeError('network')]) {
      const { api, calls, waits } = busyThen([failure]);
      await expect(api.login('a@example.com', 'x')).rejects.toBe(failure);
      expect(calls()).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it('does not retry the calls that are not hashing', async () => {
    const { api, calls } = busyThen([refused(503, true)]);
    await expect(api.requestRecovery('a@example.com')).rejects.toBeInstanceOf(ApiProblemError);
    expect(calls()).toBe(1);
  });

  it('has no timer of its own: a caller must give one, because a retry with no wait is a herd (checked by the compiler)', () => {
    // @ts-expect-error `pause` is required; if it ever becomes optional this line stops being an error and the typecheck fails
    const forgotten = () => createIdentityApi({} as ApiClient);
    expect(forgotten).toBeTypeOf('function');
  });
});
