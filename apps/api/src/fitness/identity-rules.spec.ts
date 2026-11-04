import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDefaultIsASession, checkSessionOnlyAuthentication, ROUTES_WITHOUT_THE_PORT } from './identity-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = (name: string): string => `src/fitness-fixtures/as-session-only/${name}`;

describe('a person is authenticated by a session and by nothing else (M8-05)', () => {
  it('holds over the shipped source: the stub is unreachable, no route reads a credential, every route takes the port, and the default is a session', () => {
    expect(checkSessionOnlyAuthentication(API_ROOT)).toEqual([]);
    expect(checkDefaultIsASession(API_ROOT)).toEqual([]);
  });

  it('looked at a real tree: controllers, the composition root and a probe it names as the one exception', () => {
    expect(Object.keys(ROUTES_WITHOUT_THE_PORT)).toEqual(['src/platform/http/health.controller.ts', 'src/platform/http/metrics.controller.ts']);
    expect(checkSessionOnlyAuthentication(API_ROOT, { files: ['src/platform/http/health.controller.ts'] })).toEqual([]);
  });

  describe('is red on a planted violation', () => {
    it('shipped code that builds the token stub as a resolver', () => {
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('imports-the-token-stub.ts')] }).map((violation) => violation.rule)).toEqual(['M8_05_STUB_REACHABLE']);
    });

    it('the token module itself, as well as the resolver built on it', () => {
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('imports-the-token-module.ts')] }).map((violation) => violation.rule)).toEqual(['M8_05_STUB_REACHABLE']);
    });

    it('and not red on a type import of the port, written either way', () => {
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('imports-only-a-type.ts')] })).toEqual([]);
    });

    it('a route handler that reads the authorization header and a Bearer prefix itself', () => {
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('reads-the-header.ts')] }).map((violation) => violation.rule)).toEqual(['M8_05_CREDENTIAL_READ_OUTSIDE_IDENTITY']);
    });

    it('a file that reads only the header by name, and one that handles only a Bearer prefix', () => {
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('reads-only-a-header-name.ts')] }).map((violation) => violation.rule)).toEqual(['M8_05_CREDENTIAL_READ_OUTSIDE_IDENTITY']);
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('reads-only-a-bearer-prefix.ts')] }).map((violation) => violation.rule)).toEqual(['M8_05_CREDENTIAL_READ_OUTSIDE_IDENTITY']);
    });

    it('a controller with a route that never asks the port, and not one that does', () => {
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('route-without-the-port.controller.ts')] }).map((violation) => violation.rule)).toEqual(['M8_05_ROUTE_WITHOUT_THE_PORT']);
      expect(checkSessionOnlyAuthentication(API_ROOT, { files: [FIXTURE('route-with-the-port.controller.ts')] })).toEqual([]);
    });

    it('a composition root whose default is the token stub, and not one whose default is the session', () => {
      expect(checkDefaultIsASession(API_ROOT, FIXTURE('factory-with-a-stub-default.ts')).map((violation) => violation.rule)).toEqual(['M8_05_DEFAULT_IS_NOT_A_SESSION']);
      expect(checkDefaultIsASession(API_ROOT, FIXTURE('factory-with-a-session-default.ts'))).toEqual([]);
      expect(checkDefaultIsASession(API_ROOT, FIXTURE('factory-builds-a-session-but-defaults-to-the-stub.ts')).map((violation) => violation.rule)).toEqual(['M8_05_DEFAULT_IS_NOT_A_SESSION']);
      expect(checkDefaultIsASession(API_ROOT, FIXTURE('factory-with-a-default-from-nowhere.ts')).map((violation) => violation.rule)).toEqual(['M8_05_DEFAULT_IS_NOT_A_SESSION']);
    });
  });
});
