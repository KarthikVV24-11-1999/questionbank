import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_ENGINE_PACKAGES,
  checkAttemptEngineFrameworkFree,
  checkNoColorLiterals,
  checkNoHandwrittenFetch,
  COLOR_TOKEN_MODULES,
  HANDWRITTEN_FETCH_ALLOWLIST,
} from './frontend-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('F15 — no hand-written fetch call outside the generated client (M0-17)', () => {
  it('finds no violation in the real frontend source', () => {
    const { violations, scannedFiles } = checkNoHandwrittenFetch(REPO_ROOT);
    expect(violations).toEqual([]);
    // Non-vacuous: this must have actually scanned Studio's real source tree.
    expect(scannedFiles).toBeGreaterThan(20);
  });

  it('fires on a planted fetch( call, and on a planted XMLHttpRequest', () => {
    const withFetch = checkNoHandwrittenFetch(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-component'],
      excludePatterns: [],
    });
    expect(withFetch.violations).toHaveLength(1);
    expect(withFetch.violations[0]?.file).toContain('planted-fetch-violation.tsx');
    expect(withFetch.scannedFiles).toBeGreaterThan(0);
  });

  it('the client itself is allowlisted, not scanned as a violation', () => {
    const { violations } = checkNoHandwrittenFetch(REPO_ROOT, {
      include: ['packages/contracts/src'],
    });
    expect(violations).toEqual([]);
    expect(HANDWRITTEN_FETCH_ALLOWLIST).toContain('packages/contracts/src/client.ts');
  });

  it('the allowlist option is what suppresses a match, not an accident of the pattern', () => {
    // The fixture is caught with the default (empty) allowlist behaviour a
    // caller gets by passing its own list...
    const withoutAllowlisting = checkNoHandwrittenFetch(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-component'],
      excludePatterns: [],
      allowlist: [],
    });
    expect(withoutAllowlisting.violations).toHaveLength(1);

    // ...and is suppressed once that exact path is allowlisted, proving the
    // allowlist parameter is load-bearing rather than decorative.
    const withAllowlisting = checkNoHandwrittenFetch(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-component'],
      excludePatterns: [],
      allowlist: ['apps/api/src/fitness-fixtures/as-studio-component/planted-fetch-violation.tsx'],
    });
    expect(withAllowlisting.violations).toEqual([]);
  });
});

/**
 * **M4-42's F15 row: the rule's subject now includes the review workspace.**
 *
 * F15 was proven in M0 against a generic Studio component. M4-38 added a
 * feature that talks to the API on the hottest path this product has — claim,
 * decide, advance, hundreds of times an hour — so "does the scan actually
 * reach `features/review-workspace/`?" is a question worth answering with a
 * fixture rather than by reading `DEFAULT_INCLUDES` and assuming.
 */
