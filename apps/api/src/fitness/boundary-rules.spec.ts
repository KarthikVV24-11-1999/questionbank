import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkBoundaries, importsOf } from './boundary-rules.js';
import * as barrel from '../contexts/curriculum/public/index.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('F1 — cross-module imports go through public/ barrels', () => {
  it('finds no violation in the shipped source', () => {
    const violations = checkBoundaries(API_ROOT).filter(
      (violation) => violation.rule === 'F1_CONTEXT_BOUNDARY',
    );

    expect(violations).toEqual([]);
  });

  it('fires on a planted violation', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures'],
      excludePatterns: [],
    });

    const planted = violations.filter(
      (violation) =>
        violation.rule === 'F1_CONTEXT_BOUNDARY' &&
        violation.file === 'src/fitness-fixtures/planted-boundary-violation.ts',
    );
    expect(planted).toHaveLength(1);
    expect(planted[0]?.message).toContain('public/ barrel');
  });
});

describe('F2 — domain imports nothing', () => {
  it('finds no violation in the shipped domain', () => {
    const violations = checkBoundaries(API_ROOT).filter(
      (violation) => violation.rule !== 'F1_CONTEXT_BOUNDARY',
    );

    expect(violations).toEqual([]);
  });

  it('permits the shared kernel and the enumerated pure builtins (node:crypto), over the real tree', () => {
    expect(
      checkBoundaries(API_ROOT).filter((violation) => violation.importPath.includes('domain-types')),
    ).toEqual([]);
    expect(
      checkBoundaries(API_ROOT).filter((violation) => violation.importPath === 'node:crypto'),
    ).toEqual([]);
  });

  it('does not exempt every node: builtin — only the enumerated, pure ones', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-domain'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^src\/fitness-fixtures\/as-domain\//u,
    }).filter((violation) => violation.file.includes('planted-impure-builtin'));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'F2_DOMAIN_IMPORTS_NOTHING', importPath: 'node:fs' });
  });

  it('catches a domain module evading the rule by dynamic import or require', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-domain'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^src\/fitness-fixtures\/as-domain\//u,
    }).filter((violation) => violation.file.includes('planted-evasion'));

    expect([...new Set(violations.map((violation) => violation.importPath))].sort()).toEqual([
      '../../contexts/curriculum/infrastructure/schema.js',
      'drizzle-orm',
    ]);
    expect(violations.some((violation) => violation.rule === 'DOMAIN_REACHES_OUTWARD')).toBe(true);
    expect(violations.some((violation) => violation.rule === 'F2_DOMAIN_IMPORTS_NOTHING')).toBe(true);
  });

  it('fires on a planted domain-layer violation', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-domain'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^src\/fitness-fixtures\/as-domain\//u,
    });

    const planted = violations.filter(
      (violation) =>
        violation.rule !== 'F1_CONTEXT_BOUNDARY' && violation.file.includes('planted-domain-violation'),
    );
    expect(planted.map((violation) => violation.rule)).toEqual([
      'F2_DOMAIN_IMPORTS_NOTHING',
      'DOMAIN_REACHES_OUTWARD',
    ]);
  });
});

