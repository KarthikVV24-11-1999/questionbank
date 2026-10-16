import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { FOUR_OPTIONS, aiProvenance, numericSpec, singleCorrectSpec, tags, textBody } from '../../../testing/content-fixtures.js';
import { createContentBody } from '../domain/content-body.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../infrastructure/media-asset.repository.js';
import { PostgresSolutionRepository } from '../infrastructure/solution.repository.js';
import { RenderValidatorAdapter } from '../infrastructure/render-validator.adapter.js';
import { CreateItemDraftHandler } from './handlers/authoring-handlers.js';
import { GetValidationFindingsHandler } from './queries/authoring-queries.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore, type ApplicationContext } from './ports.js';
import { validateProposedContent } from './proposal-validation.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';

/**
 * **One validator, two ways in.** A stored draft's report comes from
 * `GetValidationFindings`; a proposal's from `validateProposedContent`. Both
 * must reach the same `validateDraft`, and "must" is asserted here, over one
 * shared set of fixtures, finding for finding and code for code — the parity
 * test handbook §5 asks for wherever one rule could be written twice.
 *
 * The stored path is the real one: the real handlers, the real repository on real
 * Postgres, and the real renderer. A rule added to one path and not the other
 * fails the comparison for whichever fixture exercises it.
 */
let database: TestDatabase;
let items: PostgresItemRepository;

const AS_OF = '2026-08-11T09:00:00.000Z';
const author: PrincipalRef = { kind: 'human', id: '00000000-0000-4000-9000-0000000000a1', roleContext: ['author', 'subject:physics'] };
const asAuthor: ApplicationContext = { principal: author, correlationId: 'corr-parity' };
const clock = { now: () => new Date(AS_OF) };
let uuidSeed = 0;
const identifiers = { next: () => `00000000-0000-4000-9000-${(++uuidSeed).toString(16).padStart(12, '0')}` };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

// Content stores the model, prompt and run as UUIDs, so a draft that is to be stored carries them as UUIDs.
const UUID_PROVENANCE = {
  modelVersionId: '00000000-0000-4000-8000-0000000a0001',
  promptVersionId: '00000000-0000-4000-8000-0000000b0001',
  generationRunId: '00000000-0000-4000-8000-0000000c0001',
};

function sound(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec({ correctOptionId: 'a' }),
    taxonomyTags: tags({ conceptIdentityId: '00000000-0000-4000-8000-0000000d0001', taxonomyVersionId: '00000000-0000-4000-8000-0000000e0001' }),
    difficultyEstimate: 'moderate',
    provenance: aiProvenance(UUID_PROVENANCE),
    licensing: { status: 'owned' },
    ...overrides,
  };
}
const without = (key: keyof AuthoredItemContent): AuthoredItemContent => {
  const { [key]: _removed, ...rest } = sound();
  return rest as AuthoredItemContent;
};
const unrenderable = (() => {
  const body = createContentBody([{ kind: 'MATH_BLOCK', latex: '\\wormhole', textAlternative: 'a wormhole' }]);
  if (!body.ok) throw new Error('fixture');
  return body.value;
})();

/** Content the domain will build into a draft, and which differs in what the report should say. */
const STORABLE: readonly (readonly [string, AuthoredItemContent])[] = [
  ['a sound item', sound()],
  ['no licensing stated', without('licensing')],
  ['licensing unresolved', sound({ licensing: { status: 'unresolved' } })],
  ['a licence that has expired', sound({ licensing: { status: 'licensed', licenseRef: 'CC-BY-4.0', attribution: 'Example Press', expiresAt: '2026-01-01T00:00:00Z' } })],
  ['a licence that has not', sound({ licensing: { status: 'licensed', licenseRef: 'CC-BY-4.0', attribution: 'Example Press', expiresAt: '2030-01-01T00:00:00Z' } })],
  ['a complete numeric item', sound({ responseSpec: numericSpec() })],
  ['notation that does not render', sound({ stem: unrenderable })],
  ['an unusual difficulty band', sound({ difficultyEstimate: 'advanced' })],
  ['a multiple-answer item with distractors to analyse', sound({ responseSpec: { itemType: 'MULTIPLE_CORRECT_MCQ', options: FOUR_OPTIONS, correctOptionIds: ['a', 'b'] } })],
  ['notation that does not render, and licensing unresolved', sound({ stem: unrenderable, licensing: { status: 'unresolved' } })],
];