describe('F15 — the scan covers the review workspace (M4-42)', () => {
  it('scans the real review workspace and queue management surfaces', () => {
    const { violations, scannedFiles } = checkNoHandwrittenFetch(REPO_ROOT, {
      include: ['apps/studio/src/features/review-workspace', 'apps/studio/src/features/queue-management'],
    });
    expect(violations).toEqual([]);
    // Non-vacuous: both feature directories exist and were actually read.
    expect(scannedFiles).toBeGreaterThan(6);
  });

  it('fires on a planted fetch in a review workspace component', () => {
    const { violations, scannedFiles } = checkNoHandwrittenFetch(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-review-workspace'],
      excludePatterns: [],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain('planted-review-fetch.tsx');
    expect(scannedFiles).toBeGreaterThan(0);
  });

  /**
   * The review workspace reaches the API through `createLiveReviewWorkspaceApi`
   * and `createLiveQueueManagementApi`, which build on `createClient` — F15's
   * whole point is that this is the only route. Asserting the adapters exist
   * and name the client keeps the row above from being satisfied by a feature
   * that simply never calls the network at all.
   */
  it('the workspace reaches the API through the typed client, not by not calling it', () => {
    const adapters = [
      'apps/studio/src/features/review-workspace/review-workspace-api.ts',
      'apps/studio/src/features/queue-management/queue-management-api.ts',
    ];
    for (const adapter of adapters) {
      const source = readFileSync(join(REPO_ROOT, adapter), 'utf8');
      expect(source, adapter).toContain('@questionbank/contracts/client');
      expect(source, adapter).toContain('createClient');
    }
  });
});

describe('F24 — no colour literal outside the token layer (§9 rule 16, M0-18)', () => {
  it('finds no violation in the real frontend source', () => {
    const { violations, scannedFiles } = checkNoColorLiterals(REPO_ROOT);
    expect(violations).toEqual([]);
    expect(scannedFiles).toBeGreaterThan(20);
  });

  it('the token modules themselves are exempt', () => {
    for (const modulePath of COLOR_TOKEN_MODULES) {
      const { violations } = checkNoColorLiterals(REPO_ROOT, { include: [dirname(modulePath)] });
      expect(violations.some((v) => v.file === modulePath)).toBe(false);
    }
  });

  it('fires on a planted hex colour', () => {
    const { violations } = checkNoColorLiterals(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-colors'],
      excludePatterns: [/safe-science-prose\.tsx$/u, /planted-rgb-color\.tsx$/u, /planted-named-color\.tsx$/u],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain('planted-hex-color.tsx');
  });

  it('fires on a planted rgb()/rgba() colour', () => {
    const { violations } = checkNoColorLiterals(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-colors'],
      excludePatterns: [/safe-science-prose\.tsx$/u, /planted-hex-color\.tsx$/u, /planted-named-color\.tsx$/u],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain('planted-rgb-color.tsx');
  });

  it('fires on a planted named colour in a style-property context', () => {
    const { violations } = checkNoColorLiterals(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-colors'],
      excludePatterns: [/safe-science-prose\.tsx$/u, /planted-hex-color\.tsx$/u, /planted-rgb-color\.tsx$/u],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain('planted-named-color.tsx');
  });

  it('does not fire on a colour word in exam-content prose, only in a style-property context', () => {
    const { violations } = checkNoColorLiterals(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-studio-colors'],
      excludePatterns: [/planted-.*\.tsx$/u],
    });
    expect(violations).toEqual([]);
  });
});

/**
 * **M4-42's F24 row: the decision bar is where this rule is most tempting to
 * break.** Approve/reject wants green/red, and a hand-picked green is a
 * contrast ratio nobody checked — on the one control a reviewer touches
 * hundreds of times an hour.
 */
describe('F24 — the scan covers the decision bar (M4-42)', () => {
  it('finds no colour literal in the real review workspace or queue management', () => {
    const { violations, scannedFiles } = checkNoColorLiterals(REPO_ROOT, {
      include: ['apps/studio/src/features/review-workspace', 'apps/studio/src/features/queue-management'],
    });
    expect(violations).toEqual([]);
    expect(scannedFiles).toBeGreaterThan(6);
  });

  it('fires on a planted hex colour in a decision-bar component', () => {
    const { violations } = checkNoColorLiterals(REPO_ROOT, {
      include: ['apps/api/src/fitness-fixtures/as-review-workspace'],
      excludePatterns: [/planted-review-fetch\.tsx$/u],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain('planted-decision-bar-color.tsx');
  });
});

describe('F26 — the attempt engine imports no framework (M0-25) — its subject does not exist yet', () => {
  it("packages/attempt-engine is absent, and the check says so rather than passing over an empty scan silently", () => {
    const { presentPackages, violations } = checkAttemptEngineFrameworkFree(REPO_ROOT);
    expect(presentPackages).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('no unconfirmed attempt-engine-shaped package exists in packages/', () => {
    const { unconfirmedPackages } = checkAttemptEngineFrameworkFree(REPO_ROOT);
    expect(unconfirmedPackages).toEqual([]);
    expect(ATTEMPT_ENGINE_PACKAGES).toContain('packages/attempt-engine');
  });

  it('the rule is proven working before it has a real subject: a planted React import fails it', () => {
    const { violations, presentPackages } = checkAttemptEngineFrameworkFree(REPO_ROOT, {
      packages: ['apps/api/src/fitness-fixtures/as-attempt-engine'],
    });
    expect(presentPackages).toEqual(['apps/api/src/fitness-fixtures/as-attempt-engine']);
    expect(violations.some((v) => v.rule === 'F26_FRAMEWORK_IMPORT_IN_ATTEMPT_ENGINE')).toBe(true);
  });

  it('a real attempt-engine-shaped package not in the named list fails the check', () => {
    const { unconfirmedPackages } = checkAttemptEngineFrameworkFree(REPO_ROOT, {
      packages: [],
      packagesDir: 'apps/api/src/fitness-fixtures/as-packages-dir',
    });
    expect(unconfirmedPackages).toEqual(['apps/api/src/fitness-fixtures/as-packages-dir/attempt-engine']);
  });
});
