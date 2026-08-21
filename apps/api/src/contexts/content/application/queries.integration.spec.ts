import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  itemOption,
  numericSpec,
  originalProvenance,
  singleCorrectSpec,
  textBody,
} from '../../../testing/content-fixtures.js';
import type { Result } from '../domain/result.js';
import { transitionItem, type Item } from '../domain/item.js';
import type { FinalAnswerAssertion } from '../domain/solution.js';
import type { ItemVersion } from '../domain/item-version.js';
import type { CreateResponseSpecificationProps } from '../domain/response-specification.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../infrastructure/media-asset.repository.js';
import { PostgresReviewDecisionRepository } from '../infrastructure/review-decision.repository.js';
import { PostgresTransactionRunner } from '../infrastructure/transaction-runner.js';
import { PostgresSolutionRepository } from '../infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../infrastructure/stimulus.repository.js';
import type { ApplicationError } from './authorization.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';
import { CreateItemDraftHandler, type ItemAuthoringDependencies } from './handlers/authoring-handlers.js';
import { CreateSolutionDraftHandler, type SolutionAuthoringDependencies } from './handlers/solution-handlers.js';
import {
  CreateStimulusDraftHandler,
  type StimulusAuthoringDependencies,
} from './handlers/stimulus-handlers.js';
import { RegisterMediaAssetHandler, type MediaAuthoringDependencies } from './handlers/media-handlers.js';
import {
  PublishItemVersionHandler,
  PublishSolutionVersionHandler,
  PublishStimulusVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  RecordStimulusReviewDecisionHandler,
  RetireItemHandler,
  SubmitItemForReviewHandler,
  SubmitSolutionForReviewHandler,
  SubmitStimulusForReviewHandler,
  SuspendItemHandler,
  WithdrawItemFromReviewHandler,
  type LifecycleDependencies,
} from './handlers/lifecycle-handlers.js';
import {
  GetItemDraftHandler,
  GetItemVersionForAuthoringHandler,
  GetValidationFindingsHandler,
  ListMediaAssetsHandler,
  ListMyDraftsHandler,
  ListSubmittedForReviewHandler,
  type AuthoringQueryDependencies,
} from './queries/authoring-queries.js';
import { LIFECYCLE_STATES, type LifecycleState } from '../domain/item-lifecycle.js';

const LIFECYCLE_STATES_UNDER_TEST = LIFECYCLE_STATES.filter((state) => state !== 'in_review');
import {
  GetPublishedItemHandler,
  GetPublishedSolutionHandler,
  GetPublishedStimulusHandler,
  type DeliveryQueryDependencies,
} from './queries/delivery-queries.js';
import {
  InMemoryAuditRecorder,
  InMemoryEntitlements,
  InMemoryIdempotencyStore,
  InMemoryMediaStore,
  InMemoryReviewProgress,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
  type RenderValidator,
} from './ports.js';

