import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesMatching, importsOf, stripComments, tsFilesUnder } from '../../../fitness/source-scan.js';
import { isPureNodeBuiltin } from '../../../fitness/boundary-rules.js';
import {
  conflictError,
  CONTENT_ERROR_KINDS,
  ERROR_KINDS,
  isContentErrorKind,
  notFoundError,
  preconditionFailedError,
  ruleViolationError,
  validationError,
  type ContentError,
} from './content-error.js';

const DOMAIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const PLANTED_DIR = fileURLToPath(new URL('../../../fitness-fixtures/as-content-domain/', import.meta.url));

/**
 * The three guards, factored so each runs over the real domain and over the
 * planted fixture directory. A guard that has only ever been run against a
 * clean tree proves nothing about whether it works.
 *
 * All three read executable code, not prose — see `source-scan.ts`.
 */
function throwsIn(directory: string): string[] {
  return filesMatching(directory, /(^|[^.\w])throw\s/u);
}

function outwardImportsIn(directory: string): string[] {
  return tsFilesUnder(directory).flatMap((file) =>
    importsOf(readFileSync(file, 'utf8'))
      .filter((path) => !path.startsWith('.') || /\/(infrastructure|application|api)\//u.test(path))
      .filter((path) => path !== '@questionbank/domain-types')
      .filter((path) => !isPureNodeBuiltin(path)),
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

  it('restricts the content domain to five of them', () => {
    expect([...CONTENT_ERROR_KINDS]).toEqual([
      'Validation',
      'NotFound',
      'Conflict',
      'PreconditionFailed',
      'RuleViolation',
    ]);
  });

  it('draws every content kind from the platform taxonomy', () => {
    for (const kind of CONTENT_ERROR_KINDS) {
      expect(ERROR_KINDS).toContain(kind);
    }
  });

  it('excludes the kinds that belong to other layers', () => {
    for (const kind of ['Authentication', 'Authorization', 'Entitlement', 'RateLimited', 'Unavailable']) {
      expect(isContentErrorKind(kind)).toBe(false);
    }
  });

  it('recognises each of its own kinds', () => {
    for (const kind of CONTENT_ERROR_KINDS) {
      expect(isContentErrorKind(kind)).toBe(true);
    }
  });

  it('rejects a kind outside the taxonomy entirely', () => {
    expect(isContentErrorKind('Teapot')).toBe(false);
  });
});

describe('error constructors', () => {
  const cases: readonly (readonly [
    string,
    (code: string, message: string, location?: string) => ContentError,
  ])[] = [
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

    it(`carries a location on a ${kind} error when one is supplied`, () => {
      expect(construct('SOME_CODE', 'a human-readable reason', 'blocks[2]')).toEqual({
        kind,
        code: 'SOME_CODE',
        message: 'a human-readable reason',
        location: 'blocks[2]',
      });
    });

    it(`omits the location key entirely on a ${kind} error without one`, () => {
      // Not `location: undefined` — a serialized error with a null location
      // reads to the validation panel as "the problem is nowhere".
      expect(Object.hasOwn(construct('SOME_CODE', 'reason'), 'location')).toBe(false);
    });

    it(`freezes the ${kind} error it returns`, () => {
      expect(Object.isFrozen(construct('SOME_CODE', 'a human-readable reason'))).toBe(true);
    });
  }

  it('preserves the code as a literal type for exhaustive branching', () => {
    const error = validationError('STEM_BODY_EMPTY', 'a stem requires at least one block');
    const code: 'STEM_BODY_EMPTY' = error.code;
    expect(code).toBe('STEM_BODY_EMPTY');
  });
});

describe('the content domain layer', () => {
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

describe('the guards read code, not prose', () => {
  it('ignores an import-shaped phrase inside a comment', () => {
    // This is the defect the first run of these guards actually reported: the
    // phrase below sits in a doc comment in content-error.ts and was read as
    // an import of a module named "invalid item".
    const source = `/** separates a usable error from "invalid item" */\nexport const a = 1;\n`;
    expect(importsOf(source)).toEqual([]);
  });

  it('ignores a throw inside a comment', () => {
    expect(/(^|[^.\w])throw\s/u.test(stripComments('// never throw here\nexport const a = 1;\n'))).toBe(false);
  });

  it('ignores a clock read inside a comment', () => {
    expect(/\bnew Date\b/u.test(stripComments('/* never new Date() */\nexport const a = 1;\n'))).toBe(false);
  });

  it('keeps a comment marker that is inside a string literal', () => {
    expect(stripComments(`const url = 'https://example.test/x';`)).toContain('https://example.test/x');
  });

  it('still sees a real import that follows a comment', () => {
    expect(importsOf(`/* a comment mentioning from "nowhere" */\nimport { a } from './real.js';\n`)).toEqual([
      './real.js',
    ]);
  });
});

describe('the domain guards, run against a planted violation', () => {
  it('catches a domain module that throws', () => {
    expect(throwsIn(PLANTED_DIR)).toHaveLength(1);
  });

  it('catches a domain module reaching into another context', () => {
    expect(outwardImportsIn(PLANTED_DIR)).toEqual([
      '../../contexts/curriculum/infrastructure/schema.js',
    ]);
  });

  it('catches a domain module reading a clock', () => {
    expect(clockReadsIn(PLANTED_DIR)).toHaveLength(1);
  });
});
