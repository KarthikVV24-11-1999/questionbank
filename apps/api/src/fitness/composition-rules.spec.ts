import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCompositionImportsOnlySeams, composedContexts } from './composition-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLANTED = ['src/fitness-fixtures/as-platform-seam'];

describe('M5-37 — the composition root imports only each context’s public/composition.js', () => {
  it('holds across the real composition root', () => {
    expect(checkCompositionImportsOnlySeams(API_ROOT)).toEqual([]);
  });

  it('composes exactly the six contexts: the set, not the loop', () => {
    expect(composedContexts(API_ROOT)).toEqual(['assessment', 'content', 'curriculum', 'generation', 'learning', 'scoring']);
  });

  describe('is red on the planted violations', () => {
    const violations = checkCompositionImportsOnlySeams(API_ROOT, { include: PLANTED });

    it('a public barrel — which the older F1 rule admits', () => {
      const barrel = violations.filter((violation) => violation.file.endsWith('planted-seam-barrel-import.ts'));
      expect(barrel).toHaveLength(1);
      expect(barrel[0]?.rule).toBe('M5_37_ROOT_REACHES_PAST_THE_SEAM');
      expect(barrel[0]?.message).toContain('public/index.ts');
    });

    it('a deep import of a context’s application layer', () => {
      const deep = violations.filter((violation) => violation.file.endsWith('planted-seam-deep-import.ts'));
      expect(deep).toHaveLength(1);
      expect(deep[0]?.message).toContain('application/compose-handlers.ts');
    });

    it('and silent on the seam itself: exactly those two, no more', () => {
      expect(violations).toHaveLength(2);
      expect(violations.some((violation) => violation.file.endsWith('permitted-seam-import.ts'))).toBe(false);
    });

    it('the plant reads as generation’s composition, so the set assertion above would notice it', () => {
      expect(composedContexts(API_ROOT, PLANTED)).toEqual(['generation']);
    });
  });
});
