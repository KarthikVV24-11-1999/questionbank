import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import {
  AI_CONTEXT_PATTERNS,
  CONTENT_RULES,
  CORRECTNESS_BEARING_CONTENT_MODULES,
  KEY_BEARING_FIELDS,
  RENDERED_MARKUP_FIELDS,
  checkAuthoringUnreachableFromDelivery,
  checkCoverageThresholds,
  checkJsonbVersionSiblings,
  checkNoAiImportIntoContent,
  checkNoRenderedMarkupField,
  checkNoTruncateGrant,
  checkPayloadSurfaces,
  checkReviewAuthoringSubBoundary,
  checkSingleContentRenderer,
  modulesReachableFrom,
} from './content-rules.js';
import { filesMatching, tsFilesUnder } from './source-scan.js';
import { checkNoMachinePublishesItsOwnContent } from '../contexts/content/domain/publication-preconditions.js';
import { createItemVersion } from '../contexts/content/domain/item-version.js';
import {
  AI_AGENT,
  PROVENANCE_CONTEXT,
  REVIEWER,
  aiProvenance,
  itemVersionProps,
} from '../testing/content-fixtures.js';
import { expectError, expectValue } from '../testing/expect-result.js';

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CONTENT_ROOT = fileURLToPath(new URL('../contexts/content/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fitness-fixtures/', import.meta.url));

/* ------------------------------------------------------------------ *
 * F6 / F35, amended by ADR-0009
 * ------------------------------------------------------------------ */

/**
 * The enumerated, closed split (DEC-4 condition 1). Adding to either list is a
 * reviewed change to a named constant here, never an inference from a path
 * prefix at runtime.
 */
const DELIVERY_SURFACES = [
  'src/contexts/content/api/dto/delivery-schemas.ts',
  'src/contexts/content/api/content.controller.ts',
  'src/contexts/content/application/queries/delivery-queries.ts',
  'src/contexts/content/domain/events/content-events.ts',
];

const AUTHORING_SURFACES = [
  'src/contexts/content/api/dto/authoring-schemas.ts',
  'src/contexts/content/application/queries/authoring-queries.ts',
];

/**
 * The one bare specifier the graph follows. `authoring-schemas.ts` imports the
 * generated Zod schemas rather than restating field names (M3-34), so a walk
 * that stopped at the package boundary would conclude the authoring surface
 * carries no key — which is the correct design reported as a violation.
 */
const RESOLUTION = {
  packages: {
    '@questionbank/contracts/content-schemas': join(
      REPO_ROOT,
      'packages/contracts/src/content-schemas.ts',
    ),
  },
};

describe('F6/F35 — the key is on the authoring surface and nowhere else (ADR-0009)', () => {
  it('names surfaces that exist, so the check has something to read', () => {
    for (const module of [...DELIVERY_SURFACES, ...AUTHORING_SURFACES]) {
      expect(existsSync(join(API_ROOT, module)), module).toBe(true);
    }
    expect(DELIVERY_SURFACES.length + AUTHORING_SURFACES.length).toBe(6);
  });

  it('holds on the real tree, in both directions', () => {
    expect(
      checkPayloadSurfaces(
        API_ROOT,
        { delivery: DELIVERY_SURFACES, authoring: AUTHORING_SURFACES },
        KEY_BEARING_FIELDS,
        RESOLUTION,
      ),
    ).toEqual([]);
  });

  it('fires on a planted key-bearing delivery DTO', () => {
    const violations = checkPayloadSurfaces(FIXTURES, {
      delivery: ['as-content-surface/planted-delivery-key.ts'],
      authoring: [],
    });
    expect(violations.map((violation) => violation.rule)).toEqual([
      'F6_KEY_ON_A_DELIVERY_SURFACE',
      'F6_KEY_ON_A_DELIVERY_SURFACE',
    ]);
    expect(violations.map((violation) => violation.detail)).toContain(
      'names the key-bearing field "correctOptionId"',
    );
  });

  // The other direction, which a one-directional check would pass.
  it('fires on an authoring surface that has silently stopped carrying a key', () => {
    const violations = checkPayloadSurfaces(FIXTURES, {
      delivery: [],
      authoring: ['as-content-surface/planted-keyless-authoring.ts'],
    });
    expect(violations.map((violation) => violation.rule)).toEqual([
      'F6_KEY_ABSENT_FROM_AN_AUTHORING_SURFACE',
    ]);
  });

  it('matches an identifier, not a substring of a longer name', () => {
    expect(
      checkPayloadSurfaces(
        FIXTURES,
        { delivery: ['as-content-surface/planted-keyless-authoring.ts'], authoring: [] },
        ['Correct'],
      ),
    ).toEqual([]);
  });

  it('enumerates every spelling the key arrives under', () => {
    expect(KEY_BEARING_FIELDS).toContain('correctOptionId');
    expect(KEY_BEARING_FIELDS).toContain('expectedValue');
    expect(KEY_BEARING_FIELDS).toContain('finalAnswerAssertion');
  });
});

