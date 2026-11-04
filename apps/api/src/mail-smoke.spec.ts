import { describe, expect, it } from 'vitest';
import type { MailMessage } from './contexts/identity/application/ports.js';
import { run } from './mail-smoke.js';

const SES = { region: 'eu-west-1', sender: 'a@b.example', accessKeyId: 'AKIDEXAMPLE0000000', secretAccessKey: 'hidden-secret-0000000000000000000000' };
const lines = () => {
  const out: string[] = [];
  return { out, write: (line: string) => void out.push(line) };
};

describe('the mail smoke command', () => {
  it('sends one message to the address given, from the settings it was given, and exits 0', async () => {
    const { out, write } = lines();
    const sent: MailMessage[] = [];
    const code = await run(['asha@example.com'], () => ({ ok: true, value: { mailSes: SES } }), write, (settings) => {
      expect(settings).toEqual(SES);
      return { send: async (message) => void sent.push(message) };
    });
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('asha@example.com');
    expect(out).toEqual(['SES took the message for asha@example.com; whether it arrived is for the inbox to say']);
  });

  it('exits 1 and says why when the provider will not take it, without the secret', async () => {
    const { out, write } = lines();
    const code = await run(['asha@example.com'], () => ({ ok: true, value: { mailSes: SES } }), write, () => ({ send: async () => Promise.reject(new Error('refused (HTTP 400 MessageRejected)')) }));
    expect(code).toBe(1);
    expect(out).toEqual(['SES did not take the message: refused (HTTP 400 MessageRejected)']);
    expect(out.join('')).not.toContain(SES.secretAccessKey);
  });

  it('exits 2 and sends nothing with no address, with settings absent, or with settings that do not parse', async () => {
    const never = () => ({ send: async () => Promise.reject(new Error('must not send')) });
    expect(await run([], () => ({ ok: true, value: { mailSes: SES } }), lines().write, never)).toBe(2);
    expect(await run(['a@b.example', 'c@d.example'], () => ({ ok: true, value: { mailSes: SES } }), lines().write, never)).toBe(2);
    const absent = lines();
    expect(await run(['a@b.example'], () => ({ ok: true, value: {} }), absent.write, never)).toBe(2);
    expect(absent.out[0]).toContain('AWS_SECRET_ACCESS_KEY are not set');
    const half = lines();
    expect(await run(['a@b.example'], () => ({ ok: false, error: { key: 'mailSender', message: 'missing MAIL_SENDER' } }), half.write, never)).toBe(2);
    expect(half.out).toEqual(['missing MAIL_SENDER']);
  });
});
