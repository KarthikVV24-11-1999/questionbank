import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkHistoricalVersions,
  checkOutcomeAttribution,
  checkScoringPurity,
} from './scoring-rules.js';
import {
  registeredVersions,
  SHIPPED_SCHEMA_VERSIONS,
} from '../contexts/scoring/domain/schema-version-registry.js';

const SCORING_DOMAIN = fileURLToPath(new URL('../contexts/scoring/domain/', import.meta.url));
const PLANTED = fileURLToPath(new URL('../fitness-fixtures/as-scoring-domain/', import.meta.url));
const SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL('../../../../infra/migrations/20260807100000_scoring_schema.sql', import.meta.url)),
  'utf8',
);

describe('F45 — the scoring function performs no I/O and reads no clock', () => {
  it('is clean across the whole scoring domain', () => {
    expect(checkScoringPurity(SCORING_DOMAIN)).toEqual([]);
  });

  it('fires on a planted clock, randomness and environment read', () => {
    const violations = checkScoringPurity(PLANTED);
    const details = violations.map((violation) => violation.detail);
    expect(details).toContain('reads the clock via new Date');
    expect(details).toContain('draws randomness');
    expect(details).toContain('reads the environment');
  });

  it('names the rule and the offending file', () => {
    const violations = checkScoringPurity(PLANTED);
    expect(violations[0]?.rule).toBe('F45_NO_IO_OR_CLOCK');
    expect(violations[0]?.file).toContain('planted-impurity');
  });
});

describe('F47 — every item outcome carries a rule_applied_id', () => {
  it('holds in the type and at the database', () => {
    expect(checkOutcomeAttribution(SCORING_DOMAIN, SCHEMA_SQL)).toEqual([]);
  });

  it('fires when the database constraint is removed', () => {
    const weakened = SCHEMA_SQL.replace(
      /rule_applied_id\s+text NOT NULL CHECK \(length\(btrim\(rule_applied_id\)\) > 0\)/u,
      'rule_applied_id                  text',
    );
    const violations = checkOutcomeAttribution(SCORING_DOMAIN, weakened);
    expect(violations.map((violation) => violation.rule)).toContain('F47_OUTCOME_NAMES_A_RULE');
  });
});

describe('F48 — the executor handles every historical rule schema version', () => {
  it('holds for every version ever shipped', () => {
    expect(checkHistoricalVersions(SHIPPED_SCHEMA_VERSIONS, registeredVersions())).toEqual([]);
  });

  it('fires when a shipped version loses its executor', () => {
    const violations = checkHistoricalVersions([1, 2], [1]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain('version 2');
  });

  it('names every missing version, not just the first', () => {
    expect(checkHistoricalVersions([1, 2, 3], [1])).toHaveLength(2);
  });
});

describe('MNT-03 — every scoring module carries a 100% coverage threshold', () => {
  const CONFIG = readFileSync(fileURLToPath(new URL('../../vitest.config.ts', import.meta.url)), 'utf8');

  function productionModulesUnder(root: string, prefix: string): string[] {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const walk = (directory: string, relativePath: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        const nested = relativePath === '' ? entry : `${relativePath}/${entry}`;
        if (statSync(path).isDirectory()) return walk(path, nested);
        return entry.endsWith('.ts') && !entry.endsWith('.spec.ts') ? [`${prefix}${nested}`] : [];
      });
    return walk(root, '');
  }

  /**
   * ADR-0008: the 100% rule follows correctness-bearing-ness, not layer. It
   * covers everything that determines what gets scored or how — the domain,
   * both repositories, and the application code that resolves the pinned
   * versions or decides whether a re-score runs.
   */
  const CORRECTNESS_BEARING = [
    'src/contexts/scoring/infrastructure/score-record.repository.ts',
    'src/contexts/scoring/infrastructure/rescoring-operation.repository.ts',
    'src/contexts/scoring/application/authorization.ts',
    'src/contexts/scoring/application/handler-registry.ts',
    'src/contexts/scoring/application/handlers/scoring-handlers.ts',
    'src/contexts/scoring/application/handlers/rescoring-handlers.ts',
    'src/contexts/scoring/application/queries/scoring-queries.ts',
  ];

  /** No runtime code, so a threshold would assert nothing. */
  const TYPE_ONLY = ['repository-ports.ts', 'events/scoring-events.ts', 'aggregation-data.ts', 'marking-rule-data.ts'];

  it('leaves no scoring domain module without one', () => {
    const modules = productionModulesUnder(
      fileURLToPath(new URL('../contexts/scoring/domain/', import.meta.url)),
      'src/contexts/scoring/domain/',
    ).filter((module) => !TYPE_ONLY.some((suffix) => module.endsWith(suffix)));

    const missing = modules.filter((module) => !CONFIG.includes(`'${module}'`));
    expect(missing).toEqual([]);
  });

  it('leaves no correctness-bearing module outside the domain without one', () => {
    const missing = CORRECTNESS_BEARING.filter((module) => !CONFIG.includes(`'${module}'`));
    expect(missing).toEqual([]);
  });

  it('names every correctness-bearing module that actually exists', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    for (const module of CORRECTNESS_BEARING) {
      expect(existsSync(join(apiRoot, module)), module).toBe(true);
    }
  });

  it('sets all four metrics to 100 for each of them', () => {
    const thresholds = [...CONFIG.matchAll(/'(src\/contexts\/scoring\/[^']+)':\s*\{([^}]*)\}/gu)];
    expect(thresholds.length).toBeGreaterThan(0);
    for (const [, module, body] of thresholds) {
      for (const metric of ['branches', 'lines', 'functions', 'statements']) {
        expect(body, `${module} ${metric}`).toContain(`${metric}: 100`);
      }
    }
  });
});
