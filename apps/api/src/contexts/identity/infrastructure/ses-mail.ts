import { createHash, createHmac } from 'node:crypto';
import type { MailMessage, MailPort } from '../application/ports.js';

/**
 * Amazon SES behind the mail port (M8-41, D119; the provider is named in docs/TECH-STACK.md).
 *
 * **What this proves and what it does not.** Everything up to the provider call is exercised against a fake `fetch`: the request's shape, its signature (against AWS's
 * published test vector), what a refusal and a timeout do. Whether SES accepts a message from this account is not proved here, because no run of this repository holds an
 * AWS credential or a verified sender (ADR-0013, Tier 3). `docs/M8-ACCEPTANCE.md` records that as blocked, with the command that would.
 *
 * **No SDK.** One call, signed with SigV4 over the standard library, so the dependency tree gains nothing to audit for a single POST. The cost is that the signing is ours:
 * `signRequest` is checked against AWS's own vector, and the adapter only ever signs the one call.
 *
 * **Failure.** A refusal or a timeout throws `MailSendFailed`, carrying the status and the provider's error name and nothing else: the message body holds a secret and the
 * response may echo, so neither is ever copied into the error. What registration does with the failure is decided by its caller (DEC-M8-25).
 */
export interface SesCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SesSettings extends SesCredentials {
  readonly region: string;
  readonly sender: string;
}

export class MailSendFailed extends Error {
  constructor(readonly reason: 'refused' | 'unreachable' | 'timed_out', readonly detail: string) {
    super(`the mail provider did not take the message: ${reason} (${detail})`);
    this.name = 'MailSendFailed';
  }
}

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

export interface SigningInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query?: string;
  /** Headers to sign besides `host` and `x-amz-date`, lower-cased names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly service: string;
  readonly region: string;
  readonly at: Date;
}

/** AWS Signature Version 4: the `Authorization` value and the `x-amz-date` it was made for. */
export function signRequest(input: SigningInput, credentials: SesCredentials): { readonly authorization: string; readonly amzDate: string } {
  const amzDate = input.at.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: input.host, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${(headers[name] as string).trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [input.method, input.path, input.query ?? '', canonicalHeaders, signedHeaders, sha256(input.body)].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, amzDate };
}

export const SES_SEND_TIMEOUT_MS = 8_000;

export class SesMail implements MailPort {
  constructor(
    private readonly settings: SesSettings,
    private readonly transport: { readonly fetch: typeof fetch; readonly now: () => Date; readonly timeoutMs?: number },
  ) {}

  async send(message: MailMessage): Promise<void> {
    const host = `email.${this.settings.region}.amazonaws.com`;
    const body = JSON.stringify({
      FromEmailAddress: this.settings.sender,
      Destination: { ToAddresses: [message.to] },
      Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.body, Charset: 'UTF-8' } } } },
    });
    const path = '/v2/email/outbound-emails';
    const signed = signRequest({ method: 'POST', host, path, headers: { 'content-type': 'application/json' }, body, service: 'ses', region: this.settings.region, at: this.transport.now() }, this.settings);
    let response: Response;
    try {
      response = await this.transport.fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-amz-date': signed.amzDate, authorization: signed.authorization },
        body,
        signal: AbortSignal.timeout(this.transport.timeoutMs ?? SES_SEND_TIMEOUT_MS),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new MailSendFailed(timedOut ? 'timed_out' : 'unreachable', timedOut ? 'no answer in time' : cause instanceof Error ? cause.name : 'unknown');
    }
    if (response.ok) return;
    throw new MailSendFailed('refused', `HTTP ${response.status}${await errorName(response)}`);
  }
}

/** The provider's name for what went wrong, if it gave one in the shape it uses; never the text of the body. */
async function errorName(response: Response): Promise<string> {
  try {
    const parsed: unknown = await response.json();
    const name = typeof parsed === 'object' && parsed !== null ? (parsed as { readonly __type?: unknown; readonly message?: unknown }).__type : undefined;
    return typeof name === 'string' && /^[A-Za-z0-9#.]{1,80}$/u.test(name) ? ` ${name}` : '';
  } catch {
    return '';
  }
}
