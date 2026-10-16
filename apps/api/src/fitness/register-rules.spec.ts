import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkRegister,
  citationsIn,
  citingFiles,
  DEBT_REGISTER,
  DECISION_REGISTER,
  identifiersDefinedIn,
  type RegisterSpec,
} from './register-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PLANTED = 'apps/api/src/fitness-fixtures/as-register-uncited/planted-uncited-identifiers.ts';

const REGISTERS: readonly [string, RegisterSpec, string, number][] = [
  // label, spec, an identifier the register must carry, the floor its citation count must clear
  ['debt', DEBT_REGISTER, 'D36', 50],
  ['implementation decisions', DECISION_REGISTER, 'DEC-M4-15', 200],
];

describe.each(REGISTERS)('the %s register and the tree agree', (_label, spec, known, floor) => {
  it('every identifier the tree cites has an entry, and every entry is cited', () => {
    expect(checkRegister(REPO_ROOT, spec)).toEqual([]);
  });

  it('read a register that actually has entries in it', () => {
    const defined = identifiersDefinedIn(readFileSync(join(REPO_ROOT, spec.path), 'utf8'), spec);
    expect(defined.length).toBeGreaterThan(10);
    // Parses the heading form the register is written in, not merely any token.
    expect(defined).toContain(known);
  });

  it('scanned a real tree, not an empty file list', () => {
    const files = citingFiles(REPO_ROOT, spec);
    expect(files.length).toBeGreaterThan(100);
    expect(citationsIn(REPO_ROOT, spec, files).length).toBeGreaterThan(floor);
  });

  it('does not count the planted fixture against the real run', () => {
    // The fixture is a tracked file under the same tree the real check scans.
    // It is exempt by name, which is the only reason the first test passes —
    // this asserts the exemption is doing that work rather than the fixture
    // happening to be missed.
    expect(citingFiles(REPO_ROOT, spec)).not.toContain(PLANTED);
  });
});

describe('each register check, run against a planted violation', () => {
  it('catches a debt citation the register does not carry', () => {
    expect(checkRegister(REPO_ROOT, DEBT_REGISTER, { files: [PLANTED] })).toEqual([
      { rule: 'UNDEFINED_IDENTIFIER', detail: `${PLANTED} cites D99, absent from docs/DEBT.md` },
    ]);
  });

  it('catches a decision citation the register does not carry', () => {
    expect(checkRegister(REPO_ROOT, DECISION_REGISTER, { files: [PLANTED] })).toEqual([
      {
        rule: 'UNDEFINED_IDENTIFIER',
        detail: `${PLANTED} cites DEC-M9-99, absent from docs/IMPLEMENTATION-DECISIONS.md`,
      },
    ]);
  });
});

describe('the neighbouring D namespaces are not mistaken for debt', () => {
  it('ignores D1–D10, which DOMAIN-MODEL.md defines as design decisions', () => {
    const citations = citationsIn(REPO_ROOT, DEBT_REGISTER, ['docs/DOMAIN-MODEL.md']);
    expect(citations.every(({ identifier }) => Number(identifier.slice(1)) >= 11)).toBe(true);
  });

  it("ignores DECISIONS.md's hyphenated D-001 form entirely", () => {
    const register = readFileSync(join(REPO_ROOT, 'docs/DECISIONS.md'), 'utf8');
    expect(register).toContain('D-001');
    expect(citationsIn(REPO_ROOT, DEBT_REGISTER, ['docs/DECISIONS.md'])).toEqual([]);
  });

  it('does not read DEC-M4-15 as a debt citation', () => {
    expect([...'cited at DEC-M4-15 and nowhere else'.matchAll(DEBT_REGISTER.citation)]).toEqual([]);
  });
});
