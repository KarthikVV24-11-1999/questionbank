import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSecrets, configEnvVarNames, envExampleKeys, KNOWN_SAFE_ALLOWLIST } from './secret-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES_DIR = 'apps/api/src/fitness-fixtures/as-committed-secret';

describe('F39 — the real tree (Tier 1, ADR-0013: a real scan, run every time)', () => {
  it('scans a non-zero number of files', () => {
    expect(checkSecrets(REPO_ROOT).scannedFiles).toBeGreaterThan(20);
  });

  it('finds no violation in the real tree', () => {
    expect(checkSecrets(REPO_ROOT).violations).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    for (const entry of KNOWN_SAFE_ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('.env.example names exactly the typed config module\'s keys', () => {
  it('matches in both directions', () => {
    const documented = [...envExampleKeys(resolve(REPO_ROOT, '.env.example'))].sort();
    const configured = [...configEnvVarNames()].sort();
    expect(documented).toEqual(configured);
  });

  it('is not vacuous — the config module names a non-zero number of keys', () => {
    expect(configEnvVarNames().length).toBeGreaterThan(0);
  });
});

describe('planted violations — each pattern detected on its own fixture', () => {
  const scan = (name: string) =>
    checkSecrets(REPO_ROOT, { scanRoots: [`${FIXTURES_DIR}`], excludePatterns: [] }).violations.filter((v) =>
      v.file.endsWith(name),
    );

  it('an AWS-shaped access key', () => {
    expect(scan('planted-aws-key.ts').some((v) => v.rule === 'AWS_ACCESS_KEY')).toBe(true);
  });

  it('a PEM private key header', () => {
    expect(scan('planted-pem.ts').some((v) => v.rule === 'PEM_PRIVATE_KEY')).toBe(true);
  });

  it('a password= with a non-placeholder value', () => {
    expect(scan('planted-key-value.ts').some((v) => v.rule === 'KEY_VALUE_SECRET')).toBe(true);
  });

  it('a high-entropy quoted literal', () => {
    expect(scan('planted-high-entropy.ts').some((v) => v.rule === 'HIGH_ENTROPY_LITERAL')).toBe(true);
  });

  it('a placeholder value is not a violation', () => {
    expect(scan('safe-placeholder.ts')).toEqual([]);
  });
});

describe('a real-shaped key in a *.example file is still a violation', () => {
  it('is caught even in an allowlisted-looking location', () => {
    const violations = checkSecrets(REPO_ROOT, {
      scanRoots: [],
      extraFiles: [`${FIXTURES_DIR}/planted-aws-key.ts`],
      excludePatterns: [],
    }).violations;
    expect(violations.some((v) => v.rule === 'AWS_ACCESS_KEY')).toBe(true);
  });
});

describe('the config-key/.env.example equality is red in both directions', () => {
  it('fails when .env.example is missing a key the config module names', () => {
    const documented = envExampleKeys(resolve(REPO_ROOT, '.env.example')).filter((k) => k !== 'LOG_LEVEL');
    expect(documented.sort()).not.toEqual([...configEnvVarNames()].sort());
  });

  it('fails when .env.example names a key the config module does not', () => {
    const documented = [...envExampleKeys(resolve(REPO_ROOT, '.env.example')), 'UNKNOWN_EXTRA_KEY'];
    expect(documented.sort()).not.toEqual([...configEnvVarNames()].sort());
  });
});
