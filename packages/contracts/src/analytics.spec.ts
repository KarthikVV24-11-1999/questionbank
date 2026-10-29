import { describe, expect, it } from 'vitest';
import { clientEnvelopeSchema, ENVELOPE_FIELDS, uuidV7 } from './analytics.js';
import { findPii, isPersonalKey } from './analytics-pii.js';

const valid = () => ({
  event_id: uuidV7(Date.parse('2026-10-29T08:00:00.000Z'), new Uint8Array(10).fill(7)),
  event_name: 'mock.diagnostic_viewed',
  event_version: 1,
  occurred_at: '2026-10-29T08:00:00.000Z',
  actor: { kind: 'human', pseudonymous_id: 'dev-3f2c9b1a' },
  session_id: 'ses-9c1d4e7f',
  surface: 'web',
  app_version: '0.7.0',
  device_class: 'mid',
  network_class: '4g',
  tenant_id: '00000000-0000-0000-0000-000000000000',
  context: {},
  payload: { findings_shown: 3 },
});

describe('the envelope', () => {
  it('requires every field of §1 but received_at, which is the edge\'s', () => {
    expect(clientEnvelopeSchema.safeParse(valid()).success).toBe(true);
    const required = ENVELOPE_FIELDS.filter((field) => field !== 'received_at');
    for (const field of required) {
      const damaged: Record<string, unknown> = valid();
      delete damaged[field];
      expect(clientEnvelopeSchema.safeParse(damaged).success, field).toBe(false);
    }
    expect(clientEnvelopeSchema.safeParse({ ...valid(), received_at: '2026-10-29T08:00:01.000Z' }).success).toBe(false);
  });

  it('keeps a name or an address out of the places an identifier goes', () => {
    for (const bad of ['Asha Verma', 'asha@example.com', '']) {
      expect(clientEnvelopeSchema.safeParse({ ...valid(), actor: { kind: 'human', pseudonymous_id: bad } }).success, bad).toBe(false);
      expect(clientEnvelopeSchema.safeParse({ ...valid(), session_id: bad }).success, bad).toBe(false);
    }
  });
});

describe('a UUIDv7', () => {
  it('carries the instant, the version and the variant, and is the same for the same bytes', () => {
    const id = uuidV7(Date.parse('2026-10-29T08:00:00.000Z'), new Uint8Array(10).fill(255));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(Number.parseInt(id.replace(/-/gu, '').slice(0, 12), 16)).toBe(Date.parse('2026-10-29T08:00:00.000Z'));
    expect(uuidV7(1, new Uint8Array(10).fill(1))).toBe(uuidV7(1, new Uint8Array(10).fill(1)));
    expect(uuidV7(1, new Uint8Array(10).fill(1))).not.toBe(uuidV7(1, new Uint8Array(10).fill(2)));
  });

  it('refuses an instant it cannot hold and bytes it does not have', () => {
    expect(() => uuidV7(-1, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidV7(2 ** 48, new Uint8Array(10))).toThrow(RangeError);
    expect(() => uuidV7(1, new Uint8Array(9))).toThrow(RangeError);
  });
});

describe('the personal-data scan', () => {
  it('finds a personal field name wherever it sits, with or without case and separators, and not the catalog\'s own event_name', () => {
    expect(findPii({ a: { 'First_Name': 'x' } })).toEqual([{ path: '$.a.First_Name', kind: 'key' }]);
    expect(findPii({ phoneNumber: 'x' })).toHaveLength(1);
    expect(isPersonalKey('event_name')).toBe(false);
  });

  it('finds an email address, a phone number in the ways people write one, and free text, in a value under a harmless key', () => {
    expect(findPii({ note: 'asha.verma@example.com' })).toEqual([{ path: '$.note', kind: 'email' }]);
    for (const phone of ['+91 98765 43210', '9876543210', '(022) 2345-6789', '+919876543210']) expect(findPii({ note: phone }), phone).toEqual([{ path: '$.note', kind: 'phone' }]);
    expect(findPii({ note: 'Asha Verma' })).toEqual([{ path: '$.note', kind: 'free-text' }]);
    expect(findPii({ n: 9876543210 })).toEqual([{ path: '$.n', kind: 'phone' }]);
    expect(findPii(['x', { y: 'a b' }])).toEqual([{ path: '$[1].y', kind: 'free-text' }]);
  });

  it('does not mistake an identifier, a timestamp or a count for any of them', () => {
    const clean = { id: '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a', zeros: '00000000-0000-0000-0000-000000000000', at: '2026-10-29T08:00:00.000Z', ms: 123456, version: '0.7.0', flag: true, none: null, list: ['recommendation', 'dev-3f2c9b1a'] };
    expect(findPii(clean)).toEqual([]);
  });
});
