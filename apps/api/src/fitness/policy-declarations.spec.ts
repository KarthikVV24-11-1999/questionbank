import { describe, expect, it } from 'vitest';
import { policiesDeclaredIn } from './policy-declarations.js';

describe('reading a handler set from its policy declarations (M7-51)', () => {
  it('reads the name, the roles in order and the step-up flag', () => {
    const source = `
      export const A_POLICY = policy('A', [ROLES.learner]);
      export const B_POLICY = policy('B', [ROLES.admin, ROLES.system], true);
    `;
    expect(policiesDeclaredIn(source)).toEqual({
      declared: [
        { name: 'A', roles: ['learner'], requiresStepUp: false },
        { name: 'B', roles: ['admin', 'system'], requiresStepUp: true },
      ],
      unreadableDeclarations: 0,
    });
  });

  it('reads a declaration split across lines', () => {
    expect(policiesDeclaredIn("const P = policy(\n  'Split',\n  [ROLES.learner],\n);").declared.map((entry) => entry.name)).toEqual(['Split']);
  });

  it('counts a declaration it cannot read instead of passing over it', () => {
    const source = `const A = policy('A', [ROLES.learner]); const B = policy(NAME, [ROLES.learner]); const C = policy('C', ROLE_SET);`;
    const read = policiesDeclaredIn(source);
    expect(read.declared.map((entry) => entry.name)).toEqual(['A']);
    expect(read.unreadableDeclarations).toBe(2);
  });

  it('does not count a method that merely ends in the word policy', () => {
    expect(policiesDeclaredIn("this.policy(x); authorize(p)").unreadableDeclarations).toBe(0);
  });
});
