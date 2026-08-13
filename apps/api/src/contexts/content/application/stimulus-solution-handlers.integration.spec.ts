import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  originalProvenance,
  singleCorrectSpec,
  numericSpec,
  textBody,
} from '../../../testing/content-fixtures.js';
import type { Result } from '../domain/result.js';
import { latestVersionOf, publishVersion, transitionItem, type Item } from '../domain/item.js';
import {
  addStimulusVersion,
  createStimulusVersion,
  latestStimulusVersionOf,
  transitionStimulus,
  type Stimulus,
} from '../domain/stimulus.js';
import { transitionSolution, type SolutionStep } from '../domain/solution.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresSolutionRepository } from '../infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../infrastructure/stimulus.repository.js';
import type { ApplicationError } from './authorization.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';
import { CreateItemDraftHandler, type ItemAuthoringDependencies } from './handlers/authoring-handlers.js';
import {
  AttachStimulusToItemHandler,
  CreateStimulusDraftHandler,
  UpdateStimulusDraftHandler,
  type StimulusAuthoringDependencies,
} from './handlers/stimulus-handlers.js';
import {
  CreateSolutionDraftHandler,
  UpdateSolutionDraftHandler,
  type SolutionAuthoringDependencies,
} from './handlers/solution-handlers.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
} from './ports.js';

