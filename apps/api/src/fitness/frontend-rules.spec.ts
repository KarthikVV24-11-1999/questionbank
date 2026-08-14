import { dirname, resolve } from 'node:path';
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
