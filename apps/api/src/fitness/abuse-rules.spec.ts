import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDerivesAreBoundedAndLimited, defaultAbuseScope, type AbuseScope } from './abuse-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const F = (name: string): string => `src/fitness-fixtures/as-bounded-derives/${name}`;
const scope = (overrides: Partial<AbuseScope>): AbuseScope => ({ controller: F('limited.controller.ts'), handlers: [F('handlers.ts')], composition: F('composition-bounded.ts'), shipped: [], ...overrides });
const rules = (given: AbuseScope) => checkDerivesAreBoundedAndLimited(API_ROOT, given).map((violation) => violation.rule);

describe('no route that derives a password hash is reachable without a limit, and no derive runs outside the bound (M8-10)', () => {
  it('holds over the shipped source', () => {
    expect(checkDerivesAreBoundedAndLimited(API_ROOT)).toEqual([]);
  });

  it('looked at a real tree: the controller, the handlers that derive, the composition and the files it scanned', () => {
    const real = defaultAbuseScope(API_ROOT);
    expect(real.controller).toBe('src/contexts/identity/api/identity.controller.ts');
    expect(real.handlers.length).toBeGreaterThanOrEqual(3);
    expect(real.shipped.length).toBeGreaterThan(100);
    expect(real.shipped.some((file) => file.endsWith('.spec.ts') || file.startsWith('src/fitness'))).toBe(false);
  });

  describe('is red on a planted violation', () => {
    it('a route that derives and names no limit: null, left out, or a handler it cannot trace', () => {
      const found = checkDerivesAreBoundedAndLimited(API_ROOT, scope({ controller: F('unlimited.controller.ts') }));
      expect(found.map((violation) => violation.rule)).toEqual(['M8_10_DERIVING_ROUTE_UNLIMITED', 'M8_10_DERIVING_ROUTE_UNLIMITED', 'M8_10_HANDLER_NOT_FOUND']);
      expect(found[0]!.detail).toContain('LoginHandler');
    });

    it('and not red on a route that derives and names a limit, or one that does not derive and needs none', () => {
      expect(rules(scope({}))).toEqual([]);
    });

    it('a composition that hands the handlers the plain hasher', () => {
      expect(rules(scope({ composition: F('composition-unbounded.ts') }))).toEqual(['M8_10_HASHER_NOT_BOUNDED']);
    });

    it('a shipped file that builds a plain hasher of its own', () => {
      expect(rules(scope({ shipped: [F('builds-the-plain-hasher.ts')] }))).toEqual(['M8_10_HASHER_NOT_BOUNDED']);
    });

    it('and not red on a plain hasher that is handed straight to the bounded one', () => {
      expect(rules(scope({ shipped: [F('composition-bounded.ts')] }))).toEqual([]);
    });

    it('a shipped file that derives a key itself', () => {
      expect(rules(scope({ shipped: [F('derives-elsewhere.ts')] }))).toEqual(['M8_10_DERIVE_OUTSIDE_THE_HASHER']);
    });

    it('a shipped file that derives with another function of the family', () => {
      expect(rules(scope({ shipped: [F('derives-with-pbkdf2.ts')] }))).toEqual(['M8_10_DERIVE_OUTSIDE_THE_HASHER']);
    });

    it('and not red on the hasher\'s own file, which is where deriving belongs', () => {
      expect(rules(scope({ shipped: ['src/contexts/identity/infrastructure/scrypt-password-hasher.ts'] }))).toEqual([]);
    });
  });
});