/**
 * FR-TCH-03 and FR-TCH-04 against a real database. The two criteria worth the
 * integration cost are the ones a unit test would fake: that an attachment
 * keeps naming the version it pinned after the stimulus moves on, and that a
 * solution disagreeing with the item's key is refused at *save* rather than
 * discovered at publication.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let stimuli: PostgresStimulusRepository;
let solutions: PostgresSolutionRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  stimuli = new PostgresStimulusRepository(database.pool);
  solutions = new PostgresSolutionRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-c000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const PHYSICS_AUTHOR_ID = freshUuid();
const CHEMISTRY_AUTHOR_ID = freshUuid();
const OPS_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const physicsAuthor: PrincipalRef = {
  kind: 'human',
  id: PHYSICS_AUTHOR_ID,
  roleContext: ['author', 'subject:physics'],
};
const chemistryAuthor: PrincipalRef = {
  kind: 'human',
  id: CHEMISTRY_AUTHOR_ID,
  roleContext: ['author', 'subject:chemistry'],
};
const contentOps: PrincipalRef = { kind: 'human', id: OPS_ID, roleContext: ['content_ops'] };
const learner: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['learner'] };

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-1' });
type Refusal = Result<unknown, ApplicationError>;

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };

function shared() {
  return {
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
  };
}

function stimulusBench(): StimulusAuthoringDependencies & { readonly audit: InMemoryAuditRecorder } {
  return { stimuli, items, ...shared() };
}

function solutionBench(): SolutionAuthoringDependencies & { readonly audit: InMemoryAuditRecorder } {
  return { solutions, items, ...shared() };
}

function itemBench(): ItemAuthoringDependencies {
  return { items, ...shared() };
}

function itemContent(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp.'),
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

async function anItem(overrides: Partial<AuthoredItemContent> = {}): Promise<Item> {
  return expectValue(
    await new CreateItemDraftHandler(itemBench()).handle(
      {
        itemType: overrides.responseSpec?.itemType ?? 'SINGLE_CORRECT_MCQ',
        content: itemContent(overrides),
      },
      as(physicsAuthor),
    ),
  );
}

async function aStimulus(): Promise<Stimulus> {
  return expectValue(
    await new CreateStimulusDraftHandler(stimulusBench()).handle(
      {
        stimulusType: 'passage',
        subject: 'physics',
        body: textBody('A 2 kg block rests on a 30° incline.'),
        licensing: { status: 'owned' },
      },
      as(physicsAuthor),
    ),
  );
}

const step = (ordinal: number, text: string): SolutionStep => ({
  ordinal,
  body: textBody(text),
  conceptRefs: [],
});

describe('CreateStimulusDraft', () => {
  it('persists a first-class stimulus with one version', async () => {
    const created = await aStimulus();
    const loaded = expectValue(await stimuli.findById(created.stimulusId));
    expect(loaded.lifecycleState).toBe('draft');
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.versions[0]!.authoredBy.id).toBe(PHYSICS_AUTHOR_ID);
  });

  it('audits the creation', async () => {
    const deps = stimulusBench();
    const created = expectValue(
      await new CreateStimulusDraftHandler(deps).handle(
        { stimulusType: 'dataset', subject: 'physics', body: textBody('t/s v/m·s⁻¹') },
        as(physicsAuthor),
      ),
    );
    expect(deps.audit.entriesFor(created.stimulusId)).toHaveLength(1);
  });

  it('refuses a stimulus type the vocabulary does not name', async () => {
    const refused = await new CreateStimulusDraftHandler(stimulusBench()).handle(
      { stimulusType: 'poem' as never, subject: 'physics', body: textBody('x') },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('STIMULUS_TYPE_UNKNOWN');
  });
});

describe('UpdateStimulusDraft', () => {
  it('edits the draft in place', async () => {
    const deps = stimulusBench();
    const created = await aStimulus();

    expectValue(
      await new UpdateStimulusDraftHandler(deps).handle(
        {
          stimulusId: created.stimulusId,
          subject: 'physics',
          body: textBody('A 3 kg block rests on a 30° incline.'),
          idempotencyKey: 'k',
        },
        as(physicsAuthor),
      ),
    );

    const loaded = expectValue(await stimuli.findById(created.stimulusId));
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.versions[0]!.body).toEqual(textBody('A 3 kg block rests on a 30° incline.'));
  });

  it('treats a repeated idempotency key as a no-op', async () => {
    const deps = stimulusBench();
    const created = await aStimulus();

    const first = expectValue(
      await new UpdateStimulusDraftHandler(deps).handle(
        { stimulusId: created.stimulusId, subject: 'physics', body: textBody('first'), idempotencyKey: 'retry' },
        as(physicsAuthor),
      ),
    );
    const second = expectValue(
      await new UpdateStimulusDraftHandler(deps).handle(
        { stimulusId: created.stimulusId, subject: 'physics', body: textBody('second'), idempotencyKey: 'retry' },
        as(physicsAuthor),
      ),
    );

    expect(second.aggregateVersion).toBe(first.aggregateVersion);
    const loaded = expectValue(await stimuli.findById(created.stimulusId));
    expect(loaded.versions[0]!.body).toEqual(textBody('first'));
  });

  it('refuses to edit the published version', async () => {
    const deps = stimulusBench();
    const created = await aStimulus();
    const published = expectValue(
      transitionStimulus(
        expectValue(
          transitionStimulus(
            expectValue(transitionStimulus(created, { transition: 'submit_for_review' })),
            { transition: 'approve' },
          ),
        ),
        { transition: 'publish', versionId: created.versions[0]!.versionId },
      ),
    );
    expectValue(await stimuli.save(published));

    const refused = await new UpdateStimulusDraftHandler(deps).handle(
      { stimulusId: created.stimulusId, subject: 'physics', body: textBody('rewritten'), idempotencyKey: 'k' },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('reports a stimulus that does not exist', async () => {
    const refused = await new UpdateStimulusDraftHandler(stimulusBench()).handle(
      { stimulusId: freshUuid(), subject: 'physics', body: textBody('x'), idempotencyKey: 'k' },
      as(physicsAuthor),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses another author’s stimulus draft', async () => {
    const created = await aStimulus();
    const refused = await new UpdateStimulusDraftHandler(stimulusBench()).handle(
      { stimulusId: created.stimulusId, subject: 'chemistry', body: textBody('x'), idempotencyKey: 'k' },
      as(chemistryAuthor),
    );
    expect(expectError(refused).code).toBe('NOT_THE_DRAFT_OWNER');
  });
});

describe('AttachStimulusToItem pins a version (FR-TCH-03 rule 2)', () => {
  it('pins the version current at attachment time', async () => {
    const item = await anItem();
    const stimulus = await aStimulus();

    const attached = expectValue(
      await new AttachStimulusToItemHandler(stimulusBench()).handle(
        { itemId: item.itemId, stimulusId: stimulus.stimulusId },
        as(physicsAuthor),
      ),
    );

    expect(latestVersionOf(attached).stimulusVersionRef).toBe(stimulus.versions[0]!.versionId);
    const loaded = expectValue(await items.findById(item.itemId));
    expect(latestVersionOf(loaded).stimulusVersionRef).toBe(stimulus.versions[0]!.versionId);
  });

  it('does not move the association when the stimulus gains a new version', async () => {
    const item = await anItem();
    const stimulus = await aStimulus();
    expectValue(
      await new AttachStimulusToItemHandler(stimulusBench()).handle(
        { itemId: item.itemId, stimulusId: stimulus.stimulusId },
        as(physicsAuthor),
      ),
    );

    const second = expectValue(
      createStimulusVersion({
        versionId: freshUuid(),
        versionNo: 2,
        body: textBody('A 2 kg block rests on a 45° incline.'),
        licensing: { status: 'owned' },
        authoredBy: physicsAuthor,
        createdAt: NOW.toISOString(),
      }),
    );
    expectValue(await stimuli.save(expectValue(addStimulusVersion(stimulus, second))));

    const loaded = expectValue(await items.findById(item.itemId));
    expect(latestVersionOf(loaded).stimulusVersionRef).toBe(stimulus.versions[0]!.versionId);
    expect(latestStimulusVersionOf(expectValue(await stimuli.findById(stimulus.stimulusId))).versionNo).toBe(2);
  });

  it('prefers the published version when the stimulus has one', async () => {
    const stimulus = await aStimulus();
    const published = expectValue(
      transitionStimulus(
        expectValue(
          transitionStimulus(
            expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' })),
            { transition: 'approve' },
          ),
        ),
        { transition: 'publish', versionId: stimulus.versions[0]!.versionId },
      ),
    );
    const second = expectValue(
      createStimulusVersion({
        versionId: freshUuid(),
        versionNo: 2,
        body: textBody('a later draft nobody approved'),
        licensing: { status: 'owned' },
        authoredBy: physicsAuthor,
        createdAt: NOW.toISOString(),
      }),
    );
    expectValue(await stimuli.save(expectValue(addStimulusVersion(published, second))));

    const item = await anItem();
    const attached = expectValue(
      await new AttachStimulusToItemHandler(stimulusBench()).handle(
        { itemId: item.itemId, stimulusId: stimulus.stimulusId },
        as(physicsAuthor),
      ),
    );
    expect(latestVersionOf(attached).stimulusVersionRef).toBe(stimulus.versions[0]!.versionId);
  });

  it('refuses to attach a retired stimulus', async () => {
    const stimulus = await aStimulus();
    // Only published or suspended content is ever retired — a draft is
    // discarded instead (FR-QM-01 rule 5), so it has to get there first.
    const published = expectValue(
      transitionStimulus(
        expectValue(
          transitionStimulus(
            expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' })),
            { transition: 'approve' },
          ),
        ),
        { transition: 'publish', versionId: stimulus.versions[0]!.versionId },
      ),
    );
    expectValue(await stimuli.save(published));
    const retired = expectValue(
      transitionStimulus(published, {
        transition: 'retire',
        retirementReason: 'superseded',
        referencingPublishedItemCount: 0,
      }),
    );
    expectValue(await stimuli.save(retired));

    const item = await anItem();
    const refused = await new AttachStimulusToItemHandler(stimulusBench()).handle(
      { itemId: item.itemId, stimulusId: stimulus.stimulusId },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('STIMULUS_RETIRED');
  });

  it('reports a missing item and a missing stimulus separately', async () => {
    const item = await anItem();
    const missingItem = await new AttachStimulusToItemHandler(stimulusBench()).handle(
      { itemId: freshUuid(), stimulusId: freshUuid() },
      as(physicsAuthor),
    );
    expect(expectError(missingItem).message).toContain('no item');

    const missingStimulus = await new AttachStimulusToItemHandler(stimulusBench()).handle(
      { itemId: item.itemId, stimulusId: freshUuid() },
      as(physicsAuthor),
    );
    expect(expectError(missingStimulus).message).toContain('no stimulus');
  });

  it('refuses to attach to an item that has left draft', async () => {
    const item = await anItem();
    const stimulus = await aStimulus();
    expectValue(await items.save(expectValue(transitionItem(item, { transition: 'submit_for_review' }))));

    const refused = await new AttachStimulusToItemHandler(stimulusBench()).handle(
      { itemId: item.itemId, stimulusId: stimulus.stimulusId },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_EDITABLE');
  });
});

describe('CreateSolutionDraft', () => {
  it('persists a solution targeting a specific item version', async () => {
    const deps = solutionBench();
    const item = await anItem();
    const created = expectValue(
      await new CreateSolutionDraftHandler(deps).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [step(1, 'Resolve the weight along the incline.')],
          },
        },
        as(physicsAuthor),
      ),
    );

    const loaded = expectValue(await solutions.findById(created.solutionId));
    expect(loaded.targetItemVersionId).toBe(item.versions[0]!.versionId);
    expect(loaded.versions[0]!.steps).toHaveLength(1);
    expect(deps.audit.entriesFor(created.solutionId)).toHaveLength(1);
  });

  it('refuses a final answer that disagrees with the item’s key, at save', async () => {
    const item = await anItem();
    const refused = await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'OPTION', optionId: 'c' },
          steps: [step(1, 'A derivation ending at the wrong option.')],
        },
      },
      as(physicsAuthor),
    );
    const error = expectError(refused);
    expect(error.code).toBe('FINAL_ANSWER_DISAGREES_WITH_KEY');
    expect(error.location).toBe('solution.finalAnswerAssertion');
  });

  it('accepts a numeric answer inside the item’s own tolerance', async () => {
    const item = await anItem({ responseSpec: numericSpec() });
    expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'NUMERIC', value: '9.805', unit: 'm/s^2' },
            steps: [step(1, 'g is taken as 9.805 m/s².')],
          },
        },
        as(physicsAuthor),
      ),
    );
  });

  it('refuses a numeric answer outside it', async () => {
    const item = await anItem({ responseSpec: numericSpec() });
    const refused = await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'NUMERIC', value: '9.5', unit: 'm/s^2' },
          steps: [step(1, 'g is taken as 9.5 m/s².')],
        },
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('FINAL_ANSWER_DISAGREES_WITH_KEY');
  });

  it('reports an item version the item does not hold', async () => {
    const item = await anItem();
    const refused = await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: freshUuid(),
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
          steps: [step(1, 'x')],
        },
      },
      as(physicsAuthor),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('NotFound');
    expect(error.code).toBe('VERSION_NOT_FOUND');
  });

  it('reports an item that does not exist', async () => {
    const refused = await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: freshUuid(),
        targetItemVersionId: freshUuid(),
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'x')] },
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses a solution with no steps', async () => {
    const item = await anItem();
    const refused = await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [] },
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('STEPS_REQUIRED');
  });
});

describe('UpdateSolutionDraft', () => {
  async function seedSolution() {
    const item = await anItem();
    const solution = expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [step(1, 'One step.')],
          },
        },
        as(physicsAuthor),
      ),
    );
    return { item, solution };
  }

  it('edits the draft in place and reconciles the step set', async () => {
    const deps = solutionBench();
    const { solution } = await seedSolution();

    expectValue(
      await new UpdateSolutionDraftHandler(deps).handle(
        {
          solutionId: solution.solutionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [step(1, 'Resolve the weight.'), step(2, 'Apply F = ma.')],
          },
          idempotencyKey: 'k',
        },
        as(physicsAuthor),
      ),
    );

    const loaded = expectValue(await solutions.findById(solution.solutionId));
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.versions[0]!.steps.map((s) => s.ordinal)).toEqual([1, 2]);
  });

  it('re-checks agreement against the key as it now stands', async () => {
    const { solution } = await seedSolution();
    const refused = await new UpdateSolutionDraftHandler(solutionBench()).handle(
      {
        solutionId: solution.solutionId,
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'OPTION', optionId: 'd' },
          steps: [step(1, 'Now ending at the wrong option.')],
        },
        idempotencyKey: 'k',
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('FINAL_ANSWER_DISAGREES_WITH_KEY');
  });

  it('treats a repeated idempotency key as a no-op', async () => {
    const deps = solutionBench();
    const { solution } = await seedSolution();

    const first = expectValue(
      await new UpdateSolutionDraftHandler(deps).handle(
        {
          solutionId: solution.solutionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [step(1, 'first')],
          },
          idempotencyKey: 'retry',
        },
        as(physicsAuthor),
      ),
    );
    const second = expectValue(
      await new UpdateSolutionDraftHandler(deps).handle(
        {
          solutionId: solution.solutionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [step(1, 'second')],
          },
          idempotencyKey: 'retry',
        },
        as(physicsAuthor),
      ),
    );

    expect(second.aggregateVersion).toBe(first.aggregateVersion);
    const loaded = expectValue(await solutions.findById(solution.solutionId));
    expect(loaded.versions[0]!.steps[0]!.body).toEqual(textBody('first'));
  });

  it('reports a solution that does not exist', async () => {
    const refused = await new UpdateSolutionDraftHandler(solutionBench()).handle(
      {
        solutionId: freshUuid(),
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'x')] },
        idempotencyKey: 'k',
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses invalid edited content before touching the database', async () => {
    const { solution } = await seedSolution();
    const refused = await new UpdateSolutionDraftHandler(solutionBench()).handle(
      {
        solutionId: solution.solutionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(2, 'gap')] },
        idempotencyKey: 'k',
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('STEP_ORDINALS_NOT_CONTIGUOUS');

    const loaded = expectValue(await solutions.findById(solution.solutionId));
    expect(loaded.versions[0]!.steps.map((s) => s.ordinal)).toEqual([1]);
  });

  it('refuses to edit a published version', async () => {
    const { solution } = await seedSolution();
    const published = expectValue(
      transitionSolution(
        expectValue(
          transitionSolution(
            expectValue(transitionSolution(solution, { transition: 'submit_for_review' })),
            { transition: 'approve' },
          ),
        ),
        { transition: 'publish', versionId: solution.versions[0]!.versionId },
      ),
    );
    expectValue(await solutions.save(published));

    const refused = await new UpdateSolutionDraftHandler(solutionBench()).handle(
      {
        solutionId: solution.solutionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'rewritten')] },
        idempotencyKey: 'k',
      },
      as(physicsAuthor),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_EDITABLE');
  });
});

describe('subject-scoped authoring (FR-TCH-01 rule 1)', () => {
  it('refuses a Chemistry author authoring Physics content', async () => {
    const item = await anItem();
    const refusals: readonly Refusal[] = [
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusType: 'passage', subject: 'physics', body: textBody('x') },
        as(chemistryAuthor),
      ),
      await new UpdateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusId: freshUuid(), subject: 'physics', body: textBody('x'), idempotencyKey: 'k' },
        as(chemistryAuthor),
      ),
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'x')] },
        },
        as(chemistryAuthor),
      ),
      await new UpdateSolutionDraftHandler(solutionBench()).handle(
        {
          solutionId: freshUuid(),
          subject: 'physics',
          content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'x')] },
          idempotencyKey: 'k',
        },
        as(chemistryAuthor),
      ),
    ];
    for (const refused of refusals) {
      const error = expectError(refused);
      expect(error.kind).toBe('Authorization');
      expect(error.code).toBe('OUT_OF_SUBJECT_SCOPE');
    }
  });

  it('permits Content Ops across subjects', async () => {
    const created = expectValue(
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusType: 'passage', subject: 'chemistry', body: textBody('A titration curve.') },
        as(contentOps),
      ),
    );
    expect(created.lifecycleState).toBe('draft');
  });

  it('refuses a principal holding no authoring role at all', async () => {
    const refusals: readonly Refusal[] = [
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusType: 'passage', subject: 'physics', body: textBody('x') },
        as(learner),
      ),
      await new UpdateStimulusDraftHandler(stimulusBench()).handle(
        { stimulusId: freshUuid(), subject: 'physics', body: textBody('x'), idempotencyKey: 'k' },
        as(learner),
      ),
      await new AttachStimulusToItemHandler(stimulusBench()).handle(
        { itemId: freshUuid(), stimulusId: freshUuid() },
        as(learner),
      ),
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: freshUuid(),
          targetItemVersionId: freshUuid(),
          subject: 'physics',
          content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'x')] },
        },
        as(learner),
      ),
      await new UpdateSolutionDraftHandler(solutionBench()).handle(
        {
          solutionId: freshUuid(),
          subject: 'physics',
          content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1, 'x')] },
          idempotencyKey: 'k',
        },
        as(learner),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('NOT_PERMITTED');
    }
  });

  it('refuses an unstated subject rather than defaulting to a permissive one', async () => {
    const refused = await new CreateStimulusDraftHandler(stimulusBench()).handle(
      { stimulusType: 'passage', subject: '  ', body: textBody('x') },
      as(physicsAuthor),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('Validation');
    expect(error.code).toBe('SUBJECT_REQUIRED');
  });
});

describe('a published item still reads what it was attached to', () => {
  it('keeps the pinned stimulus version through publication', async () => {
    const item = await anItem();
    const stimulus = await aStimulus();
    const attached = expectValue(
      await new AttachStimulusToItemHandler(stimulusBench()).handle(
        { itemId: item.itemId, stimulusId: stimulus.stimulusId },
        as(physicsAuthor),
      ),
    );

    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(attached, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(
      await items.save(
        expectValue(
          publishVersion(approved, {
            versionId: latestVersionOf(attached).versionId,
            preconditionsSatisfied: true,
          }),
        ),
      ),
    );

    const published = expectValue(await items.findPublishedVersion(item.itemId));
    expect(published.stimulusVersionRef).toBe(stimulus.versions[0]!.versionId);
  });
});