/**
 * DEC-4's boundary, asserted the M2-24 way: serialize a real view produced
 * from a real published item and scan the JSON for key material. A structural
 * type check would pass on a field a spread carried in by accident, which is
 * exactly how a key reaches a payload.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let stimuli: PostgresStimulusRepository;
let solutions: PostgresSolutionRepository;
let assets: PostgresMediaAssetRepository;
let reviews: PostgresReviewDecisionRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  stimuli = new PostgresStimulusRepository(database.pool);
  solutions = new PostgresSolutionRepository(database.pool);
  assets = new PostgresMediaAssetRepository(database.pool);
  reviews = new PostgresReviewDecisionRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-b100-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const OTHER_AUTHOR_ID = freshUuid();
const REVIEWER_ID = freshUuid();
const OPS_ID = freshUuid();
const LEARNER_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author', 'subject:physics'] };
const otherAuthor: PrincipalRef = {
  kind: 'human',
  id: OTHER_AUTHOR_ID,
  roleContext: ['author', 'subject:physics'],
};
const reviewer: PrincipalRef = { kind: 'human', id: REVIEWER_ID, roleContext: ['reviewer'] };
const contentOps: PrincipalRef = { kind: 'human', id: OPS_ID, roleContext: ['content_ops'] };
const learner: PrincipalRef = { kind: 'human', id: LEARNER_ID, roleContext: ['learner'] };

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });
const asOps = (): ApplicationContext => ({ principal: contentOps, correlationId: 'c', stepUpSatisfied: true });
type Refusal = Result<unknown, ApplicationError>;

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };
const entitlements = new InMemoryEntitlements();
const mediaStore = new InMemoryMediaStore();

const passingRenderer: RenderValidator = {
  async validate(version: ItemVersion) {
    return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] };
  },
};

function shared() {
  return {
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
  };
}

const itemBench = (): ItemAuthoringDependencies => ({ items, ...shared() });
const solutionBench = (): SolutionAuthoringDependencies => ({ solutions, items, ...shared() });
const stimulusBench = (): StimulusAuthoringDependencies => ({ stimuli, items, ...shared() });
const mediaBench = (store: InMemoryMediaStore): MediaAuthoringDependencies => ({
  assets,
  store,
  clock,
  identifiers,
  audit: new InMemoryAuditRecorder(),
});

const lifecycle = (): LifecycleDependencies => ({
  items,
  assets,
  store: mediaStore,
  stimuli,
  solutions,
  reviews,
  renderer: passingRenderer,
  reviewProgress: new InMemoryReviewProgress(),
  transactions: new PostgresTransactionRunner(database.pool),
  clock,
  identifiers,
  audit: new InMemoryAuditRecorder(),
});

const authoringQueries = (): AuthoringQueryDependencies => ({
  items,
  solutions,
  assets,
  renderer: passingRenderer,
  clock,
});

const deliveryQueries = (): DeliveryQueryDependencies => ({ items, stimuli, solutions, entitlements });

function itemContent(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [
      { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
    ],
    difficultyEstimate: 'moderate',
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
    ...overrides,
  };
}

async function draftItem(
  overrides: Partial<AuthoredItemContent> = {},
  principal: PrincipalRef = author,
  itemType: CreateResponseSpecificationProps['itemType'] = 'SINGLE_CORRECT_MCQ',
): Promise<Item> {
  return expectValue(
    await new CreateItemDraftHandler(itemBench()).handle(
      { itemType, content: itemContent(overrides) },
      as(principal),
    ),
  );
}

/** The assertion shape the item type implies (M3-14 refuses any other). */
function finalAnswerFor(item: Item): FinalAnswerAssertion {
  const spec = item.versions[0]!.responseSpec;
  switch (item.itemType) {
    case 'NUMERIC': {
      // Read from the item's own key: agreement is decided by the executor,
      // and a hardcoded answer would only agree with a hardcoded item.
      const numeric = spec.itemType === 'NUMERIC' ? spec.spec : undefined;
      const unit = numeric?.unit?.canonical;
      return {
        kind: 'NUMERIC',
        value: numeric?.expectedValue ?? '0',
        ...(unit === undefined ? {} : { unit }),
      };
    }
    case 'MATCHING':
      return {
        kind: 'PAIRS',
        pairs: [
          { left: 'l1', right: 'r1' },
          { left: 'l2', right: 'r2' },
        ],
      };
    case 'MULTIPLE_CORRECT_MCQ':
      return { kind: 'OPTION_SET', optionIds: ['b'] };
    case 'SINGLE_CORRECT_MCQ':
      return { kind: 'OPTION', optionId: 'b' };
  }
}

/** Drives an item all the way to published, with its solution. */
async function publishItem(item: Item): Promise<Item> {
  const deps = lifecycle();
  const solution = expectValue(
    await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: {
          finalAnswerAssertion: finalAnswerFor(item),
          steps: [{ ordinal: 1, body: textBody('Resolve the weight along the incline.'), conceptRefs: [] }],
          distractorAnalyses:
            item.itemType === 'SINGLE_CORRECT_MCQ'
              ? [{ optionId: 'a', misconception: textBody('Forgot to resolve the weight.') }]
              : [],
          alternateApproaches: [
            {
              label: 'Energy method',
              steps: [{ ordinal: 1, body: textBody('Equate potential and kinetic energy.'), conceptRefs: [] }],
              applicabilityNote: 'Only when friction is absent.',
            },
          ],
        },
      },
      as(author),
    ),
  );
  expectValue(await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)));
  expectValue(
    await new RecordSolutionReviewDecisionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    ),
  );
  expectValue(
    await new PublishSolutionVersionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
      asOps(),
    ),
  );

  expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
  expectValue(
    await new RecordItemReviewDecisionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve', candidatesShownIds: [] },
      as(reviewer),
    ),
  );
  return expectValue(
    await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    ),
  );
}

/**
 * The M2-24 method: serialize the view and scan the text. Key material is
 * named by field *and* by value, because a correct option id renamed to
 * `answer` is still the key.
 */
