import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ed25519PackageSigner, isSigningSeed, verifyPackage } from './package-signer.js';

const SEED = Buffer.alloc(32, 7).toString('base64');
const BYTES = new TextEncoder().encode('{"form":{"formId":"f"},"sections":[]}');

describe('the signing seed', () => {
  it('is 32 bytes of base64, and nothing else', () => {
    expect(isSigningSeed(SEED)).toBe(true);
    for (const bad of ['', 'not base64!', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) expect(isSigningSeed(bad), bad).toBe(false);
  });

  it('is refused by the signer without being quoted', () => {
    expect(() => new Ed25519PackageSigner('short')).toThrow('the package signing key must be 32 bytes, base64');
  });
});

describe('signing a package', () => {
  const signer = new Ed25519PackageSigner(SEED);

  it('gives a signature that verifies against the published key, and a digest of the same bytes', () => {
    const signed = signer.sign(BYTES);
    expect(verifyPackage(BYTES, signed.signature, signer.publicKey)).toBe(true);
    expect(signed.keyId).toBe(signer.keyId);
    expect(signed.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is deterministic: the same bytes sign the same way, and another seed signs differently', () => {
    expect(signer.sign(BYTES)).toEqual(signer.sign(BYTES));
    const other = new Ed25519PackageSigner(randomBytes(32).toString('base64'));
    expect(other.sign(BYTES).signature).not.toBe(signer.sign(BYTES).signature);
    expect(other.keyId).not.toBe(signer.keyId);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(signer.sign(BYTES))).toBe(true);
  });
});

describe('tampering is detected (M6-26)', () => {
  const signer = new Ed25519PackageSigner(SEED);
  const { signature } = signer.sign(BYTES);

  it('refuses a package with any one byte changed — every position, not a sample', () => {
    for (let index = 0; index < BYTES.length; index += 1) {
      const tampered = Uint8Array.from(BYTES);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(verifyPackage(tampered, signature, signer.publicKey), `byte ${index}`).toBe(false);
    }
  });

  it('refuses a truncated or extended package', () => {
    expect(verifyPackage(BYTES.slice(0, -1), signature, signer.publicKey)).toBe(false);
    expect(verifyPackage(Uint8Array.from([...BYTES, 32]), signature, signer.publicKey)).toBe(false);
  });

  it('refuses a signature made by another key, and a signature that was altered', () => {
    const other = new Ed25519PackageSigner(randomBytes(32).toString('base64'));
    expect(verifyPackage(BYTES, other.sign(BYTES).signature, signer.publicKey)).toBe(false);
    const flipped = Buffer.from(signature, 'base64');
    flipped[0] = flipped[0]! ^ 0x01;
    expect(verifyPackage(BYTES, flipped.toString('base64'), signer.publicKey)).toBe(false);
  });

  it('answers false rather than throwing on a key or signature that is not one', () => {
    expect(verifyPackage(BYTES, signature, 'bm90IGEga2V5')).toBe(false);
    expect(verifyPackage(BYTES, '', signer.publicKey)).toBe(false);
  });

  it('accepts a key made independently of the signer: the public key is a standard SPKI, not a private format', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    expect(verifyPackage(BYTES, sign(null, BYTES, privateKey).toString('base64'), publicKey.export({ format: 'der', type: 'spki' }).toString('base64'))).toBe(true);
  });
});
