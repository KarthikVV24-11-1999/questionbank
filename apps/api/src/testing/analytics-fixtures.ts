import { uuidV7, type ClientEnvelope } from '@questionbank/contracts/analytics';

/** A complete, valid envelope, built the way an emitter builds one. */
export function anEnvelope(over: Partial<ClientEnvelope> = {}): ClientEnvelope {
  const bytes = new Uint8Array(10).map(() => Math.floor(Math.random() * 256));
  return {
    event_id: uuidV7(Date.parse('2026-10-29T08:00:00.000Z'), bytes),
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
    context: { attempt_id: '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a' },
    payload: { findings_shown: 3, deepest_drill_level: 0 },
    ...over,
  };
}

/** What a person's details look like when they get where they must not: a name, an email address and a phone number. */
export const PLANTED_PII = { name: 'Asha Verma', email: 'asha.verma@example.com', phone: '+91 98765 43210' } as const;
