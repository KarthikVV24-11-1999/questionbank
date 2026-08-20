import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import { err, ok, type Result } from '../domain/result.js';
import type {
  ItemRepository,
  SubmittedForReviewPage,
  RepositoryError,
  SolutionRepository,
  StimulusRepository,
} from '../domain/repository-ports.js';
import { createItem, type Item } from '../domain/item.js';
import { createItemVersion, type ItemVersion } from '../domain/item-version.js';
import {
  createStimulus,
  createStimulusVersion,
  reconstituteStimulus,
  type Stimulus,
  type StimulusVersion,
} from '../domain/stimulus.js';
import {
  createSolution,
  createSolutionVersion,
  type Solution,
  type SolutionStep,
  type SolutionVersion,
} from '../domain/solution.js';
import type { ApplicationContext, IdentifierFactory } from './ports.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore, type Clock } from './ports.js';
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

/**
 * The failure paths behind FR-TCH-03 and FR-TCH-04 — a rejected write, a
 * malformed stored aggregate, a draft reached by the wrong author. None of
 * these is on the happy path, and each one is where a handler that reported
 * success anyway would lose an author's work or pin an item to nothing.
 */

const AUTHOR_ID = '00000000-0000-4000-8400-000000000001';
const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author', 'subject:physics'] };
const otherAuthor: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-8400-000000000002',
  roleContext: ['author', 'subject:physics'],
};
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };

let seed = 0;
const identifiers: IdentifierFactory = {
  next: () => {
    seed += 1;
    return `00000000-0000-4000-8500-${seed.toString(16).padStart(12, '0')}`;
  },
};