describe('import extraction', () => {
  it.each([
    [`import { A } from './a.js';`, ['./a.js']],
    [`import type { B } from '../b.js';`, ['../b.js']],
    [`export type { C } from './c.js';`, ['./c.js']],
    [`import {\n  D,\n} from '@questionbank/domain-types';`, ['@questionbank/domain-types']],
    [`const x = 1;`, []],
  ])('extracts %j', (source, expected) => {
    expect(importsOf(source)).toEqual(expected);
  });

  // A rule that can be stepped around is worse than no rule: these are the
  // routes dependency-cruiser follows, so the in-repo checker must too.
  it.each([
    [`const m = await import('../infrastructure/schema.js');`, ['../infrastructure/schema.js']],
    [`const m = require('drizzle-orm');`, ['drizzle-orm']],
    [`import 'reflect-metadata';`, ['reflect-metadata']],
    [`export * from '../infrastructure/schema.js';`, ['../infrastructure/schema.js']],
  ])('detects the non-static form %j', (source, expected) => {
    expect(importsOf(source)).toEqual(expected);
  });

  it('finds every import in a multi-import file', () => {
    const source = [
      `import { a } from './a.js';`,
      `import type { B } from './b.js';`,
      `export { c } from './c.js';`,
    ].join('\n');

    expect(importsOf(source)).toEqual(['./a.js', './b.js', './c.js']);
  });

  // The regression that motivated stripping comments: F2 reported a violation
  // against `contexts/content/domain/content-error.ts` for a doc comment
  // reading `separates a usable error from "invalid item"`. A gate that fails
  // on a sentence is a gate people learn to ignore.
  it.each([
    [`/** an error separates a usable message from "invalid item" */\nconst x = 1;`, []],
    [`// see the note on importing from './nowhere.js'\nconst x = 1;`, []],
    [`/* export type { A } from './commented-out.js'; */\nconst x = 1;`, []],
  ])('reads code rather than prose in %j', (source, expected) => {
    expect(importsOf(source)).toEqual(expected);
  });

  it('still finds a real import that follows a comment mentioning one', () => {
    const source = [
      `/** derived from "somewhere else", conceptually */`,
      `import { a } from './a.js';`,
    ].join('\n');

    expect(importsOf(source)).toEqual(['./a.js']);
  });

  it('keeps an import-shaped string that is real code, not a comment', () => {
    expect(importsOf(`const m = require('drizzle-orm'); // required by the mapper`)).toEqual(['drizzle-orm']);
  });

  // The second layer of the same defect. `[\s\S]*?` ran from a line-starting
  // `export` through arbitrary code to the word `from` beside a quote, so the
  // message string below reported an import of ", " and failed F2.
  it.each([
    [`export function f() {\n  return err('a published item records where it came from', 'loc');\n}`, []],
    [`export const message = 'derived from "somewhere"';`, []],
    [`export function g() {\n  const a = 1;\n  return 'from';\n}\nconst b = 'x';`, []],
  ])('does not read a string literal as an import in %j', (source, expected) => {
    expect(importsOf(source)).toEqual(expected);
  });

  it('still finds a real import in a file that also contains the word from in a string', () => {
    const source = [
      `import { err } from './result.js';`,
      `export function f() {`,
      `  return err('records where it came from', 'loc');`,
      `}`,
    ].join('\n');

    expect(importsOf(source)).toEqual(['./result.js']);
  });

  it('still finds a multi-line import, which has no semicolon before its from', () => {
    const source = `import {\n  a,\n  b,\n} from './wide.js';`;
    expect(importsOf(source)).toEqual(['./wide.js']);
  });
});

