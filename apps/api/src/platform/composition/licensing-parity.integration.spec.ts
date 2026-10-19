import { describe, expect, it } from 'vitest';
import { createLicensingStatus } from '../../contexts/content/domain/licensing-status.js';
import { licensingProblems } from '../../contexts/generation/application/prechecks/provenance-check.js';

/**
 * Two implementations of one rule drift (ENGINEERING-HANDBOOK §5). Check 12 restates
 * content's licensing rules because content exposes no validator over a
 * proposal; this holds the restatement to content's own `createLicensingStatus`
 * over one shared set of cases — complete and incomplete, every status.
 *
 * Lives in the composition tree because it is the one place both contexts may be
 * named together.
 */
const CASES: readonly unknown[] = [
  { status: 'owned' },
  { status: 'public_domain' },
  { status: 'unresolved' },
  { status: 'sold' },
  { status: 'licensed' },
  { status: 'licensed', licenseRef: 'CC-BY-4.0' },
  { status: 'licensed', attribution: 'Example Press' },
  { status: 'licensed', licenseRef: ' ', attribution: 'x' },
  { status: 'licensed', licenseRef: 'x', attribution: ' ' },
  { status: 'licensed', licenseRef: 'x', attribution: 'y' },
  { status: 'licensed', licenseRef: 'x', attribution: 'y', expiresAt: '2030-01-01T00:00:00Z' },
  { status: 'licensed', licenseRef: 'x', attribution: 'y', expiresAt: '2030-01-01T00:00:00.123456+05:30' },
  { status: 'licensed', licenseRef: 'x', attribution: 'y', expiresAt: 'next year' },
  { status: 'owned', expiresAt: '2030-01-01T00:00:00Z' },
  { status: 'public_domain', expiresAt: '2030-01-01T00:00:00Z' },
  { status: 'owned', expiresAt: 'whenever' },
];

describe('check 12’s licensing rules agree with content’s, case by case', () => {
  it('judges a case complete exactly when content accepts it as resolved', () => {
    for (const licensing of CASES) {
      const content = createLicensingStatus(licensing as never);
      const contentAcceptsAsPublishable = content.ok && content.value.status !== 'unresolved';
      const ours = licensingProblems(licensing).length === 0;
      expect(ours, JSON.stringify(licensing)).toBe(contentAcceptsAsPublishable);
    }
  });

  it('over a set with both kinds in it, so agreement is not agreement on all-pass', () => {
    const verdicts = CASES.map((licensing) => licensingProblems(licensing).length === 0);
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(3);
    expect(verdicts.filter((ok) => !ok).length).toBeGreaterThan(6);
  });
});
