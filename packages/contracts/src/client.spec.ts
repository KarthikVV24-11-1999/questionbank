import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiProblemError, ResponseSchemaError, UnparseableErrorResponse, createClient } from './client.js';

const ROW_SCHEMA = z.object({ id: z.string(), label: z.string() }).strict();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(response: Response): typeof fetch {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe('createClient — success', () => {
  it('parses a response that matches the schema', async () => {
    const fetchImpl = stubFetch(jsonResponse(200, { id: 'a', label: 'Item A' }));
    const client = createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl });

    const result = await client.request({ path: '/v1/items/a', responseSchema: ROW_SCHEMA });
    expect(result).toEqual({ id: 'a', label: 'Item A' });
  });

  it('sends Authorization: Bearer when a token is present, and omits it when absent', async () => {
    let capturedHeaders: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse(200, { id: 'a', label: 'Item A' });
    }) as unknown as typeof fetch;

    const client = createClient({ baseUrl: 'https://api.example/', getToken: () => 'a-real-token', fetchImpl });
    await client.request({ path: '/v1/items/a', responseSchema: ROW_SCHEMA });
    expect(capturedHeaders?.get('authorization')).toBe('Bearer a-real-token');

    const anonymousClient = createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl });
    await anonymousClient.request({ path: '/v1/items/a', responseSchema: ROW_SCHEMA });
    expect(capturedHeaders?.has('authorization')).toBe(false);
  });

  it('propagates a caller-independent X-Correlation-Id on every request', async () => {
    let capturedHeaders: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse(200, { id: 'a', label: 'Item A' });
    }) as unknown as typeof fetch;

    const client = createClient({
      baseUrl: 'https://api.example/',
      getToken: () => null,
      fetchImpl,
      correlationId: () => 'fixed-correlation-id',
    });
    await client.request({ path: '/v1/items/a', responseSchema: ROW_SCHEMA });
    expect(capturedHeaders?.get('x-correlation-id')).toBe('fixed-correlation-id');
  });
});

describe('createClient — an unexpected shape is an error, not a cast', () => {
  it('a response failing the schema throws ResponseSchemaError naming the field', async () => {
    const fetchImpl = stubFetch(jsonResponse(200, { id: 'a' })); // label missing
    const client = createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl });

    const error = await client.request({ path: '/v1/items/a', responseSchema: ROW_SCHEMA }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(ResponseSchemaError);
    expect((error as ResponseSchemaError).issues.some((issue) => issue.path.join('.') === 'label')).toBe(true);
  });

  it('an extra field the schema does not name also fails (schemas are .strict())', async () => {
    const fetchImpl = stubFetch(jsonResponse(200, { id: 'a', label: 'Item A', correctOptionId: 'b' }));
    const client = createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl });

    await expect(client.request({ path: '/v1/items/a', responseSchema: ROW_SCHEMA })).rejects.toBeInstanceOf(
      ResponseSchemaError,
    );
  });
});

describe('createClient — a problem-details body becomes a typed error', () => {
  it('a non-2xx response with a problem-details body throws ApiProblemError', async () => {
    const problem = {
      type: 'https://questionbank.example/problems/notfound',
      title: 'Not found',
      status: 404,
      detail: 'item is not published',
      code: 'NotFound',
      retryable: false,
      correlationId: 'corr-1',
    };
    const fetchImpl = stubFetch(jsonResponse(404, problem));
    const client = createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl });

    const error = await client.request({ path: '/v1/items/x', responseSchema: ROW_SCHEMA }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).problem).toEqual(problem);
    expect((error as ApiProblemError).message).toBe('item is not published');
  });

  it('a non-2xx response with an unparseable body throws UnparseableErrorResponse, never a raw message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    ) as unknown as typeof fetch;
    const client = createClient({ baseUrl: 'https://api.example/', getToken: () => null, fetchImpl });

    const error = await client.request({ path: '/v1/items/x', responseSchema: ROW_SCHEMA }).catch((e) => e as Error);
    expect(error).toBeInstanceOf(UnparseableErrorResponse);
    expect((error as UnparseableErrorResponse).status).toBe(502);
    expect((error as Error).message).not.toContain('<html>');
  });
});