/* ------------------------------------------------------------------ *
 * ADR-0009 condition 3, by import graph
 * ------------------------------------------------------------------ */

describe('ADR-0009 condition 3 — no authoring module is reachable from delivery', () => {
  const DELIVERY_ENTRIES = [join(API_ROOT, 'src/contexts/content/api/content.controller.ts')];
  const AUTHORING_MODULES = [
    join(API_ROOT, 'src/contexts/content/api/dto/authoring-schemas.ts'),
    join(API_ROOT, 'src/contexts/content/api/authoring.controller.ts'),
    join(API_ROOT, 'src/contexts/content/application/queries/authoring-queries.ts'),
  ];

  it('walks a graph with real depth, not just the controller’s own imports', () => {
    const reachable = modulesReachableFrom(DELIVERY_ENTRIES[0] as string);
    expect(reachable.length).toBeGreaterThan(10);
    // Three hops away, through the handler registry — a check that only read
    // the controller's own import list would never see it.
    expect(
      reachable.some((module) => module.endsWith(join('domain', 'publication-preconditions.ts'))),
    ).toBe(true);
  });

  it('holds transitively from the delivery controller', () => {
    expect(checkAuthoringUnreachableFromDelivery(DELIVERY_ENTRIES, AUTHORING_MODULES)).toEqual([]);
  });

  // Proven by asking the same question of the controller that is *supposed* to
  // reach them: a check that cannot find an authoring module anywhere is a
  // check that would pass on a delivery controller importing every one.
  it('fires when an entry point does reach the authoring family', () => {
    const violations = checkAuthoringUnreachableFromDelivery(
      [join(API_ROOT, 'src/contexts/content/api/authoring.controller.ts')],
      AUTHORING_MODULES,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.rule).toBe('ADR0009_AUTHORING_MODULE_REACHABLE_FROM_DELIVERY');
  });

  // A rename defeats a naming-convention check; it does not defeat this one,
  // because the graph is walked over paths rather than over identifiers.
  it('is a fact about imports, not about names', () => {
    const controller = readFileSync(
      join(API_ROOT, 'src/contexts/content/api/content.controller.ts'),
      'utf8',
    );
    expect(controller).not.toContain('authoring-schemas');
  });
});

/* ------------------------------------------------------------------ *
 * F20
 * ------------------------------------------------------------------ */

