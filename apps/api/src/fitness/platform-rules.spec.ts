import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCoverageThresholds } from './content-rules.js';
import {
  checkNoTsxFiles,
  checkNoUntypedConfigReads,
  checkSealDayUnreachableFromProductionCode,
  CORRECTNESS_BEARING_PLATFORM_MODULES,
  ENV_READ_ALLOWLIST,
} from './platform-rules.js';
import config from '../../vitest.config.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('F16 — no configuration read outside the typed config module', () => {
  it('finds no violation on the real source tree', () => {
    expect(checkNoUntypedConfigReads(API_ROOT)).toEqual([]);
  });

  it('the scan is not vacuous — with the allowlist cleared, it finds the three real readers', () => {
    // config.ts, testing/database.ts and main.ts genuinely read process.env.
    // If the scan walked nothing, this would report [] too, same as a
    // correct pass — so finding the real files is what rules out a scan
    // walking zero.
    const violations = checkNoUntypedConfigReads(API_ROOT, { allowlist: [] }).map((v) => v.file).sort();
    expect(violations).toEqual(['src/main.ts', 'src/platform/config/config.ts', 'src/testing/database.ts']);
  });

  it('fires on the planted violation, naming the file', () => {
    const violations = checkNoUntypedConfigReads(API_ROOT, {
      include: ['src/fitness-fixtures/as-platform-env-reader'],
      allowlist: [],
      excludePatterns: [],
    });
    expect(violations).toEqual([
      {
        rule: 'F16_UNTYPED_CONFIG_READ',
        file: 'src/fitness-fixtures/as-platform-env-reader/planted-untyped-config-read.ts',
      },
    ]);
  });

  it('does not fire on the planted violation once its file is allowlisted', () => {
    const violations = checkNoUntypedConfigReads(API_ROOT, {
      include: ['src/fitness-fixtures/as-platform-env-reader'],
      allowlist: ['src/fitness-fixtures/as-platform-env-reader/planted-untyped-config-read.ts'],
      excludePatterns: [],
    });
    expect(violations).toEqual([]);
  });

  it('the enumerated allowlist is exactly the three reviewed readers', () => {
    expect([...ENV_READ_ALLOWLIST]).toEqual([
      'src/platform/config/config.ts',
      'src/testing/database.ts',
      'src/main.ts',
    ]);
  });
});

describe('API_NO_TSX — the API type-checks the renderer, it does not author JSX (ADR-0016)', () => {
  it('finds no .tsx file on the real source tree', () => {
    expect(checkNoTsxFiles(API_ROOT)).toEqual([]);
  });

  it('the scan is not vacuous — with the default exclusion cleared, the full src/ walk finds the checked-in fixture', () => {
    // checkNoTsxFiles reports only violations, so [] and a walk over zero
    // files look identical from the real-tree assertion alone. This proves
    // the walk genuinely reaches the whole tree — including the committed
    // fixture, which only the default exclusion (removed here) hides.
    const violations = checkNoTsxFiles(API_ROOT, { excludePatterns: [] });
    expect(violations.map((v) => v.file)).toContain('src/fitness-fixtures/as-api-tsx/planted-component.tsx');
  });

  it('fires on the planted .tsx fixture, naming the file', () => {
    const violations = checkNoTsxFiles(API_ROOT, {
      include: ['src/fitness-fixtures/as-api-tsx'],
      excludePatterns: [],
    });
    expect(violations).toEqual([
      { rule: 'API_NO_TSX', file: 'src/fitness-fixtures/as-api-tsx/planted-component.tsx' },
    ]);
  });

  it('does not fire on the fixture directory under its default exclusion', () => {
    // The same fixture the previous test finds when explicitly included is
    // invisible to the real gate's default scan — proving the exclusion is
    // what keeps this repository's own fixtures from tripping the check
    // they exist to exercise.
    const violations = checkNoTsxFiles(API_ROOT);
    expect(violations.some((v) => v.file.includes('as-api-tsx'))).toBe(false);
  });

  it('does not object to an unrelated .ts file in the same fixture directory', () => {
    const violations = checkNoTsxFiles(API_ROOT, {
      include: ['src/fitness-fixtures/as-platform-env-reader'],
      excludePatterns: [],
    });
    expect(violations).toEqual([]);
  });
});

describe('sealDay is unreachable from production code (M4-34)', () => {
  it('finds no violation on the real source tree', () => {
    expect(checkSealDayUnreachableFromProductionCode(API_ROOT)).toEqual([]);
  });

  it('fires on the planted fixture, naming the file', () => {
    const violations = checkSealDayUnreachableFromProductionCode(API_ROOT, {
      include: ['src/fitness-fixtures/as-platform-sealday-reachable'],
      excludePatterns: [],
    });
    expect(violations).toEqual([
      {
        rule: 'SEAL_DAY_REACHABLE_FROM_PRODUCTION_CODE',
        file: 'src/fitness-fixtures/as-platform-sealday-reachable/planted-controller.ts',
      },
    ]);
  });

  it('does not fire on the fixture directory under its default exclusion', () => {
    const violations = checkSealDayUnreachableFromProductionCode(API_ROOT);
    expect(violations.some((v) => v.file.includes('as-platform-sealday-reachable'))).toBe(false);
  });

  it('the scan is not vacuous — with the default exclusion cleared, the full src/ walk finds the checked-in fixture', () => {
    const violations = checkSealDayUnreachableFromProductionCode(API_ROOT, { excludePatterns: [] });
    expect(violations.map((v) => v.file)).toContain(
      'src/fitness-fixtures/as-platform-sealday-reachable/planted-controller.ts',
    );
  });
});

describe('ADR-0008 — every correctness-bearing platform module carries a 100% threshold (M0-26)', () => {
  const exists = (module: string): boolean => existsSync(join(API_ROOT, module));

  function declaredThresholds(): Readonly<Record<string, unknown>> {
    const coverage = config.test?.coverage as { thresholds?: Record<string, unknown> } | undefined;
    expect(coverage?.thresholds).toBeDefined();
    return coverage?.thresholds as Readonly<Record<string, unknown>>;
  }

  it('holds for the real config', () => {
    expect(checkCoverageThresholds(declaredThresholds(), CORRECTNESS_BEARING_PLATFORM_MODULES, exists)).toEqual([]);
  });

  it('checked a list with something on it', () => {
    expect(CORRECTNESS_BEARING_PLATFORM_MODULES.length).toBeGreaterThanOrEqual(5);
  });

  it('fires when an in-scope module has no threshold', () => {
    const violations = checkCoverageThresholds({}, ['src/platform/auth/token.ts'], exists);
    expect(violations.map((v) => v.rule)).toEqual(['ADR0008_MISSING_THRESHOLD']);
  });

  it('fires when a threshold is below 100', () => {
    const violations = checkCoverageThresholds(
      { 'src/platform/auth/token.ts': { branches: 90, lines: 100, functions: 100, statements: 100 } },
      ['src/platform/auth/token.ts'],
      exists,
    );
    expect(violations).toEqual([
      { rule: 'ADR0008_WEAK_THRESHOLD', subject: 'src/platform/auth/token.ts', detail: 'branches threshold is 90, not 100' },
    ]);
  });

  it('fires when the list names a module that has been deleted', () => {
    const violations = checkCoverageThresholds({}, ['src/platform/deleted-yesterday.ts'], exists);
    expect(violations.map((v) => v.rule)).toEqual(['ADR0008_THRESHOLD_NAMES_A_DELETED_MODULE']);
  });
});
