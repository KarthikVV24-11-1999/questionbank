import { dirname, join, relative, resolve } from 'node:path';
import { readCode, tsFilesUnder } from './source-scan.js';

/**
 * **A person is authenticated by a session and by nothing else** (M8-05, ADR-0056).
 *
 * The strongest thing that can be checked from source is weaker than that sentence, and this file says so rather than claim the sentence. It cannot show which resolver a running process was
 * given; it can show four things that, together, leave a shipped route no other way to learn who is calling:
 *
 *   1. **The default is a session.** The composition root takes `overrides.principals ?? identity.resolver`: with no override, the resolver every context is given is the session one.
 *   2. **The token module is not reachable from shipped code.** `platform/auth/token.ts` and `principal-resolver.ts` (the stub, kept for tests and a future service-to-service credential) are
 *      imported as values only by themselves; tests, test support and fitness functions are not shipped and are not governed. A type import of the port is not a use of the stub.
 *   3. **No route reads a credential itself.** The `authorization` header and a `Bearer` prefix are read in `platform/auth/` and in identity, and nowhere else, so a controller cannot grow its own
 *      way of recognising a caller.
 *   4. **Every route goes through the port.** A controller with routes declares or takes a `PrincipalResolver`; the probes are the one named exception.
 *
 * What stays outside: a test that passes its own `principals` replaces the session resolver wholesale (and `tokenPrincipals` exists for exactly that), and nothing here proves a deployment did
 * not do the same. `identity.integration.spec.ts` shows the other half at runtime: the composed application, with no override, refuses a validly signed stub token for a real user.
 */
export interface IdentityViolation {
  readonly rule: 'M8_05_STUB_REACHABLE' | 'M8_05_CREDENTIAL_READ_OUTSIDE_IDENTITY' | 'M8_05_ROUTE_WITHOUT_THE_PORT' | 'M8_05_DEFAULT_IS_NOT_A_SESSION';
  readonly file: string;
  readonly message: string;
}

const AUTH_MODULES = /(^|\/)platform\/auth\/(token|principal-resolver)(\.js)?$/u;
const NOT_GOVERNED = [/^src\/testing\//u, /^src\/fitness\//u, /^src\/fitness-fixtures\//u];
const ALLOWED_TO_USE_THE_STUB = [/^src\/platform\/auth\//u];
const ALLOWED_TO_READ_CREDENTIALS = [/^src\/platform\/auth\//u, /^src\/contexts\/identity\//u];
/** Probes: no data and no person. Everything else with a route goes through the port. */
export const ROUTES_WITHOUT_THE_PORT: Readonly<Record<string, string>> = {
  'src/platform/http/health.controller.ts': 'liveness and readiness probes: no data, no person, and not a versioned API surface',
};

const posix = (path: string): string => path.split('\\').join('/');

function governedFiles(root: string): string[] {
  return tsFilesUnder(join(root, 'src'))
    .map((file) => posix(relative(root, file)))
    .filter((file) => !NOT_GOVERNED.some((pattern) => pattern.test(file)));
}

/** The modules a file imports as values: an `import type` and an import of only `type` specifiers are not a use. */
function valueImports(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+(type\s+)?([^;'"`]*?)\s*from\s*['"]([^'"\n]+)['"]/gu)) {
    const [, typeKeyword, clause, specifier] = match;
    if (typeKeyword !== undefined) continue;
    const named = /\{([^}]*)\}/u.exec(clause ?? '')?.[1];
    const defaultPart = (clause ?? '').replace(/\{[^}]*\}/u, '').replace(/,/gu, '').trim();
    const onlyTypes = named !== undefined && defaultPart === '' && named.split(',').map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith('type '));
    if (!onlyTypes && specifier !== undefined) found.push(specifier);
  }
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"\n]+)['"]/gu)) found.push(match[1]!);
  for (const match of code.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu)) found.push((match[1] ?? match[2])!);
  return found;
}

export function checkSessionOnlyAuthentication(root: string, options: { readonly files?: readonly string[] } = {}): IdentityViolation[] {
  const files = options.files ?? governedFiles(root);
  const violations: IdentityViolation[] = [];
  for (const file of files) {
    const code = readCode(join(root, file));
    if (!ALLOWED_TO_USE_THE_STUB.some((pattern) => pattern.test(file))) {
      for (const specifier of valueImports(code).filter((path) => path.startsWith('.'))) {
        const target = posix(relative(root, resolve(dirname(join(root, file)), specifier)));
        if (AUTH_MODULES.test(target.replace(/\.ts$/u, ''))) {
          violations.push({ rule: 'M8_05_STUB_REACHABLE', file, message: `imports ${specifier} as a value: the token stub is for tests and service-to-service calls, and shipped code authenticates a person by a session` });
        }
      }
    }
    if (!ALLOWED_TO_READ_CREDENTIALS.some((pattern) => pattern.test(file)) && (/(['"`])authorization\1/u.test(code) || /['"`]Bearer\s/u.test(code))) {
      violations.push({ rule: 'M8_05_CREDENTIAL_READ_OUTSIDE_IDENTITY', file, message: 'reads the authorization header or a Bearer prefix; only identity and platform/auth recognise a caller, and a route asks the port' });
    }
    if (/\.controller\.ts$/u.test(file) && /@(Get|Post|Put|Patch|Delete)\(/u.test(code) && !/PrincipalResolver|PRINCIPAL_RESOLVER|PRINCIPALS/u.test(code) && ROUTES_WITHOUT_THE_PORT[file] === undefined) {
      violations.push({ rule: 'M8_05_ROUTE_WITHOUT_THE_PORT', file, message: 'a controller with routes that neither takes nor declares a PrincipalResolver authenticates nobody, or something of its own' });
    }
  }
  return violations;
}

/** The composition root's default: with no override, the resolver is the session one. */
export function checkDefaultIsASession(root: string, file = 'src/platform/composition/app-factory.ts'): IdentityViolation[] {
  const code = readCode(join(root, file));
  return /overrides\.principals\s*\?\?\s*identity\.resolver\b/u.test(code) && /identityPrincipals\s*\(/u.test(code)
    ? []
    : [{ rule: 'M8_05_DEFAULT_IS_NOT_A_SESSION', file, message: 'the composition root does not default its resolver to the identity context\'s session resolver (`overrides.principals ?? identity.resolver`)' }];
}
