import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  createLicensingStatus,
  isPublishable,
  LICENSING_STATUSES,
  publicationBlockReason,
  UNRESOLVED_LICENSING,
  type CreateLicensingStatusProps,
  type LicensingStatus,
} from './licensing-status.js';

const NOW = { asOf: '2026-08-09T00:00:00Z' } as const;

function licensed(overrides: Partial<CreateLicensingStatusProps> = {}): CreateLicensingStatusProps {
  return {
    status: 'licensed',
    licenseRef: 'CC-BY-4.0',
    attribution: 'Acme Publishing',
    ...overrides,
  };
}

function build(props: CreateLicensingStatusProps): LicensingStatus {
  return expectValue(createLicensingStatus(props));
}

describe('the status vocabulary', () => {
  it('is the closed set DOMAIN-MODEL §5 names', () => {
    expect([...LICENSING_STATUSES]).toEqual(['owned', 'licensed', 'public_domain', 'unresolved']);
  });

  it('rejects an unknown status', () => {
    const failure = expectError(createLicensingStatus({ status: 'probably_fine' as never }));
    expect(failure.code).toBe('LICENSING_STATUS_UNKNOWN');
  });
});

describe('construction', () => {
  it.each([['owned'], ['public_domain'], ['unresolved']] as const)(
    'constructs %s with nothing else required',
    (status) => {
      expect(build({ status }).status).toBe(status);
    },
  );

  it('constructs licensed with a reference and an attribution', () => {
    expect(build(licensed())).toMatchObject({ licenseRef: 'CC-BY-4.0', attribution: 'Acme Publishing' });
  });

  it('rejects licensed with no licence reference', () => {
    const props: CreateLicensingStatusProps = { status: 'licensed', attribution: 'Acme' };
    expect(expectError(createLicensingStatus(props)).code).toBe('LICENSE_REF_REQUIRED');
  });

  it('rejects licensed with a blank licence reference', () => {
    expect(expectError(createLicensingStatus(licensed({ licenseRef: '  ' }))).code).toBe(
      'LICENSE_REF_REQUIRED',
    );
  });

  it('rejects licensed with no attribution', () => {
    const props: CreateLicensingStatusProps = { status: 'licensed', licenseRef: 'CC-BY-4.0' };
    expect(expectError(createLicensingStatus(props)).code).toBe('ATTRIBUTION_REQUIRED');
  });

  it('rejects licensed with a blank attribution', () => {
    expect(expectError(createLicensingStatus(licensed({ attribution: '' }))).code).toBe(
      'ATTRIBUTION_REQUIRED',
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(build({ status: 'owned' }))).toBe(true);
  });

  it('names where the problem is', () => {
    const props: CreateLicensingStatusProps = { status: 'licensed' };
    expect(expectError(createLicensingStatus(props, 'versions[1].licensing')).location).toBe(
      'versions[1].licensing',
    );
  });
});

describe('expiry', () => {
  it('accepts an ISO-8601 instant on a licence', () => {
    expect(build(licensed({ expiresAt: '2027-01-01T00:00:00Z' })).expiresAt).toBe('2027-01-01T00:00:00Z');
  });

  it('accepts an offset instant and fractional seconds', () => {
    expect(build(licensed({ expiresAt: '2027-01-01T00:00:00.500+05:30' })).expiresAt).toBeDefined();
  });

  it.each([
    ['a bare date', '2027-01-01'],
    ['a local time with no zone', '2027-01-01T00:00:00'],
    ['prose', 'next year'],
  ])('rejects %s as an expiry', (_label, expiresAt) => {
    expect(expectError(createLicensingStatus(licensed({ expiresAt }))).code).toBe('EXPIRY_NOT_A_TIMESTAMP');
  });

  // Silently ignoring it would hide the case that matters: a licence
  // mislabelled as ownership.
  it.each([['owned'], ['public_domain'], ['unresolved']] as const)(
    'rejects an expiry on %s, which does not expire',
    (status) => {
      const failure = expectError(
        createLicensingStatus({ status, expiresAt: '2027-01-01T00:00:00Z' }),
      );
      expect(failure.code).toBe('EXPIRY_ON_UNEXPIRING_STATUS');
    },
  );
});

