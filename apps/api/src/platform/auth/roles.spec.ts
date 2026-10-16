import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_KEYS, ROLE_VALUES, isRole } from './roles.js';

describe('the role vocabulary', () => {
  // Asserted against a literal, so the set cannot grow or shrink without
  // somebody changing this list and a reviewer seeing it.
  it('is exactly these eleven roles', () => {
    expect([...ROLE_VALUES].sort()).toEqual(
      ['admin', 'author', 'content_ops', 'curriculum_curator', 'exam_owner', 'generation_pipeline', 'guest', 'learner', 'ops', 'reviewer', 'system'],
    );
    expect(ROLE_KEYS).toHaveLength(11);
  });

  it('names each role by a camelCase key and a snake_case value, one for one', () => {
    for (const [key, value] of Object.entries(ROLES)) {
      expect(value, key).toBe(key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`));
    }
    expect(new Set(ROLE_VALUES).size).toBe(ROLE_VALUES.length);
  });

  it('recognises a role and nothing else', () => {
    for (const role of ROLE_VALUES) expect(isRole(role)).toBe(true);
    for (const other of ['content_op', 'Content_Ops', '', 'subject:physics', 'root', null, undefined, 3, {}]) {
      expect(isRole(other), String(other)).toBe(false);
    }
  });

  it('is a leaf: it imports nothing, so no context that imports it can acquire a dependency through it (ADR-0026)', () => {
    const source = readFileSync(fileURLToPath(new URL('./roles.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/mu);
    expect(source).not.toMatch(/\brequire\(/u);
  });
});
