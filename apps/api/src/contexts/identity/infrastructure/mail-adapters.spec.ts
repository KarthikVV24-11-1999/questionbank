import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultMail } from '../public/composition.js';
import { DirectoryMail, MailProviderNotConfigured, MemoryMail, UnconfiguredMail } from './mail-adapters.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const message = { to: 'asha@example.com', purpose: 'password_recovery', subject: 'Reset your password', body: 'Your code is abc.' } as const;

describe('the development mail adapters', () => {
  it('writes a file a message, named by when and what it is for, holding who it is to and what it says', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qb-mail-'));
    roots.push(root);
    const mail = new DirectoryMail(join(root, 'outbox'), () => new Date('2026-11-02T09:00:00.000Z'));
    await mail.send(message);
    await mail.send({ ...message, purpose: 'email_verification' });
    const files = readdirSync(join(root, 'outbox')).sort();
    expect(files).toEqual(['2026-11-02T09-00-00-000Z-0001-password_recovery.txt', '2026-11-02T09-00-00-000Z-0002-email_verification.txt']);
    expect(readFileSync(join(root, 'outbox', files[0]!), 'utf8')).toBe('To: asha@example.com\nSubject: Reset your password\n\nYour code is abc.\n');
  });

  it('keeps messages in memory for a test', async () => {
    const mail = new MemoryMail();
    await mail.send(message);
    expect(mail.sent).toEqual([message]);
  });

  it('refuses to send where no provider is configured, rather than write a secret anywhere', async () => {
    await expect(new UnconfiguredMail().send()).rejects.toBeInstanceOf(MailProviderNotConfigured);
    await expect(new UnconfiguredMail().send()).rejects.toThrow('no mail provider is configured for this environment');
  });

  it('is chosen by environment: a directory in development, memory under test, a refusal in production', () => {
    const environment = { directory: '/nowhere', now: () => new Date() };
    expect(defaultMail({ ...environment, nodeEnv: 'development' })).toBeInstanceOf(DirectoryMail);
    expect(defaultMail({ ...environment, nodeEnv: 'test' })).toBeInstanceOf(MemoryMail);
    expect(defaultMail({ ...environment, nodeEnv: 'production' })).toBeInstanceOf(UnconfiguredMail);
  });
});
