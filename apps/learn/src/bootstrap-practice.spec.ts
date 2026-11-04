import { describe, expect, it } from 'vitest';
import { bootPractice } from './bootstrap.js';
import { AttemptSession } from './session/attempt-session.js';
import { aRig, attemptWithLogDto, FakeApi } from './testing/fakes.js';
import { aRunDocument, aSigner, encode, slotIds } from './testing/signed-package.js';

const signer = aSigner();
const key = { keyId: signer.keyId, publicKey: signer.publicKey };
const signedRun = (document: unknown = aRunDocument()) => {
  const bytes = encode(document);
  return { bytes, ...signer.sign(bytes), keyId: signer.keyId };
};
const RUN = { attemptId: 'run-1', mode: 'practice' as const, formId: null, sessionRef: null, shiftId: null, durationMs: null, windowClosesAt: null, deadline: null, startedAt: '2026-11-04T09:00:00.000Z', serverNow: '2026-11-04T09:05:00.000Z', slotCount: 3 };
const inProgress = (over = {}) => attemptWithLogDto({ ...RUN, state: 'in_progress', ...over });
function server(over: Partial<ReturnType<typeof inProgress>> | null = {}) {
  const api = new FakeApi(signedRun(), key);
  api.practicePackageResponse = signedRun();
  if (over !== null) api.stored = inProgress(over);
  return api;
}
const params = (api: FakeApi, rig: ReturnType<typeof aRig>) => ({ api, ports: rig.ports, attemptId: 'run-1', deviceRef: 'phone' });