describe('F20 — exactly one ContentRenderer in the monorepo', () => {
  const ROOTS = ['apps', 'packages'].map((directory) => join(REPO_ROOT, directory));

  it('finds one implementation, and scanned enough files that a second could not hide', () => {
    const result = checkSingleContentRenderer(ROOTS, { exclude: ['fitness-fixtures'] });
    expect(result.violations).toEqual([]);
    expect(result.implementations).toHaveLength(1);
    expect(result.implementations[0]).toContain(
      join('packages', 'content-renderer', 'src', 'content-renderer.tsx'),
    );
    expect(result.scanned).toBeGreaterThan(50);
  });

  // The fixture lives inside `apps/`, so the production run names its
  // exemption; dropping the exemption is what proves the scan still finds it.
  it('fires on a second implementation', () => {
    const result = checkSingleContentRenderer(ROOTS);
    expect(result.implementations).toHaveLength(2);
    expect(result.violations.map((violation) => violation.rule)).toEqual([
      'F20_SECOND_CONTENT_RENDERER',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * INV-01
 * ------------------------------------------------------------------ */

describe('INV-01 — no import path from an AI context into content', () => {
  it('holds across the whole content context', () => {
    expect(checkNoAiImportIntoContent(CONTENT_ROOT)).toEqual([]);
  });

  it('scanned the whole context, so an empty result means something', () => {
    // The same call with a pattern that *does* match proves the scan reached
    // real files rather than an empty directory.
    const reached = checkNoAiImportIntoContent(CONTENT_ROOT, [/scoring\/public\//u]);
    expect(reached.length).toBeGreaterThan(0);
  });

  /**
   * The generation context is M5's and does not exist yet, so the production
   * patterns have nothing to find today — this is a tripwire, and the
   * mechanism is proven against a context that does exist.
   */
  it('fires on a planted import from a context standing in for the AI one', () => {
    const violations = checkNoAiImportIntoContent(join(FIXTURES, 'as-content-domain'), [
      /contexts\/scoring\//u,
    ]);
    expect(violations.map((violation) => violation.rule)).toContain('INV01_AI_REACHES_CONTENT');
  });

  it('watches every name the AI context could arrive under, none of which exists yet', () => {
    expect(AI_CONTEXT_PATTERNS).toHaveLength(3);
    expect(AI_CONTEXT_PATTERNS.some((pattern) => pattern.test('../../contexts/ai/public/index.js'))).toBe(true);
    expect(AI_CONTEXT_PATTERNS.some((pattern) => pattern.test('@questionbank/ai'))).toBe(true);
    expect(existsSync(join(API_ROOT, 'src/contexts/ai'))).toBe(false);
    expect(existsSync(join(API_ROOT, 'src/contexts/generation'))).toBe(false);
  });
});

describe('INV-01 — no publication path accepts a machine signature on AI content', () => {
  const AI_VERSION = expectValue(
    createItemVersion(
      itemVersionProps({ authoredBy: AI_AGENT, provenance: aiProvenance() }),
      PROVENANCE_CONTEXT,
    ),
  );
  const HUMAN_VERSION = expectValue(createItemVersion(itemVersionProps(), PROVENANCE_CONTEXT));

  function signedBy(reviewer: typeof REVIEWER) {
    return {
      reviewer,
      itemVersionId: AI_VERSION.versionId,
      decision: 'approve' as const,
      signedAt: '2026-08-11T09:00:00Z',
    };
  }

  it('refuses AI-sourced content signed by a machine', () => {
    expect(expectError(checkNoMachinePublishesItsOwnContent(AI_VERSION, signedBy(AI_AGENT))).code).toBe(
      'AI_CONTENT_NOT_HUMAN_REVIEWED',
    );
  });

  it('refuses AI-sourced content with no signature at all', () => {
    expect(expectError(checkNoMachinePublishesItsOwnContent(AI_VERSION, undefined)).code).toBe(
      'AI_CONTENT_NOT_HUMAN_REVIEWED',
    );
  });

  // The check is about the machine, not about signatures in general: refusing
  // every machine signature would break the importer, which is not what INV-01
  // forbids.
  it('permits AI-sourced content a human signed, and machine-signed human content', () => {
    expect(expectValue(checkNoMachinePublishesItsOwnContent(AI_VERSION, signedBy(REVIEWER)))).toBe(true);
    expect(
      expectValue(checkNoMachinePublishesItsOwnContent(HUMAN_VERSION, signedBy(AI_AGENT))),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * INV-14
 * ------------------------------------------------------------------ */

describe('INV-14 — the vocabulary carries no rendered markup or image of text', () => {
  const VOCABULARY = [
    join(API_ROOT, 'src/contexts/content/domain/content-body.ts'),
    join(REPO_ROOT, 'packages/content-renderer/src/content-body.ts'),
  ];

  it('holds on both declarations of the vocabulary', () => {
    for (const file of VOCABULARY) expect(existsSync(file), file).toBe(true);
    expect(checkNoRenderedMarkupField(VOCABULARY)).toEqual([]);
  });

  it('fires on a planted html and svg field', () => {
    const violations = checkNoRenderedMarkupField([
      join(FIXTURES, 'as-content-vocabulary/planted-rendered-markup.ts'),
    ]);
    expect(violations.map((violation) => violation.detail)).toEqual([
      'declares a "html" field',
      'declares a "svg" field',
    ]);
  });

  it('watches every field a rendered node would arrive under', () => {
    expect(RENDERED_MARKUP_FIELDS).toContain('html');
    expect(RENDERED_MARKUP_FIELDS).toContain('svg');
    expect(RENDERED_MARKUP_FIELDS).toContain('imageOfText');
  });
});

/* ------------------------------------------------------------------ *
 * F5 and F7, over catalogue rows
 * ------------------------------------------------------------------ */

describe('F5 — the judgment over catalogue rows', () => {
  it('passes when every JSONB column has its sibling', () => {
    expect(
      checkJsonbVersionSiblings([
        { table: 'item_version', column: 'stem_body', dataType: 'jsonb' },
        { table: 'item_version', column: 'stem_body_schema_version', dataType: 'integer' },
      ]),
    ).toEqual([]);
  });

  it('fires on a JSONB column with no sibling', () => {
    const violations = checkJsonbVersionSiblings([
      { table: 'item_option', column: 'body', dataType: 'jsonb' },
    ]);
    expect(violations).toEqual([
      {
        rule: 'F5_JSONB_WITHOUT_A_VERSION_SIBLING',
        subject: 'item_option.body',
        detail: 'no body_schema_version sibling',
      },
    ]);
  });

  it('does not confuse one table’s sibling for another’s', () => {
    expect(
      checkJsonbVersionSiblings([
        { table: 'item_option', column: 'body', dataType: 'jsonb' },
        { table: 'stimulus_version', column: 'body_schema_version', dataType: 'integer' },
      ]),
    ).toHaveLength(1);
  });
});

describe('F7/F40 — no TRUNCATE grant on a published-version table', () => {
  it('passes when the app role holds only row privileges', () => {
    expect(
      checkNoTruncateGrant(
        [
          { table: 'item_version', privilege: 'UPDATE', grantee: 'questionbank_app' },
          { table: 'item_version', privilege: 'TRUNCATE', grantee: 'postgres' },
        ],
        ['questionbank_app'],
      ),
    ).toEqual([]);
  });

  it('fires when the app role holds TRUNCATE, which a row trigger cannot see', () => {
    const violations = checkNoTruncateGrant(
      [{ table: 'item_version', privilege: 'TRUNCATE', grantee: 'questionbank_app' }],
      ['questionbank_app'],
    );
    expect(violations).toEqual([
      {
        rule: 'F7_WRITE_GRANT_ON_A_PUBLISHED_VERSION_TABLE',
        subject: 'item_version',
        detail: 'questionbank_app holds TRUNCATE',
      },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * ADR-0008
 * ------------------------------------------------------------------ */

/**
 * Read from the config the suite actually runs under, not from a copy. A list
 * compared against a second declaration of itself proves only that somebody
 * updated both.
 */
function declaredThresholds(): Readonly<Record<string, unknown>> {
  const coverage = config.test?.coverage as { thresholds?: Record<string, unknown> } | undefined;
  expect(coverage?.thresholds).toBeDefined();
  return coverage?.thresholds as Readonly<Record<string, unknown>>;
}

describe('ADR-0008 — every correctness-bearing content module carries a 100% threshold', () => {
  const exists = (module: string): boolean => existsSync(join(API_ROOT, module));

  it('holds for the real config', () => {
    expect(
      checkCoverageThresholds(declaredThresholds(), CORRECTNESS_BEARING_CONTENT_MODULES, exists),
    ).toEqual([]);
  });

  it('checked a list with something on it', () => {
    expect(CORRECTNESS_BEARING_CONTENT_MODULES.length).toBeGreaterThan(30);
  });

  // The gate verified failing before it is trusted to pass, three ways.
  it('fires when an in-scope module has no threshold', () => {
    const violations = checkCoverageThresholds({}, ['src/contexts/content/domain/item.ts'], exists);
    expect(violations.map((violation) => violation.rule)).toEqual(['ADR0008_MISSING_THRESHOLD']);
  });

  it('fires when a threshold is below 100', () => {
    const violations = checkCoverageThresholds(
      {
        'src/contexts/content/domain/item.ts': {
          branches: 90,
          lines: 100,
          functions: 100,
          statements: 100,
        },
      },
      ['src/contexts/content/domain/item.ts'],
      exists,
    );
    expect(violations).toEqual([
      {
        rule: 'ADR0008_WEAK_THRESHOLD',
        subject: 'src/contexts/content/domain/item.ts',
        detail: 'branches threshold is 90, not 100',
      },
    ]);
  });

  it('fires when the list names a module that has been deleted', () => {
    const violations = checkCoverageThresholds(
      {},
      ['src/contexts/content/domain/deleted-yesterday.ts'],
      exists,
    );
    expect(violations.map((violation) => violation.rule)).toEqual([
      'ADR0008_THRESHOLD_NAMES_A_DELETED_MODULE',
    ]);
  });

  // The list is only as good as its completeness, so it is reconciled against
  // the tree: a new correctness-bearing module cannot be added without a
  // decision, because every content module is either on the list or on the
  // enumerated list of ones that only move a finished result around.
  const NOT_CORRECTNESS_BEARING = [
    'src/contexts/content/domain/repository-ports.ts',
    'src/contexts/content/domain/result.ts',
    'src/contexts/content/public/index.ts',
    // Wires real handlers to real repositories and adapters; decides
    // nothing a handler does not already decide itself (ADR-0015).
    'src/contexts/content/public/composition.ts',
    'src/contexts/content/api/authoring.controller.ts',
    'src/contexts/content/api/content.controller.ts',
    'src/contexts/content/api/content.module.ts',
    'src/contexts/content/api/http-runner.ts',
    'src/contexts/content/api/problem-details.ts',
    'src/contexts/content/api/dto/authoring-schemas.ts',
    'src/contexts/content/api/dto/delivery-schemas.ts',
    'src/contexts/content/application/commands/authoring-commands.ts',
    'src/contexts/content/application/commands/lifecycle-commands.ts',
    'src/contexts/content/application/commands/media-commands.ts',
    'src/contexts/content/application/commands/solution-commands.ts',
    'src/contexts/content/application/commands/stimulus-commands.ts',
    'src/contexts/content/infrastructure/content-media-ref.ts',
    'src/contexts/content/infrastructure/schema.ts',
    // A barrel re-exporting content's existing Result/ContentError; decides
    // nothing itself (M4-01).
    'src/contexts/content/domain/review/index.ts',
    // Empty and unregistered until M4-37 wires it to a handler.
    'src/contexts/content/api/review.controller.ts',
  ];

  it('classifies every content module, so a new one cannot arrive unclassified', () => {
    const modules = tsFilesUnder(CONTENT_ROOT)
      .map((file) => `src/contexts/content/${file.slice(CONTENT_ROOT.length)}`)
      .filter((module) => !module.endsWith('.spec.ts'));

    const unclassified = modules.filter(
      (module) =>
        !(CORRECTNESS_BEARING_CONTENT_MODULES as readonly string[]).includes(module) &&
        !NOT_CORRECTNESS_BEARING.includes(module),
    );
    expect(unclassified).toEqual([]);
    expect(modules.length).toBeGreaterThan(40);
  });
});

/* ------------------------------------------------------------------ *
 * The gate register
 * ------------------------------------------------------------------ */

describe('the M1/M2 fitness set is still run, not assumed', () => {
  /**
   * Each gate, the spec that runs it, and a phrase that spec must contain.
   *
   * **The phrase is the point.** Asserting only that a file exists passes on a
   * register pointing at the wrong file, which is exactly what the M3
   * close-out found here: F9 named the curriculum schema spec and F46 named
   * the scoring-rules spec, and both existed, so the check was green while
   * naming neither gate.
   */
  const GATES: Readonly<Record<string, readonly [string, string]>> = {
    F1: ['src/fitness/boundary-rules.spec.ts', 'F1'],
    F2: ['src/fitness/boundary-rules.spec.ts', 'F2'],
    F5: ['src/fitness/content-rules.integration.spec.ts', 'F5'],
    F7: ['src/fitness/content-rules.integration.spec.ts', 'F7'],
    F9: ['src/testing/golden/golden-regression.spec.ts', 'F9'],
    F40: ['src/fitness/content-rules.integration.spec.ts', 'F40'],
    F15: ['src/contracts/content-contract.spec.ts', 'F15'],
    F18: ['src/contexts/content/domain/events/content-events.spec.ts', 'F18'],
    F36: ['src/contexts/content/application/authoring-boundary.spec.ts', 'F36'],
    F45: ['src/fitness/scoring-rules.spec.ts', 'F45'],
    F46: ['src/contexts/curriculum/domain/value-objects/marking-rule-set.spec.ts', 'ALWAYS'],
    F47: ['src/fitness/scoring-rules.spec.ts', 'F47'],
    F48: ['src/fitness/scoring-rules.spec.ts', 'F48'],
  };

  it('names a spec that exists and actually runs each gate', () => {
    const wrong = Object.entries(GATES).filter(([, [spec, phrase]]) => {
      const path = join(API_ROOT, spec);
      return !existsSync(path) || !readFileSync(path, 'utf8').includes(phrase);
    });
    expect(wrong).toEqual([]);
    expect(Object.keys(GATES)).toHaveLength(13);
  });

  // The phrase check is shown to fail, or it is a second existence check.
  it('fires when a gate names a spec that does not run it', () => {
    const path = join(API_ROOT, 'src/fitness/scoring-rules.spec.ts');
    expect(readFileSync(path, 'utf8').includes('ALWAYS')).toBe(false);
  });

  it('declares every rule this module can report', () => {
    expect(CONTENT_RULES).toHaveLength(14);
    expect(new Set(CONTENT_RULES).size).toBe(CONTENT_RULES.length);
  });
});

/* ------------------------------------------------------------------ *
 * M4-01 — the review/authoring intra-context sub-boundary (DEC-M4-7)
 * ------------------------------------------------------------------ */

describe('stateEnteredAt is absent from every delivery surface (M4-13)', () => {
  it('is not named anywhere in the enumerated delivery surfaces', () => {
    for (const module of DELIVERY_SURFACES) {
      const source = readFileSync(join(API_ROOT, module), 'utf8');
      expect(source, module).not.toMatch(/\bstateEnteredAt\b/u);
    }
  });
});

describe('the review/authoring sub-boundary (M4-01, DEC-M4-7)', () => {
  it('is green on the real content tree', () => {
    expect(checkReviewAuthoringSubBoundary(API_ROOT)).toEqual([]);
  });

  it('catches review plumbing (application/review/) reaching into content’s authoring plumbing', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.rule === 'M4_01_REVIEW_REACHES_AUTHORING');

    expect(violations).toHaveLength(1);
    expect(violations[0]?.subject).toContain('planted-reaches-authoring.ts');
  });

  it('catches authoring plumbing reaching into review plumbing, the other direction', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.rule === 'M4_01_AUTHORING_REACHES_REVIEW');

    expect(violations).toHaveLength(1);
    expect(violations[0]?.subject).toContain('authoring-reaches-review.ts');
  });

  it('permits review plumbing to import a domain-root aggregate/value object', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.subject.includes('permitted-domain-import.ts'));

    expect(violations).toEqual([]);
  });

  it('permits review plumbing to import application/authorization.ts', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.subject.includes('permitted-authorization-import.ts'));

    expect(violations).toEqual([]);
  });

  it('permits an authoring-side domain module to import a domain/review/ aggregate (M4-04)', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.subject.includes('authoring-domain-imports-review-domain.ts'));

    expect(violations).toEqual([]);
  });

  it('reports exactly the two planted violations over the fixture directory, no more', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    });

    expect(violations).toHaveLength(2);
  });

  it('exempts the composition seam (public/composition.ts) reaching into review plumbing', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.subject.includes('public/composition.ts'));

    expect(violations).toEqual([]);
  });

  it('exempts review plumbing importing the composition seam back, the other direction', () => {
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.subject.includes('permitted-composition-import.ts'));

    expect(violations).toEqual([]);
  });

  it('does not exempt an ordinary authoring file reaching into review plumbing — only composition.ts', () => {
    // authoring-reaches-review.ts already imports application/review/, and it
    // is not the composition root — the planted violation it proves (above)
    // must still fire. This test guards the exemption from ever widening past
    // the one named file.
    const violations = checkReviewAuthoringSubBoundary(API_ROOT, {
      include: ['src/fitness-fixtures/as-content-review-subboundary'],
    }).filter((violation) => violation.rule === 'M4_01_AUTHORING_REACHES_REVIEW');

    expect(violations).toHaveLength(1);
    expect(violations[0]?.subject).toContain('authoring-reaches-review.ts');
    expect(violations[0]?.subject).not.toContain('composition.ts');
  });
});

describe('domain/review/ carries no throw and reads no clock (M4-01)', () => {
  const REVIEW_DOMAIN_DIR = fileURLToPath(new URL('../contexts/content/domain/review/', import.meta.url));
  const PLANTED_DIR = fileURLToPath(new URL('../fitness-fixtures/as-content-review-domain/', import.meta.url));

  function throwsIn(directory: string): string[] {
    return filesMatching(directory, /(^|[^.\w])throw\s/u);
  }

  function clockReadsIn(directory: string): string[] {
    return filesMatching(directory, /\bDate\.now\b|\bnew Date\b/u);
  }

  it('contains no throw under the real domain/review/', () => {
    expect(throwsIn(REVIEW_DOMAIN_DIR)).toEqual([]);
  });

  it('reads no clock under the real domain/review/', () => {
    expect(clockReadsIn(REVIEW_DOMAIN_DIR)).toEqual([]);
  });

  it('catches a planted throw', () => {
    expect(throwsIn(PLANTED_DIR)).toHaveLength(1);
  });

  it('catches a planted clock read', () => {
    expect(clockReadsIn(PLANTED_DIR)).toHaveLength(1);
  });
});
