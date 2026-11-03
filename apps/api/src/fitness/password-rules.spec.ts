import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNoPasswordIsSetWithoutTheScreen, defaultPasswordScope, passwordSettingClasses, type PasswordScope } from './password-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const F = (name: string): string => `src/fitness-fixtures/as-unscreened-passwords/${name}`;
const scope = (overrides: Partial<PasswordScope>): PasswordScope => ({ ports: F('ports.ts'), handlers: [F('handlers-screened.ts')], composition: F('composition-good.ts'), stores: F('stores.ts'), shipped: [], ...overrides });
const found = (given: PasswordScope) => checkNoPasswordIsSetWithoutTheScreen(API_ROOT, given);
const rules = (given: PasswordScope) => found(given).map((violation) => violation.rule);

describe('no path sets a password without asking the screen (M8-13)', () => {
  it('holds over the shipped source', () => {
    expect(checkNoPasswordIsSetWithoutTheScreen(API_ROOT)).toEqual([]);
  });

  it('looked at a real tree: the ports, the handlers that set a password, the composition, the stores file and the files it scanned', () => {
    const real = defaultPasswordScope(API_ROOT);
    expect(real.ports).toBe('src/contexts/identity/application/ports.ts');
    expect(real.handlers.map((file) => file.split('/').at(-1)).sort()).toEqual(['credential-handlers.ts', 'role-handlers.ts', 'session-handlers.ts', 'verification-handlers.ts']);
    expect(real.shipped.length).toBeGreaterThan(100);
    expect(real.shipped.some((file) => file.endsWith('.spec.ts') || file.startsWith('src/fitness'))).toBe(false);
  });

  it('judges the three handlers that set a password in the real tree, and no others', () => {
    expect(passwordSettingClasses(API_ROOT).sort()).toEqual(['ChangePasswordHandler', 'RegisterHandler', 'ResetPasswordHandler']);
  });

  describe('is not red on what is fine', () => {
    it('handlers that screen, return on a refusal and hash what was screened, composed from the shared dependencies; a rehash; a create that is somebody else\'s', () => {
      expect(rules(scope({ shipped: [F('fine-elsewhere.ts')] }))).toEqual([]);
    });

    it('the stores file writing the table', () => {
      expect(rules(scope({ shipped: [F('stores.ts')] }))).toEqual([]);
    });
  });

  describe('is red on a planted violation', () => {
    it('a handler that sets a password and never asks the screen', () => {
      const violations = found(scope({ handlers: [F('handlers-unscreened.ts')] }));
      expect(violations.map((violation) => violation.rule)).toEqual(['M8_13_PASSWORD_SET_WITHOUT_THE_SCREEN']);
      expect(violations[0]!.detail).toContain('ChangeHandler.handle');
      expect(violations[0]!.detail).toContain('replaceAndRevoke');
    });

    it('a handler that asks the screen after it has written', () => {
      expect(rules(scope({ handlers: [F('handlers-screen-after.ts')] }))).toEqual(['M8_13_PASSWORD_SET_WITHOUT_THE_SCREEN']);
    });

    it('a handler that asks the screen and goes on whatever it said', () => {
      expect(rules(scope({ handlers: [F('handlers-no-refusal.ts')] }))).toEqual(['M8_13_PASSWORD_SET_WITHOUT_THE_SCREEN']);
    });

    it('a handler that screens one string and hashes another', () => {
      const violations = found(scope({ handlers: [F('handlers-hash-other.ts')] }));
      expect(violations.map((violation) => violation.rule)).toEqual(['M8_13_UNSCREENED_PASSWORD_REACHES_THE_HASH']);
      expect(violations[0]!.detail).toContain('String(command.password');
    });

    it('a handler that applies the length rules itself', () => {
      expect(rules(scope({ handlers: [F('handlers-check-password.ts')] }))).toEqual(['M8_13_PASSWORD_CHECKED_AROUND_THE_SCREEN']);
    });

    it('a write to the credential from a function in a handler file that is not a handler\'s method', () => {
      expect(rules(scope({ handlers: [F('handlers-write-in-a-function.ts')] }))).toEqual(['M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER']);
    });

    it('a store method added later that takes a credential, called without the screen: the writers are read off the ports, not listed', () => {
      // and, being a handler that sets a password, it is also one the composition does not build from the shared dependencies
      expect(rules(scope({ ports: F('ports-new-writer.ts'), handlers: [F('handlers-new-writer.ts')] }))).toEqual(['M8_13_PASSWORD_SET_WITHOUT_THE_SCREEN', 'M8_13_SCREEN_NOT_COMPOSED']);
      // the same handler is fine while the ports do not declare it a writer
      expect(rules(scope({ handlers: [F('handlers-new-writer.ts')] }))).toEqual([]);
    });

    it('an exemption that names a method which has gone', () => {
      expect(rules(scope({ ports: F('ports-no-rehash.ts') }))).toEqual(['M8_13_EXEMPTION_STALE']);
    });

    it('a composition that builds no screen', () => {
      expect(rules(scope({ composition: F('composition-no-screen.ts') }))).toEqual(['M8_13_SCREEN_NOT_COMPOSED']);
    });

    it('a composition whose shared dependencies leave the screen out', () => {
      expect(rules(scope({ composition: F('composition-common-without-screen.ts') }))).toEqual(['M8_13_SCREEN_NOT_COMPOSED']);
    });

    it('a handler that sets a password and is not constructed from the shared dependencies', () => {
      const violations = found(scope({ composition: F('composition-not-common.ts') }));
      expect(violations.map((violation) => violation.rule)).toEqual(['M8_13_SCREEN_NOT_COMPOSED']);
      expect(violations[0]!.detail).toContain('ChangeHandler');
    });

    it('a file that is not a handler writing a credential through a store', () => {
      const violations = found(scope({ shipped: [F('writes-elsewhere.ts')] }));
      expect(violations.map((violation) => violation.detail)).toEqual([expect.stringContaining('create'), expect.stringContaining('replaceAndRevoke')]);
      expect(new Set(violations.map((violation) => violation.rule))).toEqual(new Set(['M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER']));
    });

    it('SQL that writes the credential table anywhere but the stores file', () => {
      expect(rules(scope({ shipped: [F('sql-elsewhere.ts')] }))).toEqual(['M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER']);
    });
  });
});