const KEY_FIELD_NAMES = [
  'correctOptionId',
  'correctOptionIds',
  'isCorrect',
  'is_correct',
  'answerKey',
  'expectedValue',
  'toleranceValue',
  'rangeMin',
  'rangeMax',
  'significantFigures',
  'pairs',
  'finalAnswer',
  'finalAnswerAssertion',
  'responseSpec',
] as const;

function scanForKeyMaterial(view: unknown): readonly string[] {
  const serialized = JSON.stringify(view);
  return KEY_FIELD_NAMES.filter((field) => serialized.includes(`"${field}"`));
}

describe('delivery views carry no key material (§9 rule 10, ADR-0009)', () => {
  it('GetPublishedItem, for a single-correct MCQ', async () => {
    const item = await publishItem(await draftItem());
    const view = expectValue(
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: item.itemId }, as(learner)),
    );

    expect(scanForKeyMaterial(view)).toEqual([]);
    expect(view.options?.map((option) => option.optionId)).toEqual(['a', 'b', 'c', 'd']);
    // The scan is not vacuous: the same item's authoring view does carry it.
    const authoring = expectValue(
      await new GetItemVersionForAuthoringHandler(authoringQueries()).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        as(author),
      ),
    );
    expect(scanForKeyMaterial(authoring)).toContain('correctOptionId');
  });

  it('GetPublishedItem, for a numeric item — no expected value, no tolerance', async () => {
    const item = await publishItem(
      await draftItem({ responseSpec: numericSpec() }, author, 'NUMERIC'),
    );
    const view = expectValue(
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: item.itemId }, as(learner)),
    );

    expect(scanForKeyMaterial(view)).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('9.81');
    // What the input box needs still crosses.
    expect(view.numericInput).toMatchObject({ unitCanonical: 'm/s^2', unitRequired: true });
    expect(view.numericInput?.acceptedForms).toEqual(['DECIMAL', 'SCIENTIFIC']);
  });

  it('GetPublishedItem, for a matching item — the members without the pairing', async () => {
    const matching: CreateResponseSpecificationProps = {
      itemType: 'MATCHING',
      left: [
        { memberId: 'l1', ordinal: 1, body: textBody('Force') },
        { memberId: 'l2', ordinal: 2, body: textBody('Energy') },
      ],
      right: [
        { memberId: 'r1', ordinal: 1, body: textBody('newton') },
        { memberId: 'r2', ordinal: 2, body: textBody('joule') },
      ],
      pairs: [
        { left: 'l1', right: 'r1' },
        { left: 'l2', right: 'r2' },
      ],
    };
    const item = await publishItem(
      await draftItem({ responseSpec: matching }, author, 'MATCHING'),
    );
    const view = expectValue(
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: item.itemId }, as(learner)),
    );

    expect(scanForKeyMaterial(view)).toEqual([]);
    expect(view.matchingLeft?.map((member) => member.memberId)).toEqual(['l1', 'l2']);
    expect(view.matchingRight?.map((member) => member.memberId)).toEqual(['r1', 'r2']);
  });

  it('GetPublishedStimulus', async () => {
    const stimulus = expectValue(
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        {
          stimulusType: 'passage',
          subject: 'physics',
          body: textBody('A 2 kg block rests on a 30° incline.'),
          licensing: { status: 'owned' },
        },
        as(author),
      ),
    );
    const deps = lifecycle();
    expectValue(
      await new SubmitStimulusForReviewHandler(deps).handle({ stimulusId: stimulus.stimulusId }, as(author)),
    );
    expectValue(
      await new RecordStimulusReviewDecisionHandler(deps).handle(
        {
          stimulusId: stimulus.stimulusId,
          stimulusVersionId: stimulus.versions[0]!.versionId,
          outcome: 'approve',
        },
        as(reviewer),
      ),
    );
    expectValue(
      await new PublishStimulusVersionHandler(deps).handle(
        { stimulusId: stimulus.stimulusId, stimulusVersionId: stimulus.versions[0]!.versionId },
        asOps(),
      ),
    );

    const view = expectValue(
      await new GetPublishedStimulusHandler(deliveryQueries()).handle(
        { stimulusId: stimulus.stimulusId },
        as(learner),
      ),
    );
    expect(scanForKeyMaterial(view)).toEqual([]);
    expect(view.stimulusType).toBe('passage');
  });

  it('GetPublishedSolution, at both depths', async () => {
    const item = await publishItem(await draftItem());
    entitlements.grant(LEARNER_ID, 'SOLUTION_DEPTH_FULL');

    const basic = expectValue(
      await new GetPublishedSolutionHandler(deliveryQueries()).handle(
        { itemVersionId: item.versions[0]!.versionId, depth: 'basic' },
        as(learner),
      ),
    );
    const full = expectValue(
      await new GetPublishedSolutionHandler(deliveryQueries()).handle(
        { itemVersionId: item.versions[0]!.versionId, depth: 'full' },
        as(learner),
      ),
    );

    expect(scanForKeyMaterial(basic)).toEqual([]);
    expect(scanForKeyMaterial(full)).toEqual([]);
    expect(basic.steps).toHaveLength(1);
    expect(basic.distractorAnalyses).toBeUndefined();
    expect(full.distractorAnalyses).toHaveLength(1);
    expect(full.alternateApproaches?.[0]?.label).toBe('Energy method');
  });

  it('reports a published thing that is not there rather than an empty view', async () => {
    const refusals: readonly Refusal[] = [
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: freshUuid() }, as(learner)),
      await new GetPublishedStimulusHandler(deliveryQueries()).handle(
        { stimulusId: freshUuid() },
        as(learner),
      ),
      await new GetPublishedSolutionHandler(deliveryQueries()).handle(
        { itemVersionId: freshUuid(), depth: 'basic' },
        as(learner),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).kind).toBe('NotFound');
    }
  });

  it('does not serve an item that has been drafted but never published', async () => {
    const item = await draftItem();
    const refused = await new GetPublishedItemHandler(deliveryQueries()).handle(
      { itemId: item.itemId },
      as(learner),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('does not serve a stimulus whose draft exists but is unpublished', async () => {
    const stimulus = expectValue(
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusType: 'passage', subject: 'physics', body: textBody('unpublished') },
        as(author),
      ),
    );
    const refused = await new GetPublishedStimulusHandler(deliveryQueries()).handle(
      { stimulusId: stimulus.stimulusId },
      as(learner),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });
});

