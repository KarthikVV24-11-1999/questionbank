import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailMessage, MailPort } from '../application/ports.js';

/**
 * The development adapters for the mail port (M8-04). No vendor: the provider is a later decision, and this track must not make it by accident.
 *
 * A message carries a secret token in its body, so an adapter that writes it anywhere is a development convenience and nothing more. `DirectoryMail` is that: one file per
 * message. `MemoryMail` keeps them for a test. `UnconfiguredMail` is what a process that is not in development gets, and it fails the send, loudly, rather than quietly writing
 * tokens to a disk.
 */
export class DirectoryMail implements MailPort {
  #sent = 0;

  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.#sent += 1;
    const name = `${this.now().toISOString().replace(/[:.]/gu, '-')}-${String(this.#sent).padStart(4, '0')}-${message.purpose}.txt`;
    await writeFile(join(this.directory, name), `To: ${message.to}\nSubject: ${message.subject}\n\n${message.body}\n`);
  }
}

export class MemoryMail implements MailPort {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

export class MailProviderNotConfigured extends Error {
  constructor() {
    super('no mail provider is configured for this environment');
    this.name = 'MailProviderNotConfigured';
  }
}

export class UnconfiguredMail implements MailPort {
  async send(): Promise<void> {
    throw new MailProviderNotConfigured();
  }
}
