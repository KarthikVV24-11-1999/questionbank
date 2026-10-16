import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesMatching, importsOf, tsFilesUnder } from '../../../fitness/source-scan.js';
import { isPureNodeBuiltin } from '../../../fitness/boundary-rules.js';
import {
  ERROR_KINDS,
  GENERATION_ERROR_KINDS,
  conflictError,
  notFoundError,
  preconditionFailedError,
  ruleViolationError,
  validationError,
  type GenerationError,
} from './generation-error.js';

const DOMAIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const PLANTED_DIR = fileURLToPath(new URL('../../../fitness-fixtures/as-generation-domain/', import.meta.url));

/**
 * The three guards, factored so each runs over the real domain and over the
 * planted fixture directory. A guard that has only ever been run against a
 * clean tree proves nothing about whether it works. All three read executable
 * code, not prose.
 */
function throwsIn(directory: string): string[] {
  return filesMatching(directory, /(^|[^.\w])throw\s/u);
}

/**
 * Anything that leaves `directory`: a package, or a relative path that resolves
 * outside it. Stricter than content's guard, which flags only paths naming
 * another layer — a sibling context's barrel would pass that, and `domain/`
 * imports nothing.
 */
function outwardImportsIn(directory: string): string[] {
  return tsFilesUnder(directory).flatMap((file) =>
    importsOf(readFileSync(file, 'utf8')).filter((path) => {
      if (isPureNodeBuiltin(path)) return false;
      if (!path.startsWith('.')) return true;
      return !resolve(dirname(file), path).startsWith(directory);
    }),
  );
}

function clockReadsIn(directory: string): string[] {
  return filesMatching(directory, /\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bperformance\.now\b/u);
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

  it('restricts the generation domain to exactly five of them', () => {
    expect([...GENERATION_ERROR_KINDS]).toEqual([
      'Validation',
      'NotFound',
      'Conflict',
      'PreconditionFailed',
      'RuleViolation',
    ]);
  });

  it('draws every generation kind from the platform taxonomy', () => {
    for (const kind of GENERATION_ERROR_KINDS) expect(ERROR_KINDS).toContain(kind);
  });
});

describe('error constructors', () => {
  const cases: readonly (readonly [
    string,
    (code: string, message: string, location?: string) => GenerationError,
  ])[] = [
    ['Validation', validationError],
    ['NotFound', notFoundError],
    ['Conflict', conflictError],
    ['PreconditionFailed', preconditionFailedError],
    ['RuleViolation', ruleViolationError],
  ];

  for (const [kind, construct] of cases) {
    it(`constructs a ${kind} error carrying its code and message`, () => {
      expect(construct('SOME_CODE', 'a reason')).toEqual({ kind, code: 'SOME_CODE', message: 'a reason' });
    });

    it(`carries a location on a ${kind} error when one is supplied`, () => {
      expect(construct('SOME_CODE', 'a reason', 'pin.runId')).toEqual({
        kind,
        code: 'SOME_CODE',
        message: 'a reason',
        location: 'pin.runId',
      });
    });

    it(`omits the location key entirely on a ${kind} error without one`, () => {
      expect(Object.hasOwn(construct('SOME_CODE', 'reason'), 'location')).toBe(false);
    });

    it(`freezes the ${kind} error it returns`, () => {
      expect(Object.isFrozen(construct('SOME_CODE', 'reason'))).toBe(true);
    });
  }

  it('preserves the code as a literal type for exhaustive branching', () => {
    const code: 'RUN_ID_REQUIRED' = validationError('RUN_ID_REQUIRED', 'runId is required').code;
    expect(code).toBe('RUN_ID_REQUIRED');
  });
});

describe('the generation domain layer', () => {
  it('has a domain to guard, so the checks below are not vacuous', () => {
    expect(existsSync(join(DOMAIN_DIR, 'result.ts'))).toBe(true);
    expect(tsFilesUnder(DOMAIN_DIR).length).toBeGreaterThanOrEqual(2);
  });

  it('contains no throw — expected failures are values (§8)', () => {
    expect(throwsIn(DOMAIN_DIR)).toEqual([]);
  });

  it('imports nothing outside itself (§9 rule 2)', () => {
    expect(outwardImportsIn(DOMAIN_DIR)).toEqual([]);
  });

  it('reads no clock and draws no randomness', () => {
    expect(clockReadsIn(DOMAIN_DIR)).toEqual([]);
  });
});

describe('the domain guards, run against a planted violation', () => {
  it('catches a domain module that throws', () => {
    expect(throwsIn(PLANTED_DIR)).toHaveLength(1);
  });

  it('catches a domain module reaching into another context and into a package', () => {
    expect(outwardImportsIn(PLANTED_DIR).sort()).toEqual(['../../contexts/content/public/index.js', 'zod']);
  });

  it('catches a domain module reading a clock and a source of randomness', () => {
    expect(clockReadsIn(PLANTED_DIR)).toHaveLength(1);
  });
});

describe('every error kind the domain declares has a producer that is not a test', () => {
  const CONTEXT_DIR = resolve(DOMAIN_DIR, '..');

  /** Non-test, non-declaring files under the context that call `name(`. */
  function callSites(name: string): string[] {
    return filesMatching(CONTEXT_DIR, new RegExp(`\\b${name}\\(`, 'u'), {
      exclude: ['.spec.ts', '/domain/generation-error.ts'],
    })
      .map((file) => relative(CONTEXT_DIR, file))
      .sort();
  }

  // Asserted as sets, so a producer disappearing is a reviewed diff rather than
  // a loop that quietly checks one fewer thing.
  it('names where Validation, PreconditionFailed and RuleViolation are produced', () => {
    expect(callSites('validationError')).toEqual([
      'application/content-draft-acl.ts',
      'domain/generation-candidate.ts',
      'domain/generation-run.ts',
      'domain/model-pin.ts',
      'infrastructure/repository-errors.ts',
    ]);
    expect(callSites('preconditionFailedError')).toEqual([
      'application/content-draft-acl.ts',
      'domain/generation-candidate.ts',
    ]);
    expect(callSites('ruleViolationError')).toEqual(['domain/generation-candidate.ts']);
  });

  it('names where NotFound and Conflict are produced — the kinds that were once dropped for want of one', () => {
    expect(callSites('conflictError')).toEqual(['domain/generation-candidate.ts', 'infrastructure/repository-errors.ts']);
    expect(callSites('notFoundError')).toEqual(['infrastructure/repository-errors.ts']);
  });

  it('has every one of those producers actually called by the repositories that report with them', () => {
    const repositories = ['generation-candidate.repository.ts', 'generation-run.repository.ts'].map((name) =>
      readFileSync(join(CONTEXT_DIR, 'infrastructure', name), 'utf8'),
    );
    expect(repositories.some((source) => /\bnotFound\(/u.test(source))).toBe(true);
    expect(repositories.some((source) => /\bconflict\(/u.test(source))).toBe(true);
    expect(repositories.some((source) => /\bfromDatabaseError\(/u.test(source))).toBe(true);
  });

  it('declares exactly the kinds that have a producer', () => {
    const produced = (
      [
        ['Validation', 'validationError'],
        ['NotFound', 'notFoundError'],
        ['Conflict', 'conflictError'],
        ['PreconditionFailed', 'preconditionFailedError'],
        ['RuleViolation', 'ruleViolationError'],
      ] as const
    )
      .filter(([, constructor]) => callSites(constructor).length > 0)
      .map(([kind]) => kind);
    expect(produced).toEqual([...GENERATION_ERROR_KINDS]);
  });
});