describe('entitlement is a distinct kind from authorization (§8)', () => {
  it('refuses the paid depth with Entitlement, not Authorization', async () => {
    const item = await publishItem(await draftItem());
    const unentitled: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['learner'] };

    const refused = await new GetPublishedSolutionHandler(deliveryQueries()).handle(
      { itemVersionId: item.versions[0]!.versionId, depth: 'full' },
      as(unentitled),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('Entitlement');
    expect(error.code).toBe('SOLUTION_DEPTH_NOT_ENTITLED');
  });

  // INV-08. The correct answer and the derivation are an unconditional grant,
  // so the entitlement service is never even asked about them.
  it('never gates basic correctness, even for a principal entitled to nothing', async () => {
    const item = await publishItem(await draftItem());
    const unentitled: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['learner'] };

    const basic = expectValue(
      await new GetPublishedSolutionHandler(deliveryQueries()).handle(
        { itemVersionId: item.versions[0]!.versionId, depth: 'basic' },
        as(unentitled),
      ),
    );
    expect(basic.steps).toHaveLength(1);
  });
});

describe('authoring queries carry the key, and only for authoring roles', () => {
  it('returns the whole authored version, key included', async () => {
    const item = await draftItem();
    const view = expectValue(
      await new GetItemDraftHandler(authoringQueries()).handle({ itemId: item.itemId }, as(author)),
    );
    expect(view.versions[0]!.responseSpec).toMatchObject({ correctOptionId: 'b' });
  });

  it('lists the author’s own drafts', async () => {
    const item = await draftItem();
    const list = expectValue(
      await new ListMyDraftsHandler(authoringQueries()).handle({ authorId: AUTHOR_ID }, as(author)),
    );
    expect(list.items.map((entry) => entry.itemId)).toContain(item.itemId);
  });

  it('refuses a learner with Authorization rather than an empty result', async () => {
    const item = await draftItem();
    const refusals: readonly Refusal[] = [
      await new GetItemDraftHandler(authoringQueries()).handle({ itemId: item.itemId }, as(learner)),
      await new ListMyDraftsHandler(authoringQueries()).handle({ authorId: AUTHOR_ID }, as(learner)),
      await new GetItemVersionForAuthoringHandler(authoringQueries()).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        as(learner),
      ),
      await new GetValidationFindingsHandler(authoringQueries()).handle({ itemId: item.itemId }, as(learner)),
      await new ListMediaAssetsHandler(authoringQueries()).handle({}, as(learner)),
    ];
    for (const refused of refusals) {
      const error = expectError(refused);
      expect(error.kind).toBe('Authorization');
      expect(error.code).toBe('NOT_PERMITTED');
    }
  });

  it('refuses another author reaching a draft that is not theirs', async () => {
    const item = await draftItem();
    const refusals: readonly Refusal[] = [
      await new GetItemDraftHandler(authoringQueries()).handle({ itemId: item.itemId }, as(otherAuthor)),
      await new ListMyDraftsHandler(authoringQueries()).handle({ authorId: AUTHOR_ID }, as(otherAuthor)),
      await new GetItemVersionForAuthoringHandler(authoringQueries()).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        as(otherAuthor),
      ),
      await new GetValidationFindingsHandler(authoringQueries()).handle(
        { itemId: item.itemId },
        as(otherAuthor),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('NOT_THE_DRAFT_OWNER');
    }
  });

  it('permits Content Ops on somebody else’s draft', async () => {
    const item = await draftItem();
    expectValue(
      await new GetItemDraftHandler(authoringQueries()).handle({ itemId: item.itemId }, as(contentOps)),
    );
  });

  it('reports a version the item does not hold, and an item that is not there', async () => {
    const item = await draftItem();
    expect(
      expectError(
        await new GetItemVersionForAuthoringHandler(authoringQueries()).handle(
          { itemId: item.itemId, itemVersionId: freshUuid() },
          as(author),
        ),
      ).code,
    ).toBe('VERSION_NOT_FOUND');

    const missing: readonly Refusal[] = [
      await new GetItemDraftHandler(authoringQueries()).handle({ itemId: freshUuid() }, as(author)),
      await new GetItemVersionForAuthoringHandler(authoringQueries()).handle(
        { itemId: freshUuid(), itemVersionId: freshUuid() },
        as(author),
      ),
      await new GetValidationFindingsHandler(authoringQueries()).handle({ itemId: freshUuid() }, as(author)),
    ];
    for (const refused of missing) {
      expect(expectError(refused).kind).toBe('NotFound');
    }
  });
});