/**
 * A specification the draft handler will not store because the scoring executor
 * would not accept its key. The proposal path says the same thing as findings:
 * the handler refuses to store it, the validator reports it unsubmittable.
 */
const NUMERIC_WITHOUT_TOLERANCE = sound({
  responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '9.81', comparisonMode: 'ABSOLUTE_TOLERANCE', acceptedForms: ['DECIMAL'] } },
});

/** Content the domain refuses to build at all; the proposal path must say the same thing as a finding. */
const REFUSED: readonly (readonly [string, AuthoredItemContent])[] = [
  ['no concept tags', sound({ taxonomyTags: [] })],
  ['a key naming an option that is not there', sound({ responseSpec: singleCorrectSpec({ correctOptionId: 'z' }) })],
  ['AI provenance without a confidence', sound({ provenance: { ...aiProvenance(UUID_PROVENANCE), confidence: undefined } as never })],
  ['too few options', sound({ responseSpec: singleCorrectSpec({ options: [FOUR_OPTIONS[0]!], correctOptionId: 'a' }) })],
  ['a specification with no options at all', sound({ responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' } as never })],
];

async function storedReport(content: AuthoredItemContent) {
  const created = await new CreateItemDraftHandler({ items, clock, identifiers, audit: new InMemoryAuditRecorder(), idempotency: new InMemoryIdempotencyStore() }).handle(
    { itemType: content.responseSpec.itemType, content, subject: 'physics' },
    asAuthor,
  );
  if (!created.ok) return { created };
  const report = await new GetValidationFindingsHandler({
    items,
    solutions: new PostgresSolutionRepository(database.pool),
    assets: new PostgresMediaAssetRepository(database.pool),
    renderer: new RenderValidatorAdapter(),
    clock,
  }).handle({ itemId: created.value.itemId }, asAuthor);
  return { created, report: expectValue(report) };
}

describe('the proposal path and the stored-draft path reach the same findings', () => {
  for (const [name, content] of STORABLE) {
    it(`for ${name}: finding for finding, code for code`, async () => {
      const stored = await storedReport(content);
      expect(stored.created.ok ? 'storable' : `refused: ${JSON.stringify(stored.created.error)}`, 'the fixture must be storable').toBe('storable');

      const proposed = validateProposedContent(content, { asOf: AS_OF });
      expect(proposed.findings).toEqual(stored.report?.findings);
      expect(proposed.blocking).toEqual(stored.report?.blocking);
      expect(proposed.warnings).toEqual(stored.report?.warnings);
      expect(proposed.maySubmit).toBe(stored.report?.maySubmit);
      expect(proposed.duplicateCheckState).toBe(stored.report?.duplicateCheckState);
    });
  }

  it('over fixtures that differ: the findings cover blocking and warning codes, not one kind', async () => {
    const reports = STORABLE.map(([, content]) => validateProposedContent(content, { asOf: AS_OF }));
    expect(reports.filter((report) => report.blocking.length > 0).length).toBeGreaterThan(3);
    expect(reports.filter((report) => report.warnings.length > 0).length).toBeGreaterThan(1);
    expect(new Set(reports.flatMap((report) => report.findings.map((finding) => finding.code))).size).toBeGreaterThanOrEqual(5);
  });

  for (const [name, content] of REFUSED) {
    it(`for ${name}: the domain refuses to store it, and the proposal path reports that same refusal as its finding`, async () => {
      const stored = await storedReport(content);
      expect(stored.created.ok).toBe(false);
      const refusal = expectError(stored.created);

      const proposed = validateProposedContent(content, { asOf: AS_OF });
      expect(proposed.maySubmit).toBe(false);
      const finding = proposed.findings.find((candidate) => candidate.code === 'STRUCTURE_INVALID');
      expect(finding?.message).toBe(`${refusal.code}: ${refusal.message}`);
      expect(finding?.location).toBe(refusal.location);
    });
  }

  it('for a numeric item whose comparison mode needs a tolerance it lacks: the handler will not store it, and the proposal path reports why', async () => {
    const stored = await storedReport(NUMERIC_WITHOUT_TOLERANCE);
    expect(expectError(stored.created).code).toBe('ANSWER_KEY_REJECTED_BY_EXECUTOR');

    const proposed = validateProposedContent(NUMERIC_WITHOUT_TOLERANCE, { asOf: AS_OF });
    expect(proposed.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['ANSWER_KEY_MISSING', 'NUMERIC_TOLERANCE_MISSING']));
    expect(proposed.maySubmit).toBe(false);
  });
});
