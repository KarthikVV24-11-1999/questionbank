import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './source-scan.js';

/**
 * **A spec that sends requests to a Nest application with supertest starts it on loopback** (M7-21, D73).
 *
 * supertest starts a server that is not already listening with `listen(0)`, which binds the wildcard address, and connects to `127.0.0.1:<port>`. Where
 * the operating system lets a wildcard listener share a port number with a listener on a specific address, a request can be taken by whatever else holds that
 * number on loopback, and the spec fails with a response the application never wrote. `serveOnLoopback` binds the application to `127.0.0.1` itself.
 *
 * The rule: a spec that calls `getHttpServer()` also calls `serveOnLoopback(` (or listens on `'127.0.0.1'` itself).
 */
export interface LoopbackViolation {
  readonly rule: 'M7_21_SPEC_USES_A_WILDCARD_LISTENER';
  readonly file: string;
}

const SKIPPED = ['node_modules', 'coverage', 'dist'];

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return files(path);
    return /\.ts$/u.test(entry) ? [path] : [];
  });
}

export function checkSpecsServeOnLoopback(root: string, roots: readonly string[], options: { readonly onlySpecs?: boolean } = {}): LoopbackViolation[] {
  const onlySpecs = options.onlySpecs ?? true;
  const violations: LoopbackViolation[] = [];
  for (const directory of roots) {
    for (const path of files(join(root, directory))) {
      if (onlySpecs && !/\.spec\.ts$/u.test(path)) continue;
      const code = stripComments(readFileSync(path, 'utf8'));
      if (!/\bgetHttpServer\s*\(\s*\)/u.test(code)) continue;
      if (/\bserveOnLoopback\s*\(/u.test(code) || /\.listen\(\s*0\s*,\s*['"]127\.0\.0\.1['"]/u.test(code)) continue;
      violations.push({ rule: 'M7_21_SPEC_USES_A_WILDCARD_LISTENER', file: relative(root, path).replaceAll('\\', '/') });
    }
  }
  return violations;
}
