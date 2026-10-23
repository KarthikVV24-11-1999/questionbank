import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@questionbank/contracts/client';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAssessmentApi } from './assessment-api.js';
import { attemptSchema, ingestReportSchema, signingKeySchema } from './schemas.js';
import { attemptDto } from '../testing/fakes.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function rig(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(init.body as string) };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  const api = createAssessmentApi(createClient({ baseUrl: 'http://api.test', getToken: () => 'tok', fetchImpl, correlationId: () => 'corr' }));
  return { api, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the learner app\'s conversation with the server', () => {
  it('creates, starts and reads an attempt through the typed client, with the idempotency key as a header', async () => {
    const { api, calls } = rig(() => json({ attempt: attemptDto(), replayed: false }));
    expect((await api.createAttempt('f', 's', 'key-1')).attemptId).toBe('att-1');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://api.test/v1/assessment/attempts', body: { formId: 'f', sessionRef: 's' } });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('key-1');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer tok');

    const second = rig(() => json(attemptDto()));
    await second.api.startAttempt('a/b');
    await second.api.getAttempt('a/b');
    expect(second.calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST http://api.test/v1/assessment/attempts/a%2Fb/start', 'GET http://api.test/v1/assessment/attempts/a%2Fb']);
  });

  it('sends events and reports the acknowledged ids and only the rejected ones', async () => {
    const { api, calls } = rig(() =>
      json({ attemptId: 'a', state: 'in_progress', results: [{ eventId: 'e1', outcome: 'accepted' }, { eventId: 'e2', outcome: 'rejected', code: 'X' }, { eventId: 'e3', outcome: 'late' }], acknowledged: ['e1', 'e3'] }),
    );
    const outcome = await api.sendEvents('a', 'dev', [{ eventId: 'e1' } as never]);
    expect(outcome).toEqual({ acknowledged: ['e1', 'e3'], rejected: ['e2'] });
    expect(calls[0]).toMatchObject({ url: 'http://api.test/v1/assessment/attempts/a/events', body: { deviceRef: 'dev' } });
  });

  it('submits with a reason and a key, and reads the result', async () => {
    const { api, calls } = rig((call) => (call.url.endsWith('/result') ? json({ attemptId: 'a', status: 'pending' }) : json(attemptDto())));
    await api.submit('a', 'expiry', 'sub-1');
    expect(calls[0]).toMatchObject({ method: 'POST', body: { reason: 'expiry' } });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('sub-1');
    expect(await api.getResult('a')).toEqual({ attemptId: 'a', status: 'pending' });
  });

  it('reads the package as bytes with its three headers, and the signing key', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { api } = rig((call) =>
      call.url.endsWith('package-signing-key')
        ? json({ algorithm: 'Ed25519', keyId: 'k1', publicKey: 'pk' })
        : new Response(bytes, { status: 200, headers: { 'x-package-signature': 'sig', 'x-package-digest': 'dig', 'x-package-key-id': 'k1' } }),
    );
    const response = await api.getPackage('f/1');
    expect([...response.bytes]).toEqual([1, 2, 3]);
    expect(response).toMatchObject({ signature: 'sig', digest: 'dig', keyId: 'k1' });
    expect(await api.getSigningKey()).toEqual({ keyId: 'k1', publicKey: 'pk' });
  });

  it('gives null for a header the server did not send, so the package is refused downstream rather than guessed at', async () => {
    const { api } = rig(() => new Response(new Uint8Array([1])));
    expect(await api.getPackage('f')).toMatchObject({ signature: null, digest: null, keyId: null });
  });
});

describe('the mirrored schemas are held to the document', () => {
  const doc = parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/contracts/openapi/assessment.yaml'), 'utf8')) as {
    components: { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> };
  };
  const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();

  it('Attempt: every field the server requires is one the client reads, and the client reads no other', () => {
    const attempt = doc.components.schemas['Attempt']!;
    expect([...(attempt.required ?? [])].sort()).toEqual(keysOf(attemptSchema));
  });

  it('IngestReport and the signing key carry the fields the client reads', () => {
    for (const field of keysOf(ingestReportSchema)) expect(Object.keys(doc.components.schemas['IngestReport']!.properties)).toContain(field);
    for (const field of keysOf(signingKeySchema)) expect(Object.keys(doc.components.schemas['PackageSigningKey']!.properties)).toContain(field);
  });
});
