import { describe, expect, it } from 'vitest';
import { boot } from './bootstrap.js';
import { aRig, attemptDto, FakeApi } from './testing/fakes.js';
import { aPackageDocument, aSigner, encode, slotIds } from './testing/signed-package.js';
import { AttemptSession } from './session/attempt-session.js';
import { loadRecord } from './session/persistence.js';

const signer = aSigner();
const key = { keyId: signer.keyId, publicKey: signer.publicKey };
const signedResponse = (document: unknown = aPackageDocument()) => {
  const bytes = encode(document);
  return { bytes, ...signer.sign(bytes), keyId: signer.keyId };
};
const params = (api: FakeApi, rig: ReturnType<typeof aRig>) => ({ api, ports: rig.ports, formId: '00000000-0000-4000-8000-0000000000f1', sessionRef: 'S1', deviceRef: 'd', idempotencyKey: 'begin-1' });

describe('bringing the sitting up (M6-47, M6-48, M6-50)', () => {
  it('verifies the package, creates and starts the attempt, and hands over a session on the server\'s deadline and cap', async () => {
    const rig = aRig();
    const api = new FakeApi(signedResponse(), key);
    const result = await boot(params(api, rig));
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(api.calls).toEqual(['getPackage', 'getSigningKey', 'createAttempt', 'startAttempt']);
    expect(api.createdKeys).toEqual(['begin-1']);
    expect(result.form.sections[0]!.slots.map((slot) => slot.slotId)).toEqual([...slotIds]);
    expect(result.session.getSnapshot()).toMatchObject({ phase: 'in_progress', intervalCapMs: 90_000, remainingMs: 10_800_000 });
  });

  it('opens nothing and creates nothing when the package does not verify — not an attempt, not a start, not a session', async () => {
    const rig = aRig();
    const response = signedResponse();
    const tampered = Uint8Array.from(response.bytes);
    tampered[30] = tampered[30]! ^ 0x01;
    const api = new FakeApi({ ...response, bytes: tampered, digest: aSigner().sign(tampered).digest }, key);
    const result = await boot(params(api, rig));
    expect(result).toEqual({ kind: 'package-refused', refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    expect(api.calls).toEqual(['getPackage', 'getSigningKey']);
    expect(rig.storage.data.size).toBe(0);
  });

  it('refuses a package with no signature, before it has made anything', async () => {
    const rig = aRig();
    const api = new FakeApi({ ...signedResponse(), signature: null }, key);
    expect(await boot(params(api, rig))).toEqual({ kind: 'package-refused', refusal: 'SIGNATURE_MISSING' });
    expect(api.calls).not.toContain('createAttempt');
  });

  it('carries on against the same server deadline when this device was already sitting the attempt — and creates nothing', async () => {
    const first = aRig();
    const api1 = new FakeApi(signedResponse(), key);
    const opened = await boot(params(api1, first));
    if (opened.kind !== 'ready') throw new Error('not ready');
    opened.session.goTo(slotIds[0]);
    opened.session.select(slotIds[0], 'b');

    const reloaded = aRig({ storage: first.storage, newId: () => `reload-${Math.random()}` });
    const api2 = new FakeApi(signedResponse(), key);
    api2.stored = attemptDto({ formId: '00000000-0000-4000-8000-0000000000f1', serverNow: '2026-10-21T10:30:00.000Z' });
    const resumed = await boot(params(api2, reloaded));
    expect(resumed.kind).toBe('ready');
    if (resumed.kind !== 'ready') return;
    expect(api2.calls).toEqual(['getPackage', 'getSigningKey', 'getAttempt']);
    // an hour of the three-hour sitting is left, whatever the app was doing meanwhile
    expect(resumed.session.getSnapshot().remainingMs).toBe(3_600_000);
    expect(resumed.session.getSnapshot().projection.slots.find((slot) => slot.slot === slotIds[0])?.answer).toBe('b');
  });

  it('starts afresh if what the device wrote down is for another form, or the server no longer has the attempt in play', async () => {
    const first = aRig();
    const opened = await boot(params(new FakeApi(signedResponse(), key), first));
    expect(opened.kind).toBe('ready');
    const api = new FakeApi(signedResponse(), key);
    api.stored = attemptDto({ formId: 'another-form' });
    expect((await boot(params(api, aRig({ storage: first.storage })))).kind).toBe('ready');
    expect(api.calls).toContain('createAttempt');

    const abandoned = new FakeApi(signedResponse(), key);
    abandoned.stored = attemptDto({ formId: '00000000-0000-4000-8000-0000000000f1', state: 'abandoned' });
    expect((await boot(params(abandoned, aRig({ storage: first.storage })))).kind).toBe('ready');
    expect(abandoned.calls).toContain('createAttempt');
  });

  it('comes up on the result when the server already has the submission', async () => {
    const first = aRig();
    const opened = await boot(params(new FakeApi(signedResponse(), key), first));
    if (opened.kind !== 'ready') throw new Error('not ready');
    const api = new FakeApi(signedResponse(), key);
    api.stored = attemptDto({ formId: '00000000-0000-4000-8000-0000000000f1', state: 'submitted', submission: { reason: 'manual', submittedAt: 't', pastDeadline: false } });
    const resumed = await boot(params(api, aRig({ storage: first.storage })));
    expect(resumed.kind === 'ready' && resumed.session.getSnapshot().phase).toBe('submitted');
  });

  it('says it cannot start when the server gives no deadline', async () => {
    const rig = aRig();
    const api = new FakeApi(signedResponse(), key);
    api.startAttempt = async () => attemptDto({ deadline: null });
    expect(await boot(params(api, rig))).toEqual({ kind: 'cannot-start', reason: 'the server did not give a deadline' });
    expect(loadRecord(rig.storage, 'att-1')).toBeNull();
    expect(AttemptSession).toBeDefined();
  });

  it('lets a failure to reach the server for the package or the key surface, rather than invent a package', async () => {
    const rig = aRig();
    await expect(boot(params(new FakeApi(signedResponse(), new Error('key route down')), rig))).rejects.toThrow('key route down');
  });
});
