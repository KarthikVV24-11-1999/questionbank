import { createHash, randomBytes } from 'node:crypto';
import type { TokenFactory } from '../application/ports.js';

/** 32 bytes from the operating system's generator, as base64url; stored only as its SHA-256, so a leaked row is not a set of live logins. */
export class CryptoTokenFactory implements TokenFactory {
  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashToken(token: string): Uint8Array {
    return createHash('sha256').update(token, 'utf8').digest();
  }
}
