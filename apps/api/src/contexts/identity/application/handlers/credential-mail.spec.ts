import { describe, expect, it } from 'vitest';
import type { MailMessage, MailPort, OneTimeTokenStore } from '../ports.js';
import { issueAndMail } from './credential-handlers.js';

const USER = { userId: 'user-1', email: 'asha@example.com', emailNormalized: 'asha@example.com', emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: new Date('2026-11-04T09:00:00Z') };
const NOW = new Date('2026-11-04T09:00:00Z');

function rig(mail: MailPort, publicUrl?: string) {
  const issued: unknown[] = [];
  const oneTime = { issue: async (row: unknown) => void issued.push(row) } as unknown as OneTimeTokenStore;
  const tokens = { newToken: () => 'TOKEN-1', hashToken: (token: string) => new TextEncoder().encode(`hash(${token})`) };
  return { issued, deps: { oneTime, mail, tokens, identifiers: { next: () => 'id-1' }, publicUrl } as unknown as Parameters<typeof issueAndMail>[0] };
}
const collecting = () => {
  const sent: MailMessage[] = [];
  return { sent, mail: { send: async (message: MailMessage) => void sent.push(message) } };
};
const refusing: MailPort = { send: async () => Promise.reject(new Error('provider said no')) };

describe('the message a code travels in', () => {
  it('carries a link whose code is in the fragment, so no server and no referrer sees it, when the app has an address', async () => {
    const { sent, mail } = collecting();
    await issueAndMail(rig(mail, 'https://learn.example.org').deps, USER, 'email_verification', NOW);
    await issueAndMail(rig(mail, 'https://learn.example.org').deps, USER, 'password_recovery', NOW);
    expect(sent[0]!.body).toBe('Your confirmation code is TOKEN-1. It works once, for 48 hours. Or open https://learn.example.org/#verify=TOKEN-1');
    expect(sent[1]!.body).toBe('Your password reset code is TOKEN-1. It works once, for one hour. Or open https://learn.example.org/#reset=TOKEN-1 If you did not ask for it, ignore this message.');
  });

  it('carries the code alone when the app has no address', async () => {
    const { sent, mail } = collecting();
    await issueAndMail(rig(mail).deps, USER, 'email_verification', NOW);
    expect(sent[0]!.body).toBe('Your confirmation code is TOKEN-1. It works once, for 48 hours.');
  });
});

describe('a message the provider will not take', () => {
  it('is the caller\'s to hear of when the caller asked for it', async () => {
    await expect(issueAndMail(rig(refusing).deps, USER, 'email_verification', NOW)).rejects.toThrow('provider said no');
  });

  it('is reported and swallowed when the answer must not depend on it, leaving the stored code and telling nothing of the address or the code', async () => {
    const reports: unknown[] = [];
    const { issued, deps } = rig(refusing);
    await issueAndMail(deps, USER, 'password_recovery', NOW, { report: (failure) => void reports.push(failure), correlationId: 'corr-9' });
    expect(issued).toHaveLength(1);
    expect(reports).toEqual([{ purpose: 'password_recovery', correlationId: 'corr-9', reason: 'provider said no' }]);
    expect(JSON.stringify(reports)).not.toContain('TOKEN-1');
    expect(JSON.stringify(reports)).not.toContain('asha@example.com');
  });
});