describe('the validation findings an author acts on (FR-TCH-07)', () => {
  it('reports the missing solution as blocking and says the duplicate check has not run', async () => {
    const item = await draftItem();
    const report = expectValue(
      await new GetValidationFindingsHandler(authoringQueries()).handle({ itemId: item.itemId }, as(author)),
    );

    expect(report.maySubmit).toBe(false);
    expect(report.blocking.map((finding) => finding.code)).toContain('SOLUTION_MISSING');
    expect(report.duplicateCheckState).toBe('not_evaluated');
    for (const finding of report.findings) {
      expect(finding.location).toBeTruthy();
    }
  });

  it('clears once the solution is published', async () => {
    const item = await publishItem(await draftItem());
    const report = expectValue(
      await new GetValidationFindingsHandler(authoringQueries()).handle({ itemId: item.itemId }, as(author)),
    );
    expect(report.blocking.map((finding) => finding.code)).not.toContain('SOLUTION_MISSING');
  });

  it('reports an unrenderable surface as blocking', async () => {
    const failing: RenderValidator = {
      async validate(version: ItemVersion) {
        return {
          itemVersionId: version.versionId,
          surfacesChecked: ['print'],
          failures: ['print: blocks[0] does not render'],
        };
      },
    };
    const item = await draftItem();
    const report = expectValue(
      await new GetValidationFindingsHandler({ ...authoringQueries(), renderer: failing }).handle(
        { itemId: item.itemId },
        as(author),
      ),
    );
    expect(report.blocking.map((finding) => finding.code)).toContain('NOTATION_UNRENDERABLE');
  });

  it('warns about an unanalysed distractor without blocking on it', async () => {
    const item = await publishItem(
      await draftItem({
        responseSpec: singleCorrectSpec({
          options: [itemOption('a', 1), itemOption('b', 2), itemOption('c', 3)],
          correctOptionId: 'b',
        }),
      }),
    );
    const report = expectValue(
      await new GetValidationFindingsHandler(authoringQueries()).handle({ itemId: item.itemId }, as(author)),
    );
    expect(report.warnings.map((finding) => finding.code)).toContain('DISTRACTOR_ANALYSIS_MISSING');
    expect(report.blocking.map((finding) => finding.code)).not.toContain('DISTRACTOR_ANALYSIS_MISSING');
  });
});

