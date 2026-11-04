import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRecordingTelemetry } from '../../platform/observability/recording-telemetry.js';
import { createApplication } from '../../platform/composition/app-factory.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { unlimited } from '../../testing/rate-limits.js';
import { serveOnLoopback } from '../../testing/loopback.js';

/**
 * What the configuration does to the mail a process sends (M8-41, DEC-M8-27): the settings reach the adapter, and the adapter's request reaches `fetch`, in the composed application. The provider is
 * a fake `fetch`, so this proves everything up to the provider's door and not that SES accepts the message (D120).
 */
const SES = { region: 'eu-west-1', sender: 'no-reply@mail.example.org', accessKeyId: 'AKIDEXAMPLE0000000', secretAccessKey: 'a-secret-that-is-not-one-0000000000' };
const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
const apps: INestApplication[] = [];
beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  for (const app of apps) await app.close();
  await database.revertMigrations();
  await database.close();
});

async function serving(over: Partial<typeof COMPOSED_CONFIG> & { mailSes?: typeof SES; publicUrl?: string }, logWrite?: (line: string) => void): Promise<INestApplication> {
  const app = await createApplication({ ...COMPOSED_CONFIG, nodeEnv: 'development', ...over }, { ...(logWrite === undefined ? {} : { logWrite }), pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => new Date() }, identifiers: uuidFactory, limiter: unlimited });
  await serveOnLoopback(app);
  apps.push(app);
  return app;
}

describe('a process with SES configured', () => {
  it('sends a registration\'s message to SES, from the sender, to the address, with a link on the app\'s address', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{}', { status: 200 })));
    const app = await serving({ mailSes: SES, publicUrl: 'https://learn.example.org' });
    const address = `person-${randomUUID().slice(0, 8)}@example.com`;
    expect((await request(app.getHttpServer()).post('/v1/identity/register').send({ email: address, password: PASSWORD })).status).toBe(202);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.FromEmailAddress).toBe(SES.sender);
    expect(sent.Destination.ToAddresses).toEqual([address]);
    expect(sent.Content.Simple.Body.Text.Data).toMatch(/Or open https:\/\/learn\.example\.org\/#verify=[A-Za-z0-9_-]{20,}$/u);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toContain(`Credential=${SES.accessKeyId}/`);
    expect(JSON.stringify(calls)).not.toContain(SES.secretAccessKey);
  });

  it('answers a registration the same when SES refuses it, keeps the account, and says so once in the log without the address or the code', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ __type: 'MessageRejected' }), { status: 400 }));
    const lines: string[] = [];
    const app = await serving({ mailSes: SES }, (line) => void lines.push(line));
    const address = `person-${randomUUID().slice(0, 8)}@example.com`;
    expect((await request(app.getHttpServer()).post('/v1/identity/register').send({ email: address, password: PASSWORD })).status).toBe(202);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM identity.app_user WHERE email_normalized = $1', [address])).rows[0].n).toBe(1);
    const failures = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['errorCode'] === 'MAIL_SEND_FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ level: 'warn', context: 'identity.mail', route: 'email_verification', reason: 'email_verification: the mail provider did not take the message: refused (HTTP 400 MessageRejected)' });
    expect(lines.join('\n')).not.toContain(address);
  });
});
