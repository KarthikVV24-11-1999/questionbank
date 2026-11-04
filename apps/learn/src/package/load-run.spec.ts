import { describe, expect, it } from 'vitest';
import { aRunDocument, aSigner, encode, slotIds } from '../testing/signed-package.js';
import { loadRunPackage } from './load.js';

const signer = aSigner();
const key = { keyId: signer.keyId, publicKey: signer.publicKey };
const response = (document: unknown = aRunDocument()) => {
  const bytes = encode(document);
  return { bytes, ...signer.sign(bytes), keyId: signer.keyId };
};

describe('a practice run\'s package is brought to the screen on a form\'s terms (M8-23, M8-24)', () => {
  it('opens a package that verifies and is this run\'s, as one section of its slots in order', async () => {
    const loaded = await loadRunPackage(response(), key, 'run-1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.paper.sections).toHaveLength(1);
    expect(loaded.paper.sections[0]!.slots.map((slot) => slot.slotId)).toEqual([...slotIds]);
    expect(loaded.paper.stimuli).toHaveLength(1);
  });

  it('puts the slots in the order of their ordinals whatever the order the bytes list them', async () => {
    const document = aRunDocument();
    const loaded = await loadRunPackage(response({ ...document, slots: [...document.slots].reverse() }), key, 'run-1');
    expect(loaded.ok && loaded.paper.sections[0]!.slots.map((slot) => slot.ordinal)).toEqual([1, 2, 3]);
  });

  it('refuses another run\'s package, which verifies and is not the one asked for', async () => {
    expect(await loadRunPackage(response(aRunDocument('run-2')), key, 'run-1')).toEqual({ ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' });
  });

  it('refuses a form\'s package in its place, and one in a shape it does not understand', async () => {
    const { aPackageDocument } = await import('../testing/signed-package.js');
    expect((await loadRunPackage(response(aPackageDocument()), key, 'run-1')).ok).toBe(false);
    expect((await loadRunPackage(response({ ...aRunDocument(), formatVersion: 2 }), key, 'run-1')).ok).toBe(false);
  });

  it('refuses bytes that do not verify, a missing signature, a missing key, another key, and bytes that are not JSON', async () => {
    const good = response();
    const tampered = Uint8Array.from(good.bytes);
    tampered[30] = tampered[30]! ^ 0x01;
    expect(await loadRunPackage({ ...good, bytes: tampered, digest: signer.sign(tampered).digest }, key, 'run-1')).toEqual({ ok: false, refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    expect(await loadRunPackage({ ...good, signature: null }, key, 'run-1')).toEqual({ ok: false, refusal: 'SIGNATURE_MISSING' });
    expect(await loadRunPackage({ ...good, digest: null }, key, 'run-1')).toEqual({ ok: false, refusal: 'SIGNATURE_MISSING' });
    expect(await loadRunPackage(good, null, 'run-1')).toEqual({ ok: false, refusal: 'KEY_MISSING' });
    expect(await loadRunPackage({ ...good, keyId: 'other' }, key, 'run-1')).toEqual({ ok: false, refusal: 'KEY_ID_DOES_NOT_MATCH' });
    const notJson = new TextEncoder().encode('not json');
    expect(await loadRunPackage({ bytes: notJson, ...signer.sign(notJson), keyId: signer.keyId }, key, 'run-1')).toEqual({ ok: false, refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' });
  });
});
