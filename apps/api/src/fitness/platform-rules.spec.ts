import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNoTsxFiles, checkNoUntypedConfigReads, ENV_READ_ALLOWLIST } from './platform-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('F16 — no configuration read outside the typed config module', () => {
  it('finds no violation on the real source tree', () => {
    expect(checkNoUntypedConfigReads(API_ROOT)).toEqual([]);
  });

  it('the scan is not vacuous — with the allowlist cleared, it finds the two real readers', () => {
    // config.ts and testing/database.ts genuinely read process.env. If the
    // scan walked nothing, this would report [] too, same as a correct pass
    // — so finding the real files is what rules out a scan walking zero.
    const violations = checkNoUntypedConfigReads(API_ROOT, { allowlist: [] }).map((v) => v.file).sort();
    expect(violations).toEqual(['src/platform/config/config.ts', 'src/testing/database.ts']);
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

  it('the enumerated allowlist is exactly the two files ADR-0004 already names', () => {
    expect([...ENV_READ_ALLOWLIST]).toEqual(['src/platform/config/config.ts', 'src/testing/database.ts']);
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