describe('the media library', () => {
  it('lists every asset with the alt text that made it registrable', async () => {
    const store = new InMemoryMediaStore();
    const stored = await store.put(new Uint8Array([1, 2, 3]), 'image/png');
    const asset = expectValue(
      await new RegisterMediaAssetHandler(mediaBench(store)).handle(
        {
          assetType: 'diagram',
          subject: 'physics',
          version: {
            storageKey: stored.storageKey,
            mimeType: 'image/png',
            width: 800,
            height: 600,
            altText: 'A block on a ramp inclined at thirty degrees',
            longDescription: 'The ramp rises left to right at 30°.',
            licensing: { status: 'owned' },
          },
        },
        as(author),
      ),
    );

    const list = expectValue(
      await new ListMediaAssetsHandler(authoringQueries()).handle({}, as(author)),
    );
    const found = list.find((entry) => entry.assetId === asset.assetId);
    expect(found).toMatchObject({
      assetType: 'diagram',
      mimeType: 'image/png',
      altText: 'A block on a ramp inclined at thirty degrees',
      longDescription: 'The ramp rises left to right at 30°.',
    });
  });
});

describe('a suspended item stops being served', () => {
  it('is refused by the delivery query while its history is retained', async () => {
    const item = await publishItem(await draftItem());
    expectValue(await items.save(expectValue(transitionItem(item, { transition: 'suspend' }))));

    const refused = await new GetPublishedItemHandler(deliveryQueries()).handle(
      { itemId: item.itemId },
      as(learner),
    );
    expect(expectError(refused).kind).toBe('NotFound');

    // The pointer survives — that is what makes reinstatement possible, and
    // it is exactly why the state, not the pointer, decides delivery.
    const loaded = expectValue(await items.findById(item.itemId));
    expect(loaded.lifecycleState).toBe('suspended');
    expect(loaded.currentPublishedVersionId).toBe(item.versions[0]!.versionId);
  });
});

describe('the remaining shapes each view has to carry', () => {
  it('names the pinned stimulus version on both families of item view', async () => {
    const stimulus = expectValue(
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusType: 'passage', subject: 'physics', body: textBody('A shared passage.') },
        as(author),
      ),
    );
    const item = await publishItem(
      await draftItem({ stimulusVersionRef: stimulus.versions[0]!.versionId }),
    );

    const delivery = expectValue(
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: item.itemId }, as(learner)),
    );
    expect(delivery.stimulusVersionId).toBe(stimulus.versions[0]!.versionId);

    const authoring = expectValue(
      await new GetItemDraftHandler(authoringQueries()).handle({ itemId: item.itemId }, as(contentOps)),
    );
    expect(authoring.currentPublishedVersionId).toBe(item.versions[0]!.versionId);
    expect(authoring.versions[0]!.stimulusVersionRef).toBe(stimulus.versions[0]!.versionId);
  });

  it('carries a numeric item with no unit at all', async () => {
    const item = await publishItem(
      await draftItem(
        {
          responseSpec: {
            itemType: 'NUMERIC',
            spec: {
              expectedValue: '42',
              comparisonMode: 'EXACT',
              acceptedForms: ['DECIMAL'],
            },
          },
        },
        author,
        'NUMERIC',
      ),
    );
    const view = expectValue(
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: item.itemId }, as(learner)),
    );
    expect(view.numericInput).toEqual({ unitRequired: false, acceptedForms: ['DECIMAL'] });
    expect(JSON.stringify(view)).not.toContain('42');
  });

  it('carries an alternate approach with no applicability note', async () => {
    const item = await draftItem();
    const deps = lifecycle();
    const solution = expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [{ ordinal: 1, body: textBody('Resolve the weight.'), conceptRefs: [] }],
            alternateApproaches: [
              {
                label: 'Energy method',
                steps: [{ ordinal: 1, body: textBody('Equate energies.'), conceptRefs: [] }],
              },
            ],
          },
        },
        as(author),
      ),
    );
    expectValue(
      await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)),
    );
    expectValue(
      await new RecordSolutionReviewDecisionHandler(deps).handle(
        { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId, outcome: 'approve' },
        as(reviewer),
      ),
    );
    expectValue(
      await new PublishSolutionVersionHandler(deps).handle(
        { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
        asOps(),
      ),
    );

    entitlements.grant(LEARNER_ID, 'SOLUTION_DEPTH_FULL');
    const view = expectValue(
      await new GetPublishedSolutionHandler(deliveryQueries()).handle(
        { itemVersionId: item.versions[0]!.versionId, depth: 'full' },
        as(learner),
      ),
    );
    expect(view.alternateApproaches?.[0]).not.toHaveProperty('applicabilityNote');
  });

  it('lists a photograph, which carries alt text and no long description', async () => {
    const store = new InMemoryMediaStore();
    const stored = await store.put(new Uint8Array([7]), 'image/jpeg');
    const asset = expectValue(
      await new RegisterMediaAssetHandler(mediaBench(store)).handle(
        {
          assetType: 'photograph',
          subject: 'physics',
          version: {
            storageKey: stored.storageKey,
            mimeType: 'image/jpeg',
            width: 1200,
            height: 900,
            altText: 'A trolley on a laboratory track',
            licensing: { status: 'owned' },
          },
        },
        as(author),
      ),
    );

    const list = expectValue(await new ListMediaAssetsHandler(authoringQueries()).handle({}, as(author)));
    const found = list.find((entry) => entry.assetId === asset.assetId);
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty('longDescription');
  });

  it('refuses a principal holding no delivery role at all', async () => {
    const stranger: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['nobody'] };
    const refusals: readonly Refusal[] = [
      await new GetPublishedItemHandler(deliveryQueries()).handle({ itemId: freshUuid() }, as(stranger)),
      await new GetPublishedStimulusHandler(deliveryQueries()).handle(
        { stimulusId: freshUuid() },
        as(stranger),
      ),
      await new GetPublishedSolutionHandler(deliveryQueries()).handle(
        { itemVersionId: freshUuid(), depth: 'basic' },
        as(stranger),
      ),
    ];
    for (const refused of refusals) {
      const error = expectError(refused);
      expect(error.kind).toBe('Authorization');
      expect(error.code).toBe('NOT_PERMITTED');
    }
  });
});

