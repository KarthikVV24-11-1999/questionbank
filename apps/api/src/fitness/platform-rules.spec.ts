import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNoUntypedConfigReads, ENV_READ_ALLOWLIST } from './platform-rules.js';

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