describe('public barrel surface', () => {
  const exportedNames = Object.keys(barrel).sort();

  it('exports only the three value-level symbols it means to', () => {
    expect(exportedNames).toEqual(['CURRICULUM_EVENT_TYPES']);
  });

  it('exports no aggregate, entity, repository or infrastructure class', () => {
    const forbidden = [
      'TaxonomyVersion',
      'ConceptIdentity',
      'ConceptNode',
      'PrerequisiteEdge',
      'Exam',
      'ExamProfileVersion',
      'TaxonomyMigration',
      'SectionSpec',
      'MarkingRuleSet',
      'NumericAnswerSpec',
      'DrizzleTaxonomyVersionRepository',
      'DrizzleExamRepository',
      'DrizzleOutboxEmitter',
      'curriculum',
    ];

    for (const name of forbidden) {
      expect(exportedNames, name).not.toContain(name);
    }
  });

  it('exposes the marking rule set and answer spec as data, not as domain classes', () => {
    const text = readBarrel();

    expect(text).toContain('MarkingRuleSetData');
    expect(text).toContain('NumericAnswerSpecData');
    // Every value-object export is type-only.
    expect(text).not.toMatch(/^export \{ (MarkingRuleSet|NumericAnswerSpec)\b/mu);
  });

  it('re-exports commands, queries and events only from the layers that own them', () => {
    const text = readBarrel();

    expect(text).not.toContain("from '../infrastructure/");
    expect(text).not.toContain('.repository.js');
  });
});

function readBarrel(): string {
  return readFileSync(resolve(API_ROOT, 'src/contexts/curriculum/public/index.ts'), 'utf8');
}

describe('the rules hold for every context, not just curriculum', () => {
  it('finds no violation anywhere in the tree', () => {
    expect(checkBoundaries(API_ROOT)).toEqual([]);
  });

  it('catches a scoring module reaching into curriculum past its barrel', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-domain'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^nothing-is-domain$/u,
    }).filter((violation) => violation.rule === 'F1_CONTEXT_BOUNDARY');

    // The planted fixture imports curriculum/infrastructure directly. With no
    // file treated as domain, F1 is what must still catch it.
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.message.includes('public/ barrel'))).toBe(true);
  });

  it('permits scoring to consume curriculum through the barrel', () => {
    const throughBarrel = checkBoundaries(API_ROOT).filter(
      (violation) =>
        violation.file.startsWith('src/contexts/scoring/') && violation.importPath.includes('curriculum'),
    );
    expect(throughBarrel).toEqual([]);
  });
});

describe('the content barrel (M3-31)', () => {
  const contentBarrel = (): string =>
    readFileSync(resolve(API_ROOT, 'src/contexts/content/public/index.ts'), 'utf8');

  it('re-exports nothing from infrastructure', () => {
    const text = contentBarrel();
    expect(text).not.toContain("from '../infrastructure/");
    expect(text).not.toContain('.repository.js');
    expect(text).not.toContain('schema.js');
  });

  it('exports no handler class, which would let a consumer wire its own dependencies', () => {
    expect(contentBarrel()).not.toMatch(/^export \{[^}]*Handler\b/mu);
  });

  // The one deliberate exception (DEC-4), and it says so where it lives.
  it('documents the answer-key export as server-side only', () => {
    const text = contentBarrel();
    expect(text).toContain('AnswerKeyData');
    expect(text).toMatch(/server-side only/u);
  });

  it('catches a content module reaching past another context’s barrel (F1)', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-boundary'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^nothing-is-domain$/u,
    }).filter((violation) => violation.rule === 'F1_CONTEXT_BOUNDARY');

    // Three reaches: another context's domain, its infrastructure, and its
    // application layer.
    expect(violations).toHaveLength(3);
    expect(violations.every((violation) => violation.message.includes('public/ barrel'))).toBe(true);
  });

  it('catches a content domain module importing anything at all (F2)', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-domain'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^src\/fitness-fixtures\/as-content-domain\//u,
    }).filter((violation) => violation.file.includes('planted-outward-import'));

    // Even through a barrel: `domain/` imports nothing, and "nothing" has no
    // exception for a well-behaved import. This is the rule that keeps the
    // answer-key projection in `application/` rather than beside the response
    // specification, where it would be more convenient and wrong.
    expect(violations.map((violation) => violation.rule)).toEqual(['F2_DOMAIN_IMPORTS_NOTHING']);
  });

  it('permits content to consume scoring and curriculum through their barrels', () => {
    const throughBarrel = checkBoundaries(API_ROOT).filter(
      (violation) =>
        violation.file.startsWith('src/contexts/content/') &&
        (violation.importPath.includes('scoring') || violation.importPath.includes('curriculum')),
    );
    expect(throughBarrel).toEqual([]);
  });

  it('keeps the content domain importing nothing outward in the shipped tree', () => {
    const violations = checkBoundaries(API_ROOT).filter((violation) =>
      violation.file.startsWith('src/contexts/content/domain/'),
    );
    expect(violations).toEqual([]);
  });
});
