import { describe, expect, it } from 'vitest';
import { aPackageDocument, aSigner, encode, slotIds } from '../testing/signed-package.js';
import { loadPackage, type PackageResponse } from './load.js';

const signer = aSigner();
const key = { keyId: signer.keyId, publicKey: signer.publicKey };
const signed = (document: unknown = aPackageDocument()): PackageResponse => {
  const bytes = encode(document);
  const { signature, digest } = signer.sign(bytes);
  return { bytes, signature, digest, keyId: signer.keyId };
};

describe('bringing a package to the screen (M6-48)', () => {
  it('parses a package once it is verified, and keeps the digest that vouched for it', async () => {
    const loaded = await loadPackage(signed(), key);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.form.sections[0]!.slots.map((slot) => slot.slotId)).toEqual([...slotIds]);
    expect(loaded.digest).toMatch(/^sha256=[0-9a-f]{64}$/u);
  });

  it('refuses a package with no signature, with no digest, or when no key could be had — before looking inside it', async () => {
    expect(await loadPackage({ ...signed(), signature: null }, key)).toEqual({ ok: false, refusal: 'SIGNATURE_MISSING' });
    expect(await loadPackage({ ...signed(), digest: null }, key)).toEqual({ ok: false, refusal: 'SIGNATURE_MISSING' });
    expect(await loadPackage(signed(), null)).toEqual({ ok: false, refusal: 'KEY_MISSING' });
  });

  it('refuses a package signed under another key id than the one in hand', async () => {
    expect(await loadPackage({ ...signed(), keyId: 'someone-elses' }, key)).toEqual({ ok: false, refusal: 'KEY_ID_DOES_NOT_MATCH' });
    expect(await loadPackage({ ...signed(), keyId: null }, key)).toEqual({ ok: false, refusal: 'KEY_ID_DOES_NOT_MATCH' });
  });

  it('refuses a package with a content byte flipped and a package with a signature byte flipped, handing back no form', async () => {
    const response = signed();
    const content = Uint8Array.from(response.bytes);
    content[40] = content[40]! ^ 0x01;
    const tamperedContent = await loadPackage({ ...response, bytes: content, digest: aSigner().sign(content).digest }, key);
    expect(tamperedContent).toEqual({ ok: false, refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    expect('form' in tamperedContent).toBe(false);

    const raw = Uint8Array.from(atob(response.signature!), (c) => c.charCodeAt(0));
    raw[5] = raw[5]! ^ 0x01;
    const tamperedSignature = await loadPackage({ ...response, signature: btoa(String.fromCharCode(...raw)) }, key);
    expect(tamperedSignature).toEqual({ ok: false, refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    expect('form' in tamperedSignature).toBe(false);
  });

  it('refuses a package that verifies but is not one this build understands: not JSON, or not the format', async () => {
    const notJson = new TextEncoder().encode('{not json');
    const a = { bytes: notJson, ...signer.sign(notJson), keyId: signer.keyId };
    expect(await loadPackage(a, key)).toEqual({ ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' });
    expect(await loadPackage(signed({ ...aPackageDocument(), formatVersion: 2 }), key)).toEqual({ ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' });
    expect(await loadPackage(signed({ nonsense: true }), key)).toEqual({ ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' });
  });
});