describe('the default for a new draft', () => {
  // Defaulting the other way is how a corpus ends up with content nobody can
  // account for, which is the question DECISIONS §D item 2 has open.
  it('is unresolved, so an author must state rights deliberately', () => {
    expect(UNRESOLVED_LICENSING).toEqual({ status: 'unresolved' });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(UNRESOLVED_LICENSING)).toBe(true);
  });

  it('is not publishable', () => {
    expect(isPublishable(UNRESOLVED_LICENSING, NOW)).toBe(false);
  });
});

describe('isPublishable', () => {
  it.each([['owned'], ['public_domain']] as const)('permits %s', (status) => {
    expect(isPublishable(build({ status }), NOW)).toBe(true);
  });

  it('permits a licence with no expiry', () => {
    expect(isPublishable(build(licensed()), NOW)).toBe(true);
  });

  it('refuses unresolved, unconditionally (FR-QM-05 rule 4)', () => {
    expect(isPublishable(build({ status: 'unresolved' }), NOW)).toBe(false);
  });

  it('permits a licence that has not yet expired', () => {
    expect(isPublishable(build(licensed({ expiresAt: '2027-01-01T00:00:00Z' })), NOW)).toBe(true);
  });

  it('refuses a licence that has expired', () => {
    expect(isPublishable(build(licensed({ expiresAt: '2026-01-01T00:00:00Z' })), NOW)).toBe(false);
  });

  // A licence expiring at t is expired at t. Serving on the boundary is the
  // same exposure as serving without one.
  it('refuses a licence expiring at exactly the evaluated instant', () => {
    expect(isPublishable(build(licensed({ expiresAt: NOW.asOf })), NOW)).toBe(false);
  });

  it('permits it one second earlier', () => {
    const licence = build(licensed({ expiresAt: NOW.asOf }));
    expect(isPublishable(licence, { asOf: '2026-08-08T23:59:59Z' })).toBe(true);
  });

  // Purity: the same status evaluated at two instants gives two answers, and
  // neither depends on when the process happened to run.
  it('takes the instant from the caller, never from a clock', () => {
    const licence = build(licensed({ expiresAt: '2026-06-01T00:00:00Z' }));
    expect(isPublishable(licence, { asOf: '2026-05-31T00:00:00Z' })).toBe(true);
    expect(isPublishable(licence, { asOf: '2026-07-01T00:00:00Z' })).toBe(false);
  });
});

describe('publicationBlockReason', () => {
  it('explains an unresolved status', () => {
    expect(publicationBlockReason(UNRESOLVED_LICENSING, NOW)).toContain('unresolved');
  });

  it('explains an expired licence, naming the expiry', () => {
    const licence = build(licensed({ expiresAt: '2026-01-01T00:00:00Z' }));
    expect(publicationBlockReason(licence, NOW)).toContain('2026-01-01T00:00:00Z');
  });

  it('explains a licence expiring at exactly the evaluated instant', () => {
    expect(publicationBlockReason(build(licensed({ expiresAt: NOW.asOf })), NOW)).toBeDefined();
  });

  it('gives no reason when publication is permitted', () => {
    expect(publicationBlockReason(build({ status: 'owned' }), NOW)).toBeUndefined();
  });

  it('gives no reason for an unexpired licence', () => {
    expect(publicationBlockReason(build(licensed({ expiresAt: '2027-01-01T00:00:00Z' })), NOW)).toBeUndefined();
  });

  it('agrees with isPublishable on every case', () => {
    const cases: readonly LicensingStatus[] = [
      build({ status: 'owned' }),
      build({ status: 'public_domain' }),
      build({ status: 'unresolved' }),
      build(licensed()),
      build(licensed({ expiresAt: '2026-01-01T00:00:00Z' })),
      build(licensed({ expiresAt: '2027-01-01T00:00:00Z' })),
    ];
    for (const licensing of cases) {
      expect(publicationBlockReason(licensing, NOW) === undefined).toBe(isPublishable(licensing, NOW));
    }
  });
});
