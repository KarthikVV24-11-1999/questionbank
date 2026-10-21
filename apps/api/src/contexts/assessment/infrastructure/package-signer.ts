import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { PackageSigner, SignedPackage } from '../application/ports.js';

/**
 * Signs a form package with Ed25519 (M6-26).
 *
 * **What is signed is the exact byte string the device receives**, not a parsed
 * form of it: a signature over a re-serialization would verify bytes nobody
 * downloaded. The package is byte-identical for the same form (M6-24), so the
 * digest and signature are stable and a CDN may hold the bytes without holding
 * the ability to alter them undetected.
 *
 * The key is a 32-byte seed, base64 in configuration; there is one, and no
 * rotation (D59). Ed25519 is deterministic,
 * so signing the same bytes twice gives the same signature — which is what lets a
 * test pin it and a cache key on it.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const SEED_BYTES = 32;

export function isSigningSeed(base64: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(base64) && Buffer.from(base64, 'base64').length === SEED_BYTES;
}

export class Ed25519PackageSigner implements PackageSigner {
  readonly keyId: string;
  readonly publicKey: string;
  private readonly privateKey: KeyObject;

  constructor(seedBase64: string) {
    if (!isSigningSeed(seedBase64)) throw new Error(`the package signing key must be ${SEED_BYTES} bytes, base64`);
    this.privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedBase64, 'base64')]),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(this.privateKey).export({ format: 'der', type: 'spki' });
    this.publicKey = spki.toString('base64');
    this.keyId = keyIdOf(spki);
  }

  sign(bytes: Uint8Array): SignedPackage {
    return Object.freeze({
      digest: createHash('sha256').update(bytes).digest('hex'),
      signature: sign(null, bytes, this.privateKey).toString('base64'),
      keyId: this.keyId,
    });
  }
}

const keyIdOf = (spki: Buffer): string => createHash('sha256').update(spki).digest('hex').slice(0, 16);

/** What a device does: the bytes, the signature and the public key it holds. False on any mismatch, never a throw. */
export function verifyPackage(bytes: Uint8Array, signatureBase64: string, publicKeySpkiBase64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiBase64, 'base64'), format: 'der', type: 'spki' });
    return verify(null, bytes, key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