const rejected: RepositoryError = { kind: 'Conflict', code: 'CONFLICT', message: 'moved on' };
const missing: RepositoryError = { kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' };

function stimulusVersion(overrides: Partial<Parameters<typeof createStimulusVersion>[0]> = {}): StimulusVersion {
  return expectValue(
    createStimulusVersion({
      versionId: identifiers.next(),
      versionNo: 1,
      body: textBody('A 2 kg block rests on a 30° incline.'),
      licensing: { status: 'owned' },
      authoredBy: author,
      createdAt: NOW.toISOString(),
      ...overrides,
    }),
  );
}

function draftStimulus(version = stimulusVersion()): Stimulus {
  return expectValue(
    createStimulus({ stimulusId: identifiers.next(), stimulusType: 'passage', initialVersion: version }),
  );
}

function itemVersion(): ItemVersion {
  return expectValue(
    createItemVersion(
      {
        versionId: identifiers.next(),
        versionNo: 1,
        itemType: 'SINGLE_CORRECT_MCQ',
        stem: textBody('A block slides down a frictionless ramp.'),
        responseSpec: singleCorrectSpec(),
        taxonomyTags: [
          {
            conceptIdentityId: '00000000-0000-4000-8600-000000000001',
            taxonomyVersionId: '00000000-0000-4000-8600-000000000002',
            weight: 1,
            isPrimary: true,
          },
        ],
        difficultyEstimate: 'moderate',
        provenance: originalProvenance(),
        licensing: { status: 'owned' },
        authoredBy: author,
        createdAt: NOW.toISOString(),
      },
      { latestPlausibleYear: 2026 },
    ),
  );
}

function draftItem(version = itemVersion()): Item {
  return expectValue(
    createItem({ itemId: identifiers.next(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: version }),
  );
}

const step = (ordinal: number): SolutionStep => ({
  ordinal,
  body: textBody(`step ${ordinal}`),
  conceptRefs: [],
});

function solutionVersion(): SolutionVersion {
  return expectValue(
    createSolutionVersion({
      versionId: identifiers.next(),
      versionNo: 1,
      finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
      steps: [step(1)],
      authoredBy: author,
      createdAt: NOW.toISOString(),
    }),
  );
}

function draftSolution(item: Item): Solution {
  return expectValue(
    createSolution({
      solutionId: identifiers.next(),
      itemId: item.itemId,
      targetItemVersionId: item.versions[0]!.versionId,
      initialVersion: solutionVersion(),
    }),
  );
}

class StubItems implements ItemRepository {
  constructor(
    private readonly onFind: () => Result<Item, RepositoryError>,
    private readonly onSave: (item: Item) => Result<Item, RepositoryError> = ok,
  ) {}
  async save(item: Item) {
    return this.onSave(item);
  }
  async findById() {
    return this.onFind();
  }
  async deleteDraft(): Promise<Result<true, RepositoryError>> {
    return ok(true);
  }
  async findDraftsByAuthor(): Promise<Result<readonly Item[], RepositoryError>> {
    return ok([]);
  }
  async findPublishedVersion(): Promise<Result<ItemVersion, RepositoryError>> {
    return err(missing);
  }
  async countPublishedItemsUsingStimulusVersion(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
  async findSubmittedForReview(): Promise<Result<SubmittedForReviewPage, RepositoryError>> {
    return ok({ items: [] });
  }
}

class StubStimuli implements StimulusRepository {
  constructor(
    private readonly onFind: () => Result<Stimulus, RepositoryError>,
    private readonly onSave: (stimulus: Stimulus) => Result<Stimulus, RepositoryError> = ok,
  ) {}
  async save(stimulus: Stimulus) {
    return this.onSave(stimulus);
  }
  async findById() {
    return this.onFind();
  }
  async findPublishedVersion(): Promise<Result<StimulusVersion, RepositoryError>> {
    return err(missing);
  }
}

class StubSolutions implements SolutionRepository {
  constructor(
    private readonly onFind: () => Result<Solution, RepositoryError>,
    private readonly onSave: (solution: Solution) => Result<Solution, RepositoryError> = ok,
  ) {}
  async save(solution: Solution) {
    return this.onSave(solution);
  }
  async findById() {
    return this.onFind();
  }
  async findPublishedForItemVersion(): Promise<Result<SolutionVersion, RepositoryError>> {
    return err(missing);
  }
}

function stimulusDeps(
  over: Partial<StimulusAuthoringDependencies> = {},
): StimulusAuthoringDependencies {
  return {
    stimuli: new StubStimuli(() => err(missing)),
    items: new StubItems(() => err(missing)),
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
    ...over,
  };
}

function solutionDeps(
  over: Partial<SolutionAuthoringDependencies> = {},
): SolutionAuthoringDependencies {
  return {
    solutions: new StubSolutions(() => err(missing)),
    items: new StubItems(() => err(missing)),
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
    ...over,
  };
}

describe('stimulus authoring fails closed', () => {
  it('refuses a version the domain will not build', async () => {
    const deps = stimulusDeps({ identifiers: { next: () => '   ' } });
    const refused = await new CreateStimulusDraftHandler(deps).handle(
      { stimulusType: 'passage', subject: 'physics', body: textBody('x') },
      as(author),
    );
    expect(expectError(refused).code).toBe('VERSION_ID_REQUIRED');
  });

  it('refuses a stimulus the domain will not build', async () => {
    let call = 0;
    const deps = stimulusDeps({
      identifiers: { next: () => (call++ === 0 ? identifiers.next() : '   ') },
    });
    const refused = await new CreateStimulusDraftHandler(deps).handle(
      { stimulusType: 'passage', subject: 'physics', body: textBody('x') },
      as(author),
    );
    expect(expectError(refused).code).toBe('STIMULUS_ID_REQUIRED');
  });

  it('reports a create the repository refused, and writes no audit record', async () => {
    const audit = new InMemoryAuditRecorder();
    const deps = stimulusDeps({
      stimuli: new StubStimuli(() => err(missing), () => err(rejected)),
      audit,
    });
    const refused = await new CreateStimulusDraftHandler(deps).handle(
      { stimulusType: 'passage', subject: 'physics', body: textBody('x') },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
    expect(audit.entries).toHaveLength(0);
  });

  it('carries an edited licence through an update', async () => {
    const stimulus = draftStimulus();
    const saves: Stimulus[] = [];
    const deps = stimulusDeps({
      stimuli: new StubStimuli(
        () => ok(stimulus),
        (saved) => {
          saves.push(saved);
          return ok(saved);
        },
      ),
    });

    expectValue(
      await new UpdateStimulusDraftHandler(deps).handle(
        {
          stimulusId: stimulus.stimulusId,
          subject: 'physics',
          body: textBody('x'),
          licensing: { status: 'licensed', licenseRef: 'CC-BY-4.0', attribution: 'NCERT' },
          idempotencyKey: 'k',
        },
        as(author),
      ),
    );
    expect(saves[0]!.versions[0]!.licensing).toMatchObject({ status: 'licensed', licenseRef: 'CC-BY-4.0' });
  });

  it('refuses an edited licence the domain will not accept', async () => {
    const stimulus = draftStimulus();
    const deps = stimulusDeps({ stimuli: new StubStimuli(() => ok(stimulus)) });
    const refused = await new UpdateStimulusDraftHandler(deps).handle(
      {
        stimulusId: stimulus.stimulusId,
        subject: 'physics',
        body: textBody('x'),
        licensing: { status: 'licensed' },
        idempotencyKey: 'k',
      },
      as(author),
    );
    expect(expectError(refused).kind).toBe('Validation');
  });

  it('reports an update the repository refused and leaves the key unremembered', async () => {
    const stimulus = draftStimulus();
    const idempotency = new InMemoryIdempotencyStore();
    const deps = stimulusDeps({
      stimuli: new StubStimuli(() => ok(stimulus), () => err(rejected)),
      idempotency,
    });
    const refused = await new UpdateStimulusDraftHandler(deps).handle(
      { stimulusId: stimulus.stimulusId, subject: 'physics', body: textBody('x'), idempotencyKey: 'k' },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
    expect(await idempotency.seen('k')).toBe(false);
  });
});

describe('attachment fails closed', () => {
  it('refuses another author reaching the item', async () => {
    const item = draftItem();
    const deps = stimulusDeps({
      items: new StubItems(() => ok(item)),
      stimuli: new StubStimuli(() => ok(draftStimulus())),
    });
    const refused = await new AttachStimulusToItemHandler(deps).handle(
      { itemId: item.itemId, stimulusId: 'anything' },
      as(otherAuthor),
    );
    expect(expectError(refused).code).toBe('NOT_THE_DRAFT_OWNER');
  });

  // A stored stimulus whose version names nothing is corruption, and pinning
  // an item to it would produce an association pointing at no passage at all.
  it('refuses to pin an item to a stored version that names nothing', async () => {
    const item = draftItem();
    const corrupt = expectValue(
      reconstituteStimulus({
        stimulusId: identifiers.next(),
        stimulusType: 'passage',
        lifecycleState: 'draft',
        versions: [{ ...stimulusVersion(), versionId: '   ' }],
        aggregateVersion: 1,
      }),
    );
    const deps = stimulusDeps({
      items: new StubItems(() => ok(item)),
      stimuli: new StubStimuli(() => ok(corrupt)),
    });
    const refused = await new AttachStimulusToItemHandler(deps).handle(
      { itemId: item.itemId, stimulusId: corrupt.stimulusId },
      as(author),
    );
    expect(expectError(refused).code).toBe('STIMULUS_VERSION_REF_BLANK');
  });

  it('reports an attachment the repository refused', async () => {
    const item = draftItem();
    const deps = stimulusDeps({
      items: new StubItems(() => ok(item), () => err(rejected)),
      stimuli: new StubStimuli(() => ok(draftStimulus())),
    });
    const refused = await new AttachStimulusToItemHandler(deps).handle(
      { itemId: item.itemId, stimulusId: 'anything' },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});

describe('solution authoring fails closed', () => {
  it('refuses a solution the domain will not build', async () => {
    const item = draftItem();
    let call = 0;
    const deps = solutionDeps({
      items: new StubItems(() => ok(item)),
      identifiers: { next: () => (call++ === 0 ? identifiers.next() : '   ') },
    });
    const refused = await new CreateSolutionDraftHandler(deps).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1)] },
      },
      as(author),
    );
    expect(expectError(refused).code).toBe('SOLUTION_ID_REQUIRED');
  });

  it('reports a create the repository refused, and writes no audit record', async () => {
    const item = draftItem();
    const audit = new InMemoryAuditRecorder();
    const deps = solutionDeps({
      items: new StubItems(() => ok(item)),
      solutions: new StubSolutions(() => err(missing), () => err(rejected)),
      audit,
    });
    const refused = await new CreateSolutionDraftHandler(deps).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1)] },
      },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
    expect(audit.entries).toHaveLength(0);
  });

  it('refuses another author reaching the solution draft', async () => {
    const item = draftItem();
    const solution = draftSolution(item);
    const deps = solutionDeps({
      items: new StubItems(() => ok(item)),
      solutions: new StubSolutions(() => ok(solution)),
    });
    const refused = await new UpdateSolutionDraftHandler(deps).handle(
      {
        solutionId: solution.solutionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1)] },
        idempotencyKey: 'k',
      },
      as(otherAuthor),
    );
    expect(expectError(refused).code).toBe('NOT_THE_DRAFT_OWNER');
  });

  it('refuses an update when the item it explains has gone', async () => {
    const item = draftItem();
    const solution = draftSolution(item);
    const deps = solutionDeps({
      items: new StubItems(() => err(missing)),
      solutions: new StubSolutions(() => ok(solution)),
    });
    const refused = await new UpdateSolutionDraftHandler(deps).handle(
      {
        solutionId: solution.solutionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1)] },
        idempotencyKey: 'k',
      },
      as(author),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('reports an update the repository refused and leaves the key unremembered', async () => {
    const item = draftItem();
    const solution = draftSolution(item);
    const idempotency = new InMemoryIdempotencyStore();
    const deps = solutionDeps({
      items: new StubItems(() => ok(item)),
      solutions: new StubSolutions(() => ok(solution), () => err(rejected)),
      idempotency,
    });
    const refused = await new UpdateSolutionDraftHandler(deps).handle(
      {
        solutionId: solution.solutionId,
        subject: 'physics',
        content: { finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' }, steps: [step(1)] },
        idempotencyKey: 'k',
      },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
    expect(await idempotency.seen('k')).toBe(false);
  });
});
