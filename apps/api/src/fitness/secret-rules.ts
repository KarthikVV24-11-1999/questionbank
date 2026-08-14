import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ENV_VAR_NAMES } from '../platform/config/config.js';

/**
 * F39 — no secret in source, image, or committed config. Unlike the rest of
 * Track D, this is **Tier 1** (ADR-0013): a real scan over the real tree,
 * run every time the fitness suite runs, not merely authored and asserted.
 */

export interface SecretViolation {
  readonly rule: string;
  readonly file: string;
  readonly detail: string;
}

/**
 * Every match here has a reason it is not a real secret — a closed list,
 * not a regex that quietly grew.
 */
export const KNOWN_SAFE_ALLOWLIST: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  { pattern: /AUTH_SIGNING_KEY=replace-with-a-real-32-byte-random-value/u, reason: '.env.example placeholder, not a key' },
  { pattern: /questionbank-local/u, reason: 'the MinIO local dev root password in docker-compose.yml — not a secret, a fixed local-only default' },
];

const PLACEHOLDER_PATTERN = /replace|placeholder|example|changeme|your[-_]?|xxx|<[^>]+>|\$\{/iu;

const SECRET_PATTERNS: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: 'AWS_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { rule: 'PEM_PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/**
 * `password=`, `secret=`, `token=` (any case, `:` or `=`) assigned a
 * **quoted string literal** value that is not obviously a placeholder.
 * Scoped to string literals, not any expression — `const token =
 * parser.tokens[i]` is code, not a secret, and matching it as one is exactly
 * the false-positive machine a real Tier-1 scan cannot afford to be.
 */
const KEY_VALUE_SECRET_PATTERN = /\b(password|secret|token)\s*[:=]\s*["']([^"']{6,})["']/giu;

/**
 * A **quoted string literal** of 32+ base64/hex-ish characters with enough
 * distinct characters to not be a repeated filler string. Scoped to quoted
 * literals, not bare identifiers — a secret is always a value, and a long
 * camelCase symbol or import path is not one just because it is long.
 */
const HIGH_ENTROPY_PATTERN = /["']([A-Za-z0-9+/_-]{32,})["']/gu;
const HIGH_ENTROPY_MIN_DISTINCT_CHARS = 22;

const SCAN_ROOTS = ['apps/api/src', 'apps/studio/src', 'packages', 'infra/compose', 'infra/terraform', '.github/workflows'];
const EXTRA_FILES = ['.env.example', 'infra/compose/.env.example', 'infra/terraform/staging/staging.tfvars.example'];

const DEFAULT_EXCLUDES = [
  /\.spec\.tsx?$/u,
  /^apps\/api\/src\/fitness\//u,
  /^apps\/api\/src\/fitness-fixtures\//u,
  /node_modules\//u,
  /\.d\.ts$/u,
];

function walk(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

function hasHighEntropy(candidate: string): boolean {
  return new Set(candidate).size >= HIGH_ENTROPY_MIN_DISTINCT_CHARS;
}

export function checkSecrets(
  root: string,
  options: {
    readonly scanRoots?: readonly string[];
    readonly extraFiles?: readonly string[];
    readonly excludePatterns?: readonly RegExp[];
    readonly allowlist?: readonly { readonly pattern: RegExp; readonly reason: string }[];
  } = {},
): { readonly violations: readonly SecretViolation[]; readonly scannedFiles: number } {
  const scanRoots = options.scanRoots ?? SCAN_ROOTS;
  const extraFiles = options.extraFiles ?? EXTRA_FILES;
  const excludes = options.excludePatterns ?? DEFAULT_EXCLUDES;
  const allowlist = options.allowlist ?? KNOWN_SAFE_ALLOWLIST;

  const files = [...scanRoots.flatMap((dir) => walk(join(root, dir))), ...extraFiles.map((f) => join(root, f))]
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file, index, all) => all.indexOf(file) === index)
    .filter((file) => !excludes.some((pattern) => pattern.test(file)));

  const violations: SecretViolation[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }

    for (const { rule, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(source);
      if (match !== null && !allowlist.some((a) => a.pattern.test(match[0]))) {
        violations.push({ rule, file, detail: match[0] });
      }
    }

    for (const match of source.matchAll(KEY_VALUE_SECRET_PATTERN)) {
      const value = match[2] ?? '';
      if (PLACEHOLDER_PATTERN.test(value)) continue;
      if (allowlist.some((a) => a.pattern.test(match[0]))) continue;
      violations.push({ rule: 'KEY_VALUE_SECRET', file, detail: match[0] });
    }

    for (const match of source.matchAll(HIGH_ENTROPY_PATTERN)) {
      const candidate = match[1]!;
      if (!hasHighEntropy(candidate)) continue;
      if (PLACEHOLDER_PATTERN.test(candidate)) continue;
      if (allowlist.some((a) => a.pattern.test(candidate))) continue;
      violations.push({ rule: 'HIGH_ENTROPY_LITERAL', file, detail: candidate });
    }
  }

  return { violations, scannedFiles: files.length };
}

/** The keys `.env.example` names, in file order. */
export function envExampleKeys(path: string): readonly string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]!);
}

/** The typed config module's own env var names, for the equality check. */
export function configEnvVarNames(): readonly string[] {
  return Object.values(ENV_VAR_NAMES);
}
