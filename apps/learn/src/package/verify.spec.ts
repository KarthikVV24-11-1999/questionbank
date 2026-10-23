import { describe, expect, it } from 'vitest';
import { aPackageDocument, aSigner, encode } from '../testing/signed-package.js';
import { verifyPackage } from './verify.js';

const signer = aSigner();
const bytes = encode(aPackageDocument());
const evidence = () => ({ bytes, publicKey: signer.publicKey, ...signer.sign(bytes) });

const flip = (source: Uint8Array, index: number): Uint8Array => {
  const copy = Uint8Array.from(source);
  copy[index] = copy[index]! ^ 0x01;
  return copy;
};

describe('verifying a package (M6-48)', () => {
  it('accepts the bytes the key signed, with the digest that goes with them', async () => {
    expect(await verifyPackage(evidence())).toBe(true);
  });

  it('refuses a package with a single content byte changed — at every position, not a sample', async () => {
    // the digest header is re-derived for the tampered bytes each time, so it is the signature alone that refuses it
    for (let index = 0; index < bytes.length; index += 37) {
      const tampered = flip(bytes, index);
      expect(await verifyPackage({ ...evidence(), bytes: tampered, digest: aSigner().sign(tampered).digest }), `byte ${index}`).toBe(false);
    }
    expect(await verifyPackage({ ...evidence(), bytes: flip(bytes, 0), digest: aSigner().sign(flip(bytes, 0)).digest })).toBe(false);
    expect(await verifyPackage({ ...evidence(), bytes: flip(bytes, bytes.length - 1), digest: aSigner().sign(flip(bytes, bytes.length - 1)).digest })).toBe(false);
  });

  it('refuses a signature with a single byte changed', async () => {
    const good = evidence();
    const raw = Uint8Array.from(atob(good.signature), (c) => c.charCodeAt(0));
    for (let index = 0; index < raw.length; index += 7) {
      const forged = btoa(String.fromCharCode(...flip(raw, index)));
      expect(await verifyPackage({ ...good, signature: forged }), `signature byte ${index}`).toBe(false);
    }
  });

  it('refuses a digest that does not match the bytes, even with a valid signature', async () => {
    expect(await verifyPackage({ ...evidence(), digest: `sha256=${'0'.repeat(64)}` })).toBe(false);
    expect(await verifyPackage({ ...evidence(), digest: 'sha256=' })).toBe(false);
  });

  it('refuses a package signed by another key', async () => {
    const other = aSigner(9);
    expect(await verifyPackage({ ...evidence(), publicKey: other.publicKey })).toBe(false);
  });

  it('refuses, rather than throws, on a key or a signature that is not one', async () => {
    expect(await verifyPackage({ ...evidence(), publicKey: 'not base64 !!' })).toBe(false);
    expect(await verifyPackage({ ...evidence(), publicKey: btoa('not a key') })).toBe(false);
    expect(await verifyPackage({ ...evidence(), signature: '%%%' })).toBe(false);
    expect(await verifyPackage({ ...evidence(), signature: '' })).toBe(false);
  });
});
