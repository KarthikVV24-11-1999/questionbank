import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESCALATION_TARGET_ROLE } from '../contexts/content/domain/review/ageing.js';
import { ROLES, ROLE_KEYS, isRole } from '../platform/auth/roles.js';
import {
  bareRoleLiterals,
  checkContextsImportOnlyTheVocabularyFromPlatform,
  checkRoleVocabulary,
  governedRoleFiles,
} from './role-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLANTED = 'src/fitness-fixtures/as-role-policy/planted-roles.ts';
const PLANTED_PLATFORM = 'src/fitness-fixtures/as-context-application/planted-platform-import.ts';

describe('M5-36 — a policy names a role from the vocabulary, or the build fails', () => {
  it('holds across every context’s application and API layers', () => {
    expect(checkRoleVocabulary(API_ROOT)).toEqual([]);
  });

  it('read a tree with real policies in it, so a clean result means something', () => {
    const files = governedRoleFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(80);
    for (const context of ['content', 'curriculum', 'scoring', 'generation']) {
      expect(files.some((file) => file.startsWith(`src/contexts/${context}/application/`)), context).toBe(true);
    }
    const references = files.reduce((count, file) => count + (readFileSync(join(API_ROOT, file), 'utf8').match(/\bROLES\.[a-zA-Z]+/gu)?.length ?? 0), 0);
    expect(references).toBeGreaterThan(100);
  });

  it('leaves no bare role for the substitution to find', () => {
    expect(bareRoleLiterals(API_ROOT)).toEqual([]);
  });

  it('holds specs out of it: a test may state the literal a policy is meant to equal', () => {
    expect(governedRoleFiles(API_ROOT).filter((file) => file.endsWith('.spec.ts'))).toEqual([]);
  });

  describe('is red on the planted violations', () => {
    const violations = checkRoleVocabulary(API_ROOT, { files: [PLANTED] });
    const at = (needle: string) => violations.filter((violation) => violation.message.includes(needle));

    it('a role written as a string, and says what to write instead', () => {
      expect(at('"content_ops" is written as a string').map((violation) => violation.rule)).toContain('M5_36_BARE_ROLE_STRING');
      expect(violations.find((violation) => violation.message.includes('write ROLES.contentOps'))).toBeDefined();
    });

    it('a typo, which is the failure the vocabulary exists for: it authorizes nobody, silently', () => {
      const typo = at('"content_op" is not a role');
      expect(typo).toHaveLength(1);
      expect(typo[0]?.rule).toBe('M5_36_UNKNOWN_ROLE');
      expect(typo[0]?.message).toContain('a typo here authorizes nobody, silently');
    });

    it('a name the vocabulary does not have', () => {
      const unknown = at('is not in the vocabulary');
      expect(unknown.map((violation) => violation.rule)).toEqual(['M5_36_UNKNOWN_ROLE']);
      expect(unknown[0]?.message).toContain('ROLES.contentOpz');
    });

    it('a bare string reached through a constant — reported once where it is written, not once per policy that shares it', () => {
      const source = readFileSync(join(API_ROOT, PLANTED), 'utf8').split('\n');
      const line = source.findIndex((text) => text.includes("Object.freeze(['reviewer'])")) + 1;
      expect(violations.filter((violation) => violation.line === line)).toHaveLength(1);
    });

    it('a principal built with a bare role, a membership test, and a comparison', () => {
      const lines = new Set(violations.map((violation) => violation.line));
      const source = readFileSync(join(API_ROOT, PLANTED), 'utf8').split('\n');
      for (const needle of ["roleContext: ['reviewer']", "roleContext.includes('content_ops')", "role === 'content_ops'"]) {
        const line = source.findIndex((text) => text.includes(needle)) + 1;
        expect(lines.has(line), needle).toBe(true);
      }
    });

    it('and not on the permitted use of the vocabulary', () => {
      const source = readFileSync(join(API_ROOT, PLANTED), 'utf8').split('\n');
      const fineLine = source.findIndex((text) => text.includes("policy('Fine'")) + 1;
      expect(violations.some((violation) => violation.line === fineLine)).toBe(false);
    });

    it('seven findings in all, and none is a duplicate', () => {
      expect(violations.map((violation) => `${violation.line}:${violation.message}`)).toHaveLength(new Set(violations.map((violation) => `${violation.line}:${violation.message}`)).size);
      expect(violations).toHaveLength(7);
    });
  });

  it('every role in the vocabulary is used by some policy: a dead role is a vocabulary that has stopped being kept', () => {
    const used = new Set<string>();
    for (const file of governedRoleFiles(API_ROOT)) {
      for (const match of readFileSync(join(API_ROOT, file), 'utf8').matchAll(/\bROLES\.([a-zA-Z]+)/gu)) used.add(match[1] as string);
    }
    expect([...ROLE_KEYS].filter((key) => !used.has(key))).toEqual([]);
  });

  it('holds the one role-valued constant outside the governed layers to the vocabulary: the domain cannot import it, so a spec does', () => {
    expect(ESCALATION_TARGET_ROLE).toBe(ROLES.contentOps);
    expect(isRole(ESCALATION_TARGET_ROLE)).toBe(true);
  });
});

describe('ADR-0026 — a context reaches platform/ for the role vocabulary and nothing else', () => {
  it('holds across every context file', () => {
    expect(checkContextsImportOnlyTheVocabularyFromPlatform(API_ROOT)).toEqual([]);
  });

  it('is red on a context importing the composition root, and silent on the vocabulary beside it', () => {
    const violations = checkContextsImportOnlyTheVocabularyFromPlatform(API_ROOT, { files: [PLANTED_PLATFORM] });
    expect(violations.map((violation) => violation.rule)).toEqual(['M5_36_CONTEXT_REACHES_PAST_THE_VOCABULARY']);
    expect(violations[0]?.message).toContain('app-factory');
  });
});
