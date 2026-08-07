import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  conflictError,
  ERROR_KINDS,
  isScoringErrorKind,
  notFoundError,
  preconditionFailedError,
  ruleViolationError,
  SCORING_ERROR_KINDS,
  validationError,
  type ScoringError,
} from './scoring-error.js';

const DOMAIN_DIR = fileURLToPath(new URL('.', import.meta.url));

function tsFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the error taxonomy', () => {
  it('is the closed set of ten from the handbook', () => {
    expect([...ERROR_KINDS]).toEqual([
      'Validation',
      'Authentication',
      'Authorization',
      'Entitlement',
      'NotFound',
      'Conflict',
      'PreconditionFailed',
      'RuleViolation',
      'RateLimited',
      'Unavailable',
    ]);
  });

  it('restricts the scoring domain to five of them', () => {
    expect([...SCORING_ERROR_KINDS]).toEqual([
      'Validation',
      'NotFound',
      'Conflict',
      'PreconditionFailed',
      'RuleViolation',
    ]);
  });

  it('draws every scoring kind from the platform taxonomy', () => {
    for (const kind of SCORING_ERROR_KINDS) {
      expect(ERROR_KINDS).toContain(kind);
    }
  });

  it('excludes the kinds that belong to other layers', () => {
    for (const kind of ['Authentication', 'Authorization', 'Entitlement', 'RateLimited', 'Unavailable']) {
      expect(isScoringErrorKind(kind)).toBe(false);
    }
  });

  it('recognises each of its own kinds', () => {
    for (const kind of SCORING_ERROR_KINDS) {
      expect(isScoringErrorKind(kind)).toBe(true);
    }
  });

  it('rejects a kind outside the taxonomy entirely', () => {
    expect(isScoringErrorKind('Teapot')).toBe(false);
  });
});

describe('error constructors', () => {
  const cases: readonly (readonly [string, (code: string, message: string) => ScoringError])[] = [
    ['Validation', validationError],
    ['NotFound', notFoundError],
    ['Conflict', conflictError],
    ['PreconditionFailed', preconditionFailedError],
    ['RuleViolation', ruleViolationError],
  ];

  for (const [kind, construct] of cases) {
    it(`constructs a ${kind} error carrying its code and message`, () => {
      expect(construct('SOME_CODE', 'a human-readable reason')).toEqual({
        kind,
        code: 'SOME_CODE',
        message: 'a human-readable reason',
      });
    });

    it(`freezes the ${kind} error it returns`, () => {
      const error = construct('SOME_CODE', 'a human-readable reason');
      expect(Object.isFrozen(error)).toBe(true);
    });
  }

  it('preserves the code as a literal type for exhaustive branching', () => {
    const error = validationError('SLOT_ORDINAL_GAP', 'slot ordinals must be contiguous');
    const code: 'SLOT_ORDINAL_GAP' = error.code;
    expect(code).toBe('SLOT_ORDINAL_GAP');
  });
});

describe('the domain layer', () => {
  it('contains no throw — expected failures are values (§8)', () => {
    const offenders = tsFilesUnder(DOMAIN_DIR).filter((file) =>
      /(^|[^.\w])throw\s/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('imports nothing outside itself (§9 rule 2)', () => {
    const imports = tsFilesUnder(DOMAIN_DIR).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map((match) => match[1] ?? '');
    });
    const outside = imports.filter((path) => !path.startsWith('.') && path !== '@questionbank/domain-types');
    expect(outside).toEqual([]);
  });

  it('reads no clock and draws no randomness (F45)', () => {
    const offenders = tsFilesUnder(DOMAIN_DIR).filter((file) =>
      /\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bperformance\.now\b/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
