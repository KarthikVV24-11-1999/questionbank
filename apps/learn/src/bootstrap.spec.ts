import { describe, expect, it } from 'vitest';
import { boot } from './bootstrap.js';
import { aRig, attemptDto, attemptWithLogDto, FakeApi } from './testing/fakes.js';
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
    expect(api.calls).toEqual(['getPackage', 'getSigningKey', 'createAttempt', 'startAttempt', 'getAttempt']);
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
    api2.stored = attemptWithLogDto({ formId: '00000000-0000-4000-8000-0000000000f1', serverNow: '2026-10-21T10:30:00.000Z' });
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
    api.stored = attemptWithLogDto({ formId: 'another-form' });
    expect((await boot(params(api, aRig({ storage: first.storage })))).kind).toBe('ready');
    expect(api.calls).toContain('createAttempt');

    const abandoned = new FakeApi(signedResponse(), key);
    abandoned.stored = attemptWithLogDto({ formId: '00000000-0000-4000-8000-0000000000f1', state: 'abandoned' });
    expect((await boot(params(abandoned, aRig({ storage: first.storage })))).kind).toBe('ready');
    expect(abandoned.calls).toContain('createAttempt');
  });

  it('comes up on the result when the server already has the submission', async () => {
    const first = aRig();
    const opened = await boot(params(new FakeApi(signedResponse(), key), first));
    if (opened.kind !== 'ready') throw new Error('not ready');
    const api = new FakeApi(signedResponse(), key);
    api.stored = attemptWithLogDto({ formId: '00000000-0000-4000-8000-0000000000f1', state: 'submitted', submission: { reason: 'manual', submittedAt: 't', pastDeadline: false } });
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

  describe('the device first (D67)', () => {
    const FORM = '00000000-0000-4000-8000-0000000000f1';
    /** A sitting begun on a device whose wall clock ran five minutes behind the server's, then closed with an answer in it. */
    const earlier = async () => {
      const first = aRig();
      first.wall.reading = Date.parse('2026-10-21T08:25:00.000Z');
      const opened = await boot(params(new FakeApi(signedResponse(), key), first));
      if (opened.kind !== 'ready') throw new Error('not ready');
      opened.session.goTo(slotIds[0]);
      opened.session.select(slotIds[0], 'b');
      return first;
    };
    const reopened = (first: Awaited<ReturnType<typeof earlier>>, wall = '2026-10-21T09:25:00.000Z') => {
      const rig = aRig({ storage: first.storage, newId: () => `reopen-${Math.random()}` });
      rig.wall.reading = Date.parse(wall);
      return rig;
    };
    const outage = (api: FakeApi, error: unknown = new TypeError('Failed to fetch')) => {
      api.attemptFailure = error as Error;
      return api;
    };

    it('reads what the device wrote down before it asks the network for anything', async () => {
      const first = await earlier();
      const rig = reopened(first);
      const seen: string[] = [];
      const device = rig.ports.storage;
      const storage = { getItem: (name: string) => (seen.push('device'), device.getItem(name)), setItem: (name: string, value: string) => device.setItem(name, value), removeItem: (name: string) => device.removeItem(name) };
      const api = new FakeApi(signedResponse(), key);
      const served = api.getPackage.bind(api);
      api.getPackage = async () => (seen.push('network'), served());
      await boot(params(api, { ...rig, ports: { ...rig.ports, storage } }));
      expect(seen.slice(0, 3)).toEqual(['device', 'device', 'network']);
    });

    it('resumes from the device alone when the server cannot be reached, against the deadline it wrote down and the offset it took', async () => {
      const first = await earlier();
      const rig = reopened(first);
      const api = outage(new FakeApi(signedResponse(), key));
      const resumed = await boot(params(api, rig));
      expect(api.calls).toEqual(['getPackage', 'getSigningKey', 'getAttempt']);
      expect(resumed.kind).toBe('ready');
      if (resumed.kind !== 'ready') return;
      // an hour later by this device's clock, which was five minutes behind the server's: 09:30 by the server's, two hours to go
      expect(resumed.session.getSnapshot().remainingMs).toBe(2 * 3_600_000);
      expect(resumed.session.getSnapshot().projection.slots.find((slot) => slot.slot === slotIds[0])?.answer).toBe('b');
    });

    it('counts a failing server as out of reach, whether it said so in problem details or not, and a refusing one as not', async () => {
      for (const failure of [{ status: 502 }, { problem: { status: 503 } }]) {
        const first = await earlier();
        const resumed = await boot(params(outage(new FakeApi(signedResponse(), key), Object.assign(new Error('down'), failure)), reopened(first)));
        expect(resumed.kind).toBe('ready');
      }
      for (const failure of [{ status: 409 }, { problem: { status: 403 } }, {}]) {
        const first = await earlier();
        const refused = Object.assign(new Error('refused'), failure);
        await expect(boot(params(outage(new FakeApi(signedResponse(), key), refused), reopened(first)))).rejects.toThrow('refused');
      }
    });

    describe('a server that has never heard of the record\'s attempt (DEC-M7-34)', () => {
      /** The server answers the first ask about an attempt (the device's record) with `failure`, and every later one as it normally would. */
      const deniesFirstAsk = (api: FakeApi, failure: object) => {
        const real = api.getAttempt.bind(api);
        let asked = 0;
        api.getAttempt = async (id: string) => {
          asked += 1;
          if (asked === 1) {
            api.calls.push('getAttempt');
            throw Object.assign(new Error('not found'), failure);
          }
          return real(id);
        };
        return api;
      };
      const denied = (api: FakeApi, failure: object) => {
        api.attemptFailure = Object.assign(new Error('answered'), failure);
        return api;
      };

      it('starts a clean attempt rather than throwing, and says nothing when the record held nothing the server lacked', async () => {
        const first = await earlier();
        const record = JSON.parse(first.storage.data.get('qb.attempt.att-1')!);
        first.storage.data.set('qb.attempt.att-1', JSON.stringify({ ...record, acknowledgedIds: record.events.map((event: { eventId: string }) => event.eventId) }));
        const api = deniesFirstAsk(new FakeApi(signedResponse(), key), { status: 404 });
        const result = await boot(params(api, reopened(first)));
        expect(api.calls).toEqual(['getPackage', 'getSigningKey', 'getAttempt', 'createAttempt', 'startAttempt', 'getAttempt']);
        expect(result.kind).toBe('ready');
        expect(result).not.toHaveProperty('discarded');
      });

      it('reports the events the server never had, in the result', async () => {
        const first = await earlier();
        const unsent = (JSON.parse(first.storage.data.get('qb.attempt.att-1')!) as { events: unknown[] }).events.length;
        expect(unsent).toBeGreaterThan(0);
        const api = deniesFirstAsk(new FakeApi(signedResponse(), key), { problem: { status: 404 } });
        const result = await boot(params(api, reopened(first)));
        expect(result).toMatchObject({ kind: 'ready', discarded: { attemptId: 'att-1', unsentEvents: unsent } });
        expect(api.calls).toContain('createAttempt');
      });

      it('does not treat a refusal, a conflict or a failure as a denied record: they still throw, and create nothing', async () => {
        for (const failure of [{ status: 403 }, { status: 409 }, { problem: { status: 403 } }]) {
          const first = await earlier();
          const api = denied(new FakeApi(signedResponse(), key), failure);
          await expect(boot(params(api, reopened(first)))).rejects.toThrow('answered');
          expect(api.calls).not.toContain('createAttempt');
        }
      });
    });

    it('still shows nothing on a paper that does not verify, whatever the device holds and whether or not the server is there', async () => {
      const first = await earlier();
      const response = signedResponse();
      const tampered = Uint8Array.from(response.bytes);
      tampered[30] = tampered[30]! ^ 0x01;
      const api = outage(new FakeApi({ ...response, bytes: tampered, digest: aSigner().sign(tampered).digest }, key));
      expect(await boot(params(api, reopened(first)))).toEqual({ kind: 'package-refused', refusal: 'SIGNATURE_DOES_NOT_VERIFY' });
      expect(api.calls).toEqual(['getPackage', 'getSigningKey']);
    });

    it('does not carry a record of one form into the paper of another when it cannot ask the server', async () => {
      const first = await earlier();
      const record = JSON.parse(first.storage.data.get('qb.attempt.att-1')!);
      first.storage.data.set('qb.attempt.att-1', JSON.stringify({ ...record, formId: 'another-form' }));
      const api = outage(new FakeApi(signedResponse(), key));
      await expect(boot(params(api, reopened(first)))).rejects.toThrow('Failed to fetch');
      expect(api.calls).not.toContain('createAttempt');
    });

    it('does not resume offline from a record that never took an offset to the server\'s clock or never said which form it was of', async () => {
      for (const missing of ['formId', 'serverOffsetMs']) {
        const first = await earlier();
        const record = JSON.parse(first.storage.data.get('qb.attempt.att-1')!);
        first.storage.data.set('qb.attempt.att-1', JSON.stringify({ ...record, [missing]: null }));
        await expect(boot(params(outage(new FakeApi(signedResponse(), key)), reopened(first)))).rejects.toThrow('Failed to fetch');
      }
      expect(FORM).toBeDefined();
    });
  });

  describe('a device that holds no record of the attempt (D68)', () => {
    const held = (eventId: string, sequence: number, kind: 'visit' | 'select', slot: string, answer?: string) => ({
      eventId, attemptId: 'att-1', slot, sequence, monotonicMs: sequence * 10, kind, ...(answer === undefined ? {} : { answer }),
    });

    it('continues the server\'s log and its numbering, instead of beginning an empty one and numbering from one', async () => {
      const rig = aRig();
      const api = new FakeApi(signedResponse(), key);
      api.stored = attemptWithLogDto({ events: [held('s1', 1, 'visit', slotIds[0]), held('s2', 2, 'select', slotIds[0], 'c'), held('s3', 3, 'visit', slotIds[1])] });
      const resumed = await boot(params(api, rig));
      expect(api.calls).toEqual(['getPackage', 'getSigningKey', 'createAttempt', 'startAttempt', 'getAttempt']);
      if (resumed.kind !== 'ready') throw new Error('not ready');
      expect(resumed.session.getSnapshot().projection.slots.find((slot) => slot.slot === slotIds[0])?.answer).toBe('c');
      resumed.session.select(slotIds[1], 'd');
      const written = loadRecord(rig.storage, 'att-1')!.events;
      expect(written.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(written.at(-1)).toMatchObject({ slot: slotIds[1], kind: 'select', answer: 'd' });
    });
  });
});
