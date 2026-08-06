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

  it('permits the shared kernel and node builtins', () => {
    expect(
      checkBoundaries(API_ROOT).filter((violation) => violation.importPath.includes('domain-types')),
    ).toEqual([]);
    expect(
      checkBoundaries(API_ROOT).filter((violation) => violation.importPath.startsWith('node:')),
    ).toEqual([]);
  });

  it('fires on a planted domain-layer violation', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-domain'],
      excludePatterns: [/\.spec\.ts$/u],
      domainPattern: /^src\/fitness-fixtures\/as-domain\//u,
    });

    const planted = violations.filter((violation) => violation.rule !== 'F1_CONTEXT_BOUNDARY');
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

  it('finds every import in a multi-import file', () => {
    const source = [
      `import { a } from './a.js';`,
      `import type { B } from './b.js';`,
      `export { c } from './c.js';`,
    ].join('\n');

    expect(importsOf(source)).toEqual(['./a.js', './b.js', './c.js']);
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
