import { describe, expect, it } from 'vitest';
import { MailSendFailed, SesMail, signRequest } from './ses-mail.js';

const SETTINGS = { region: 'eu-west-1', sender: 'no-reply@mail.example.org', accessKeyId: 'AKIDEXAMPLE0000000', secretAccessKey: 'not-a-real-secret-0000000000000000000000' };
const AT = new Date('2026-11-04T09:00:00.000Z');
const MESSAGE = { to: 'asha@example.com', purpose: 'email_verification', subject: 'Confirm your email address', body: 'Your confirmation code is SECRET-CODE-1. It works once.' } as const;

interface Seen {
  url: string;
  init: RequestInit;
}
function fakeFetch(answer: (seen: Seen) => Response | Promise<Response>, seen: Seen[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return answer({ url, init });
  }) as unknown as typeof fetch;
}

describe('the signature', () => {
  it("matches AWS's published test vector (get-vanilla), so the signing is not only self-consistent", () => {
    const signed = signRequest(
      { method: 'GET', host: 'example.amazonaws.com', path: '/', headers: {}, body: '', service: 'service', region: 'us-east-1', at: new Date('2015-08-30T12:36:00.000Z') },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    );
    expect(signed.amzDate).toBe('20150830T123600Z');
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});

describe('the SES adapter, against a fake provider', () => {
  it('posts one signed JSON request to the regional endpoint, from the sender to the one recipient, with the subject and body as given', async () => {
    const seen: Seen[] = [];
    await new SesMail(SETTINGS, { fetch: fakeFetch(() => new Response('{}', { status: 200 }), seen), now: () => AT }).send(MESSAGE);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
    expect(seen[0]!.init.method).toBe('POST');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      FromEmailAddress: 'no-reply@mail.example.org',
      Destination: { ToAddresses: ['asha@example.com'] },
      Content: { Simple: { Subject: { Data: 'Confirm your email address', Charset: 'UTF-8' }, Body: { Text: { Data: MESSAGE.body, Charset: 'UTF-8' } } } },
    });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-amz-date']).toBe('20261104T090000Z');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE0000000\/20261104\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/u);
  });

  it('signs the body it sends: the same message signed again is the same, and a different recipient is not', async () => {
    const signatureOf = async (to: string) => {
      const seen: Seen[] = [];
      await new SesMail(SETTINGS, { fetch: fakeFetch(() => new Response('{}'), seen), now: () => AT }).send({ ...MESSAGE, to });
      return (seen[0]!.init.headers as Record<string, string>).authorization;
    };
    expect(await signatureOf('asha@example.com')).toBe(await signatureOf('asha@example.com'));
    expect(await signatureOf('asha@example.com')).not.toBe(await signatureOf('ravi@example.com'));
  });

  it('never sends the secret key', async () => {
    const seen: Seen[] = [];
    await new SesMail(SETTINGS, { fetch: fakeFetch(() => new Response('{}'), seen), now: () => AT }).send(MESSAGE);
    expect(JSON.stringify(seen)).not.toContain(SETTINGS.secretAccessKey);
  });

  it('fails the send when the provider refuses, naming the status and its error, and neither the code nor the address', async () => {
    const mail = new SesMail(SETTINGS, { fetch: fakeFetch(() => new Response(JSON.stringify({ __type: 'MessageRejected', message: 'Email address is not verified: asha@example.com SECRET-CODE-1' }), { status: 400 })), now: () => AT });
    const failure = await mail.send(MESSAGE).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(MailSendFailed);
    expect((failure as MailSendFailed).reason).toBe('refused');
    expect((failure as MailSendFailed).message).toBe('the mail provider did not take the message: refused (HTTP 400 MessageRejected)');
    expect((failure as MailSendFailed).message).not.toContain('SECRET-CODE-1');
    expect((failure as MailSendFailed).message).not.toContain('asha@example.com');
  });

  it('fails the send on a refusal that has no readable body', async () => {
    const mail = new SesMail(SETTINGS, { fetch: fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 })), now: () => AT });
    await expect(mail.send(MESSAGE)).rejects.toMatchObject({ reason: 'refused', detail: 'HTTP 502' });
  });

  it('gives up when the provider does not answer in time, rather than hold a registration open', async () => {
    const hang: typeof fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const mail = new SesMail(SETTINGS, { fetch: hang, now: () => AT, timeoutMs: 20 });
    await expect(mail.send(MESSAGE)).rejects.toMatchObject({ reason: 'timed_out' });
  });

  it('fails the send when the provider cannot be reached', async () => {
    const down: typeof fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new SesMail(SETTINGS, { fetch: down, now: () => AT }).send(MESSAGE)).rejects.toMatchObject({ reason: 'unreachable', detail: 'TypeError' });
  });
});