describe('the media library reports what it cannot read', () => {
  // An asset row with no versions cannot be reconstituted, and a list that
  // skipped it would report a library smaller than the table.
  it('reports a stored asset that cannot reconstitute rather than omitting it', async () => {
    expectValue(await new ListMediaAssetsHandler(authoringQueries()).handle({}, as(author)));

    const orphanId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.media_asset (asset_id, asset_type) VALUES ($1, 'diagram')`,
      [orphanId],
    );

    const refused = await new ListMediaAssetsHandler(authoringQueries()).handle({}, as(author));
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');

    await database.pool.query(`DELETE FROM content.media_asset WHERE asset_id = $1`, [orphanId]);
    expectValue(await new ListMediaAssetsHandler(authoringQueries()).handle({}, as(author)));
  });
});

/** Drives a freshly drafted item to exactly the named state, via real handlers. */
async function driveToState(item: Item, state: LifecycleState): Promise<Item> {
  const deps = lifecycle();
  const versionId = item.versions[0]!.versionId;
  switch (state) {
    case 'draft':
      return item;
    case 'in_review':
      return expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
    case 'changes_requested': {
      await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author));
      return expectValue(
        await new RecordItemReviewDecisionHandler(deps).handle(
          {
            itemId: item.itemId,
            itemVersionId: versionId,
            outcome: 'request_changes',
            justification: 'unclear',
            reasonCode: 'FACTUALLY_INCORRECT',
            candidatesShownIds: [],
          },
          as(reviewer),
        ),
      );
    }
    case 'approved': {
      await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author));
      return expectValue(
        await new RecordItemReviewDecisionHandler(deps).handle(
          { itemId: item.itemId, itemVersionId: versionId, outcome: 'approve', candidatesShownIds: [] },
          as(reviewer),
        ),
      );
    }
    case 'rejected': {
      await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author));
      return expectValue(
        await new RecordItemReviewDecisionHandler(deps).handle(
          {
            itemId: item.itemId,
            itemVersionId: versionId,
            outcome: 'reject',
            justification: 'off-syllabus',
            reasonCode: 'OUT_OF_SYLLABUS',
            candidatesShownIds: [],
          },
          as(reviewer),
        ),
      );
    }
    case 'published':
      return publishItem(item);
    case 'suspended': {
      const published = await publishItem(item);
      return expectValue(
        await new SuspendItemHandler(deps).handle(
          { itemId: published.itemId, justification: 'defect report' },
          asOps(),
        ),
      );
    }
    case 'retired': {
      const published = await publishItem(item);
      return expectValue(
        await new RetireItemHandler(deps).handle(
          { itemId: published.itemId, retirementReason: 'superseded' },
          asOps(),
        ),
      );
    }
  }
}

describe('ListSubmittedForReview, the review queue candidate source (M4-16)', () => {
  it('returns only in_review items — proven exhaustively over all 8 lifecycle states', async () => {
    const inReviewItem = await driveToState(await draftItem(), 'in_review');
    const others: Item[] = [];
    for (const state of LIFECYCLE_STATES_UNDER_TEST) {
      others.push(await driveToState(await draftItem(), state));
    }

    const page = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle({ limit: 100 }, as(reviewer)),
    );
    const ids = page.items.map((i) => i.itemId);
    expect(ids).toContain(inReviewItem.itemId);
    for (const other of others) expect(ids).not.toContain(other.itemId);
  });

  it('filters by subject', async () => {
    const item = await draftItem({}, author);
    await driveToState(item, 'in_review');

    const matched = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle(
        { limit: 100, subject: 'physics' },
        as(reviewer),
      ),
    );
    expect(matched.items.map((i) => i.itemId)).toContain(item.itemId);

    const unmatched = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle(
        { limit: 100, subject: 'chemistry' },
        as(reviewer),
      ),
    );
    expect(unmatched.items.map((i) => i.itemId)).not.toContain(item.itemId);
  });

  it('excludes the named author — the source-level half of INV-12', async () => {
    const mine = await driveToState(await draftItem({}, author), 'in_review');
    const theirs = await driveToState(await draftItem({}, otherAuthor), 'in_review');

    const page = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle(
        { limit: 100, excludeAuthorId: AUTHOR_ID },
        as(reviewer),
      ),
    );
    const ids = page.items.map((i) => i.itemId);
    expect(ids).not.toContain(mine.itemId);
    expect(ids).toContain(theirs.itemId);
  });

  it('paginates by a stable keyset cursor rather than an offset', async () => {
    const first = await driveToState(await draftItem(), 'in_review');
    const second = await driveToState(await draftItem(), 'in_review');

    const page1 = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle({ limit: 1 }, as(reviewer)),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
    const cursor = page1.nextCursor!;

    // A concurrent insert between pages must not shift the boundary.
    const inserted = await driveToState(await draftItem(), 'in_review');

    const page2 = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle({ limit: 100, cursor }, as(reviewer)),
    );
    const page2Ids = page2.items.map((i) => i.itemId);
    expect(page2Ids).not.toContain(page1.items[0]!.itemId);
    for (const id of [first.itemId, second.itemId, inserted.itemId]) {
      expect([...page1.items.map((i) => i.itemId), ...page2Ids]).toContain(id);
    }
  });

  it('reports blockingCount/warningCount from M3’s own validation', async () => {
    const item = await driveToState(await draftItem(), 'in_review');
    const page = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle({ limit: 100 }, as(reviewer)),
    );
    const found = page.items.find((i) => i.itemId === item.itemId);
    expect(found).toBeDefined();
    // No solution published yet — FR-TCH-07's missing-solution finding blocks.
    expect(found?.blockingCount).toBeGreaterThan(0);
  });

  it('refuses a learner with Authorization', async () => {
    const refused = await new ListSubmittedForReviewHandler(authoringQueries()).handle(
      { limit: 100 },
      as(learner),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('Authorization');
    expect(error.code).toBe('NOT_PERMITTED');
  });

  it('lowers blockingCount once a solution is published for the version under review', async () => {
    const item = await draftItem();
    const solution = expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: finalAnswerFor(item),
            steps: [{ ordinal: 1, body: textBody('Resolve the weight along the incline.'), conceptRefs: [] }],
            distractorAnalyses: [{ optionId: 'a', misconception: textBody('Forgot to resolve the weight.') }],
            alternateApproaches: [],
          },
        },
        as(author),
      ),
    );
    const deps = lifecycle();
    expectValue(await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)));
    expectValue(
      await new RecordSolutionReviewDecisionHandler(deps).handle(
        { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId, outcome: 'approve' },
        as(reviewer),
      ),
    );
    expectValue(
      await new PublishSolutionVersionHandler(deps).handle(
        { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
        asOps(),
      ),
    );

    await driveToState(item, 'in_review');

    const page = expectValue(
      await new ListSubmittedForReviewHandler(authoringQueries()).handle({ limit: 100 }, as(reviewer)),
    );
    const found = page.items.find((i) => i.itemId === item.itemId);
    expect(found).toBeDefined();
    expect(found?.blockingCount).toBe(0);
  });

  it('propagates a repository failure rather than dropping the row (PERSISTENCE_REJECTED)', async () => {
    const itemId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state) VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review')`,
      [itemId],
    );
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.item_version
           (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
            difficulty_estimate, authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $4)`,
        [freshUuid(), itemId, versionNo, AUTHOR_ID],
      );
    }

    const refused = await new ListSubmittedForReviewHandler(authoringQueries()).handle(
      { limit: 100 },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');

    await database.pool.query(`DELETE FROM content.item_version WHERE item_id = $1`, [itemId]);
    await database.pool.query(`DELETE FROM content.item WHERE item_id = $1`, [itemId]);
  });
});