describe('bringing a practice run up to be sat (M8-24)', () => {
  it('verifies the run\'s package first, reads the attempt, and hands over a session with no clock', async () => {
    const rig = aRig();
    const api = server();
    const result = await bootPractice(params(api, rig));
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(api.calls).toEqual(['getPracticePackage run-1', 'getSigningKey', 'getAttempt']);
    expect(result.form.sections[0]!.slots.map((slot) => slot.slotId)).toEqual([...slotIds]);
    expect(result.session.getSnapshot()).toMatchObject({ phase: 'in_progress', remainingMs: null, intervalCapMs: 90_000 });
  });

  it('starts a run that is only created, and reads it again, before it is sat', async () => {
    const rig = aRig();
    const api = server({ state: 'created', startedAt: null });
    api.startAttempt = async () => {
      api.calls.push('startAttempt');
      api.stored = inProgress();
      return inProgress();
    };
    const result = await bootPractice(params(api, rig));
    expect(result.kind).toBe('ready');
    expect(api.calls).toEqual(['getPracticePackage run-1', 'getSigningKey', 'getAttempt', 'startAttempt', 'getAttempt']);
  });

  it('opens nothing, and asks the server for nothing about the attempt, when the package does not verify', async () => {
    const rig = aRig();
    const api = server();
    const response = signedRun();
    const tampered = Uint8Array.from(response.bytes);
    tampered[30] = tampered[30]! ^ 0x01;
    api.practicePackageResponse = { ...response, bytes: tampered, digest: aSigner().sign(tampered).digest };
    expect(await bootPractice(params(api, rig))).toEqual({ kind: 'package-refused', refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    expect(api.calls).toEqual(['getPracticePackage run-1', 'getSigningKey']);
    expect(rig.records.commits).toEqual([]);
  });

  it('refuses the package of another run, which verifies', async () => {
    const rig = aRig();
    const api = server();
    api.practicePackageResponse = signedRun(aRunDocument('run-2'));
    expect(await bootPractice(params(api, rig))).toEqual({ kind: 'package-refused', refusal: 'NOT_A_PACKAGE_THIS_BUILD_UNDERSTANDS' });
  });

  it('says a run that is not there, or is someone else\'s, is not there, and starts nothing', async () => {
    const rig = aRig();
    const api = server(null);
    api.practicePackageResponse = signedRun();
    api.attemptFailure = Object.assign(new Error('no attempt'), { problem: { status: 404 } });
    expect(await bootPractice(params(api, rig))).toEqual({ kind: 'cannot-start', reason: 'there is no such run' });
    const missing = server();
    missing.practicePackageResponse = Object.assign(new Error('no such run'), { problem: { status: 404 } });
    await expect(bootPractice(params(missing, rig))).rejects.toThrow('no such run');
  });

  it('will not sit a paper as a run, and says what state a finished-with run is in', async () => {
    const rig = aRig();
    expect(await bootPractice(params(server({ mode: 'mock' }), rig))).toEqual({ kind: 'cannot-start', reason: 'that is not a practice run' });
    expect(await bootPractice(params(server({ state: 'abandoned' }), rig))).toEqual({ kind: 'cannot-start', reason: 'the run is abandoned' });
  });

  it('carries on from the server\'s log when this device has no record: a second device, or storage that was cleared', async () => {
    const rig = aRig();
    const api = server({ events: [{ eventId: 'e1', attemptId: 'run-1', slot: slotIds[0], sequence: 1, monotonicMs: 100, kind: 'visit' } as never] });
    const result = await bootPractice(params(api, rig));
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(result.session.getSnapshot().currentSlot).toBe(slotIds[0]);
  });

  it('carries on from what this device wrote when the server cannot be reached, and loses no answer by it', async () => {
    const rig = aRig();
    const first = await bootPractice(params(server(), rig));
    if (first.kind !== 'ready') throw new Error('should be ready');
    first.session.goTo(slotIds[0]);
    first.session.select(slotIds[0], 'b');
    await rig.records.settle();

    const offline = server();
    offline.attemptFailure = new TypeError('network unreachable');
    const again = await bootPractice(params(offline, rig));
    expect(again.kind).toBe('ready');
    if (again.kind !== 'ready') return;
    expect(again.session.getSnapshot().projection.slots.find((slot) => slot.slot === slotIds[0])?.answer).toBe('b');
    expect(again.session.getSnapshot().remainingMs).toBeNull();
  });

  it('does not hide a server that refuses, nor an outage when the device has written nothing down to carry on from', async () => {
    const rig = aRig();
    const refused = server();
    refused.attemptFailure = Object.assign(new Error('forbidden'), { problem: { status: 403 } });
    await expect(bootPractice(params(refused, rig))).rejects.toThrow('forbidden');
    const unreachable = server();
    unreachable.attemptFailure = new TypeError('network unreachable');
    await expect(bootPractice(params(unreachable, rig))).rejects.toThrow('network unreachable');
  });

  it('does not carry on from a record of a paper that has the same id: a record with a form is not a run\'s', async () => {
    const rig = aRig();
    const first = await bootPractice(params(server(), rig));
    if (first.kind !== 'ready') throw new Error('should be ready');
    first.session.goTo(slotIds[0]);
    await rig.records.settle();
    rig.records.attempts.set('run-1', { ...(rig.records.attempts.get('run-1') as object), formId: 'form-1' });
    const offline = server();
    offline.attemptFailure = new TypeError('network unreachable');
    await expect(bootPractice(params(offline, rig))).rejects.toThrow('network unreachable');
  });

  it('is the same session class a paper uses, so the writer and the send-after-commit ordering are the paper\'s', async () => {
    const result = await bootPractice(params(server(), aRig()));
    expect(result.kind === 'ready' && result.session).toBeInstanceOf(AttemptSession);
  });

  describe('a run that has grown (M8-33)', () => {
    const grown = () => {
      const document = aRunDocument();
      const more = { ...document.slots[2]!, slotId: '00000000-0000-4000-8000-0000000000a9' };
      return { ...document, slots: [...document.slots, more] };
    };

    it('is brought up on the package the run now has: more questions, the first three where they were', async () => {
      const rig = aRig();
      const api = server();
      api.practicePackageResponse = signedRun(grown());
      const result = await bootPractice(params(api, rig));
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') return;
      expect(result.form.sections[0]!.slots.map((slot) => slot.slotId)).toEqual([...slotIds, '00000000-0000-4000-8000-0000000000a9']);
    });

    it('verifies the new package as it verified the first: one that does not pass its check is not opened', async () => {
      const rig = aRig();
      const api = server();
      const response = signedRun(grown());
      const tampered = Uint8Array.from(response.bytes);
      tampered[30] = tampered[30]! ^ 0x01;
      api.practicePackageResponse = { ...response, bytes: tampered, digest: aSigner().sign(tampered).digest };
      const result = await bootPractice(params(api, rig));
      expect(result).toMatchObject({ kind: 'package-refused', refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
    });

    it('refuses a package whose bytes are signed by another key', async () => {
      const rig = aRig();
      const api = server();
      const other = aSigner(9);
      const bytes = encode(grown());
      api.practicePackageResponse = { bytes, ...other.sign(bytes), keyId: signer.keyId };
      expect((await bootPractice(params(api, rig))).kind).toBe('package-refused');
    });
  });
});
