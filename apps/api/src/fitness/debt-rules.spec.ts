import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDebtRegister,
  citingFiles,
  debtCitationsIn,
  debtIdsDefinedIn,
  REGISTER,
} from './debt-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PLANTED = 'apps/api/src/fitness-fixtures/as-debt-uncited/planted-debt-citation.ts';

describe('the debt register and the tree agree', () => {
  it('every debt identifier the tree cites has an entry, and every entry is cited', () => {
    expect(checkDebtRegister(REPO_ROOT)).toEqual([]);
  });

  it('read a register that actually has entries in it', () => {
    const defined = debtIdsDefinedIn(readFileSync(join(REPO_ROOT, REGISTER), 'utf8'));
    expect(defined.length).toBeGreaterThan(10);
    // Parses the heading form the register is written in, not merely any D-token.
    expect(defined).toContain(36);
  });

  it('scanned a real tree, not an empty file list', () => {
    const files = citingFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(debtCitationsIn(REPO_ROOT, files).length).toBeGreaterThan(50);
  });
});

describe('the register check, run against a planted violation', () => {
  it('catches a citation of an identifier the register does not carry', () => {
    expect(checkDebtRegister(REPO_ROOT, { files: [PLANTED] })).toEqual([
      { rule: 'UNDEFINED_DEBT_ID', detail: `${PLANTED} cites D99, absent from ${REGISTER}` },
    ]);
  });

  it('does not count the planted fixture against the real run', () => {
    // The fixture is a tracked file under the same tree the real check
    // scans. It is exempt by name in `NOT_A_CITATION`, which is the only
    // reason the first describe passes — and this asserts that exemption is
    // doing the work, rather than the fixture happening to be missed.
    expect(citingFiles(REPO_ROOT)).not.toContain(PLANTED);
  });
});

describe('the design-decision namespace is not mistaken for debt', () => {
  it('ignores D1–D10, which DOMAIN-MODEL.md defines as design decisions', () => {
    // DOMAIN-MODEL.md cites D1 through D10 heavily and none of them are
    // debt. If the boundary moved, this file would report ten entries the
    // register was never meant to carry.
    const citations = debtCitationsIn(REPO_ROOT, ['docs/DOMAIN-MODEL.md']);
    expect(citations.every(({ id }) => id >= 11)).toBe(true);
  });
});
