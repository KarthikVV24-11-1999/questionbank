import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import { err, ok, type Result } from '../domain/result.js';
import type {
  ItemRepository,
  MediaAssetRepository,
  RepositoryError,
  ReviewDecisionRepository,
  SolutionRepository,
  StimulusRepository,
} from '../domain/repository-ports.js';
import { createItem, reconstituteItem, type Item } from '../domain/item.js';
import { createItemVersion, type ItemVersion } from '../domain/item-version.js';
import type { LifecycleState } from '../domain/item-lifecycle.js';
import {
  createReviewDecision,
  type ReviewDecision,
  type ReviewedOwnerType,
} from '../domain/review-decision.js';
import {
  createSolution,
  createSolutionVersion,
  reconstituteSolution,
  type Solution,
  type SolutionVersion,
} from '../domain/solution.js';
import {
  createStimulus,
  createStimulusVersion,
  reconstituteStimulus,
  type Stimulus,
  type StimulusVersion,
} from '../domain/stimulus.js';
import {
  PublishItemVersionHandler,
  PublishSolutionVersionHandler,
  PublishStimulusVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  RecordStimulusReviewDecisionHandler,
  RetireItemHandler,
  PublishMediaAssetVersionHandler,
  RecordMediaAssetReviewDecisionHandler,
  RetireStimulusHandler,
  SubmitItemForReviewHandler,
  SubmitMediaAssetForReviewHandler,
  SubmitSolutionForReviewHandler,
  SubmitStimulusForReviewHandler,
  SuspendItemHandler,
  WithdrawItemFromReviewHandler,
  type LifecycleDependencies,
} from './handlers/lifecycle-handlers.js';
import {
  createMediaAssetVersion,
  reconstituteMediaAsset,
  type MediaAsset,
  type MediaAssetVersion,
} from '../domain/media-asset.js';
import {
  InMemoryAuditRecorder,
  InMemoryReviewProgress,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
  type MediaStore,
  type RenderValidator,
} from './ports.js';

/**
 * The failure paths a happy-path run never reaches: a write the database
 * refuses, a reference count it will not produce, an aggregate that moved
 * between the read and the transition. A lifecycle handler that reported
 * success on any of them would leave the aggregate and the record disagreeing
 * about what is published — which is the one disagreement INV-07 exists to
 * prevent.
 */

const AUTHOR_ID = '00000000-0000-4000-8a00-000000000001';
const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author', 'subject:physics'] };
const reviewer: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-8a00-000000000002',
  roleContext: ['reviewer'],
};
const contentOps: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-8a00-000000000003',
  roleContext: ['content_ops'],
};

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });
const asOps = (): ApplicationContext => ({ principal: contentOps, correlationId: 'c', stepUpSatisfied: true });

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };

let seed = 0;
const identifiers: IdentifierFactory = {
  next: () => {
    seed += 1;
    return `00000000-0000-4000-8b00-${seed.toString(16).padStart(12, '0')}`;
  },
};

const rejected: RepositoryError = { kind: 'Conflict', code: 'CONFLICT', message: 'moved on' };
const missing: RepositoryError = { kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' };

// ── fixtures ────────────────────────────────────────────────────────────────

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
            conceptIdentityId: '00000000-0000-4000-8c00-000000000001',
            taxonomyVersionId: '00000000-0000-4000-8c00-000000000002',
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

function itemIn(state: LifecycleState, version = itemVersion()): Item {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteItem({
      itemId: identifiers.next(),
      itemType: 'SINGLE_CORRECT_MCQ',
      lifecycleState: state,
      versions: [version],
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: version.versionId } : {}),
    }),
  );
}

function stimulusVersion(): StimulusVersion {
  return expectValue(
    createStimulusVersion({
      versionId: identifiers.next(),
      versionNo: 1,
      body: textBody('A 2 kg block rests on a 30° incline.'),
      licensing: { status: 'owned' },
      authoredBy: author,
      createdAt: NOW.toISOString(),
    }),
  );
}

function stimulusIn(state: LifecycleState, version = stimulusVersion()): Stimulus {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteStimulus({
      stimulusId: identifiers.next(),
      stimulusType: 'passage',
      lifecycleState: state,
      versions: [version],
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: version.versionId } : {}),
    }),
  );
}

function solutionVersion(optionId = 'b'): SolutionVersion {
  return expectValue(
    createSolutionVersion({
      versionId: identifiers.next(),
      versionNo: 1,
      finalAnswerAssertion: { kind: 'OPTION', optionId },
      steps: [{ ordinal: 1, body: textBody('one step'), conceptRefs: [] }],
      authoredBy: author,
      createdAt: NOW.toISOString(),
    }),
  );
}

function solutionIn(
  state: LifecycleState,
  item: Item,
  version = solutionVersion(),
): Solution {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteSolution({
      solutionId: identifiers.next(),
      itemId: item.itemId,
      targetItemVersionId: item.versions[0]!.versionId,
      lifecycleState: state,
      versions: [version],
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: version.versionId } : {}),
    }),
  );
}

function approval(ownerType: ReviewedOwnerType, ownerVersionId: string): ReviewDecision {
  return expectValue(
    createReviewDecision({
      decisionId: identifiers.next(),
      ownerType,
      ownerVersionId,
      reviewer,
      outcome: 'approve',
      decidedAt: NOW.toISOString(),
    }),
  );
}

// ── stubs ───────────────────────────────────────────────────────────────────

class StubItems implements ItemRepository {
  constructor(
    private readonly onFind: () => Result<Item, RepositoryError>,
    private readonly onSave: (item: Item) => Result<Item, RepositoryError> = ok,
    private readonly onCount: () => Result<number, RepositoryError> = () => ok(0),
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
  async countPublishedItemsUsingStimulusVersion() {
    return this.onCount();
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
    private readonly onFindPublished: () => Result<SolutionVersion, RepositoryError> = () => err(missing),
  ) {}
  async save(solution: Solution) {
    return this.onSave(solution);
  }
  async findById() {
    return this.onFind();
  }
  async findPublishedForItemVersion() {
    return this.onFindPublished();
  }
}

class StubReviews implements ReviewDecisionRepository {
  constructor(
    private readonly onRecord: (decision: ReviewDecision) => Result<ReviewDecision, RepositoryError> = ok,
    private readonly onApproval: () => Result<ReviewDecision, RepositoryError> = () => err(missing),
  ) {}
  async record(decision: ReviewDecision) {
    return this.onRecord(decision);
  }
  async findApprovalFor() {
    return this.onApproval();
  }
  async findAllFor(): Promise<Result<readonly ReviewDecision[], RepositoryError>> {
    return ok([]);
  }
}

class StubAssets implements MediaAssetRepository {
  constructor(
    private readonly onFind: () => Result<MediaAsset, RepositoryError>,
    private readonly onSave: (asset: MediaAsset) => Result<MediaAsset, RepositoryError> = ok,
  ) {}
  async save(asset: MediaAsset) {
    return this.onSave(asset);
  }
  async findById() {
    return this.onFind();
  }
  async findPublishedVersion(): Promise<Result<MediaAssetVersion, RepositoryError>> {
    return err(missing);
  }
  async list(): Promise<Result<readonly MediaAsset[], RepositoryError>> {
    return ok([]);
  }
  async countReferencingPublishedContent(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
}

const emptyStore: MediaStore = {
  async put() {
    throw new Error('the upload edge is not exercised here');
  },
  async head() {
    return undefined;
  },
};

const passingRenderer: RenderValidator = {
  async validate(version: ItemVersion) {
    return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] };
  },
};

function deps(over: Partial<LifecycleDependencies> = {}): LifecycleDependencies {
  return {
    items: new StubItems(() => err(missing)),
    assets: new StubAssets(() => err(missing)),
    store: emptyStore,
    stimuli: new StubStimuli(() => err(missing)),
    solutions: new StubSolutions(() => err(missing)),
    reviews: new StubReviews(),
    renderer: passingRenderer,
    reviewProgress: new InMemoryReviewProgress(),
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    ...over,
  };
}

const refusingSave = <T>() => (): Result<T, RepositoryError> => err(rejected);

describe('a rejected write is reported, never reported as success', () => {
  it('on submitting an item', async () => {
    const bench = deps({ items: new StubItems(() => ok(itemIn('draft')), refusingSave<Item>()) });
    expect(
      expectError(await new SubmitItemForReviewHandler(bench).handle({ itemId: 'x' }, as(author))).code,
    ).toBe('CONFLICT');
  });

  it('on withdrawing an item', async () => {
    const bench = deps({ items: new StubItems(() => ok(itemIn('in_review')), refusingSave<Item>()) });
    expect(
      expectError(await new WithdrawItemFromReviewHandler(bench).handle({ itemId: 'x' }, as(author))).code,
    ).toBe('CONFLICT');
  });

  it('on recording an item review decision', async () => {
    const item = itemIn('in_review');
    const bench = deps({ items: new StubItems(() => ok(item), refusingSave<Item>()) });
    const refused = await new RecordItemReviewDecisionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('on publishing an item version', async () => {
    const item = itemIn('approved');
    const versionId = item.versions[0]!.versionId;
    const bench = deps({
      items: new StubItems(() => ok(item), refusingSave<Item>()),
      reviews: new StubReviews(ok, () => ok(approval('item_version', versionId))),
      solutions: new StubSolutions(() => err(missing), ok, () => ok(solutionVersion())),
    });
    const refused = await new PublishItemVersionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('on suspending and retiring an item', async () => {
    const bench = deps({ items: new StubItems(() => ok(itemIn('published')), refusingSave<Item>()) });
    expect(
      expectError(
        await new SuspendItemHandler(bench).handle({ itemId: 'x', justification: 'j' }, asOps()),
      ).code,
    ).toBe('CONFLICT');
    expect(
      expectError(
        await new RetireItemHandler(bench).handle({ itemId: 'x', retirementReason: 'r' }, asOps()),
      ).code,
    ).toBe('CONFLICT');
  });

  it('on every stimulus transition', async () => {
    const stimulus = stimulusIn('in_review');
    const versionId = stimulus.versions[0]!.versionId;
    const bench = deps({
      stimuli: new StubStimuli(() => ok(stimulus), refusingSave<Stimulus>()),
      reviews: new StubReviews(ok, () => ok(approval('stimulus_version', versionId))),
    });
    expect(
      expectError(
        await new SubmitStimulusForReviewHandler(
          deps({ stimuli: new StubStimuli(() => ok(stimulusIn('draft')), refusingSave<Stimulus>()) }),
        ).handle({ stimulusId: 'x' }, as(author)),
      ).code,
    ).toBe('CONFLICT');
    expect(
      expectError(
        await new RecordStimulusReviewDecisionHandler(bench).handle(
          { stimulusId: stimulus.stimulusId, stimulusVersionId: versionId, outcome: 'approve' },
          as(reviewer),
        ),
      ).code,
    ).toBe('CONFLICT');

    const approved = stimulusIn('approved');
    const approvedVersionId = approved.versions[0]!.versionId;
    expect(
      expectError(
        await new PublishStimulusVersionHandler(
          deps({
            stimuli: new StubStimuli(() => ok(approved), refusingSave<Stimulus>()),
            reviews: new StubReviews(ok, () => ok(approval('stimulus_version', approvedVersionId))),
          }),
        ).handle({ stimulusId: approved.stimulusId, stimulusVersionId: approvedVersionId }, asOps()),
      ).code,
    ).toBe('CONFLICT');
    expect(
      expectError(
        await new RetireStimulusHandler(
          deps({ stimuli: new StubStimuli(() => ok(stimulusIn('published')), refusingSave<Stimulus>()) }),
        ).handle({ stimulusId: 'x', retirementReason: 'r' }, asOps()),
      ).code,
    ).toBe('CONFLICT');
  });

  it('on every solution transition', async () => {
    const item = itemIn('draft');
    const solution = solutionIn('in_review', item);
    const versionId = solution.versions[0]!.versionId;

    expect(
      expectError(
        await new SubmitSolutionForReviewHandler(
          deps({ solutions: new StubSolutions(() => ok(solutionIn('draft', item)), refusingSave<Solution>()) }),
        ).handle({ solutionId: 'x' }, as(author)),
      ).code,
    ).toBe('CONFLICT');

    expect(
      expectError(
        await new RecordSolutionReviewDecisionHandler(
          deps({ solutions: new StubSolutions(() => ok(solution), refusingSave<Solution>()) }),
        ).handle({ solutionId: solution.solutionId, solutionVersionId: versionId, outcome: 'approve' }, as(reviewer)),
      ).code,
    ).toBe('CONFLICT');

    const approved = solutionIn('approved', item);
    const approvedVersionId = approved.versions[0]!.versionId;
    expect(
      expectError(
        await new PublishSolutionVersionHandler(
          deps({
            solutions: new StubSolutions(() => ok(approved), refusingSave<Solution>()),
            items: new StubItems(() => ok(item)),
            reviews: new StubReviews(ok, () => ok(approval('solution_version', approvedVersionId))),
          }),
        ).handle({ solutionId: approved.solutionId, solutionVersionId: approvedVersionId }, asOps()),
      ).code,
    ).toBe('CONFLICT');
  });
});

describe('a decision the record will not accept stops the transition', () => {
  it('refuses rather than moving the item without its signature', async () => {
    const item = itemIn('in_review');
    const bench = deps({
      items: new StubItems(() => ok(item)),
      reviews: new StubReviews(() => err(rejected)),
    });
    const refused = await new RecordItemReviewDecisionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
    expect(item.lifecycleState).toBe('in_review');
  });

  it('refuses a decision the domain will not build', async () => {
    const item = itemIn('in_review');
    const bench = deps({ items: new StubItems(() => ok(item)), identifiers: { next: () => '  ' } });
    const refused = await new RecordItemReviewDecisionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('DECISION_ID_REQUIRED');
  });

  it('drives the rejection transition when the outcome is a rejection', async () => {
    const item = itemIn('in_review');
    const bench = deps({ items: new StubItems(() => ok(item)) });
    const moved = expectValue(
      await new RecordItemReviewDecisionHandler(bench).handle(
        {
          itemId: item.itemId,
          itemVersionId: item.versions[0]!.versionId,
          outcome: 'reject',
          justification: 'the key is wrong',
        },
        as(reviewer),
      ),
    );
    expect(moved.lifecycleState).toBe('rejected');
  });

  it('reports an item version the item does not hold', async () => {
    const item = itemIn('in_review');
    const bench = deps({ items: new StubItems(() => ok(item)) });
    const refused = await new RecordItemReviewDecisionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: 'not-a-version', outcome: 'approve' },
      as(reviewer),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('NotFound');
    expect(error.code).toBe('VERSION_NOT_FOUND');
  });
});

describe('publication refuses a state the machine will not leave', () => {
  // Every precondition satisfied and the item still not approved: the
  // aggregate refuses, because a satisfied verdict is not a licence to skip
  // the state machine.
  it('refuses to publish a draft even with every fact in place', async () => {
    const item = itemIn('draft');
    const versionId = item.versions[0]!.versionId;
    const bench = deps({
      items: new StubItems(() => ok(item)),
      reviews: new StubReviews(ok, () => ok(approval('item_version', versionId))),
      solutions: new StubSolutions(() => err(missing), ok, () => ok(solutionVersion())),
    });
    const refused = await new PublishItemVersionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('stimulus retirement resolves its reference count', () => {
  it('counts nothing when the stimulus never published', async () => {
    const bench = deps({ stimuli: new StubStimuli(() => ok(stimulusIn('draft'))) });
    // The count is zero and the transition is still refused — a draft is
    // discarded, not retired (FR-QM-01 rule 5).
    const refused = await new RetireStimulusHandler(bench).handle(
      { stimulusId: 'x', retirementReason: 'r' },
      asOps(),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });

  it('refuses when the count cannot be resolved at all', async () => {
    const bench = deps({
      stimuli: new StubStimuli(() => ok(stimulusIn('published'))),
      items: new StubItems(() => err(missing), ok, () => err(rejected)),
    });
    const refused = await new RetireStimulusHandler(bench).handle(
      { stimulusId: 'x', retirementReason: 'r' },
      asOps(),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});

describe('publishing a solution re-reads the item it explains', () => {
  it('refuses when the item is gone', async () => {
    const item = itemIn('draft');
    const solution = solutionIn('approved', item);
    const versionId = solution.versions[0]!.versionId;
    const bench = deps({
      solutions: new StubSolutions(() => ok(solution)),
      items: new StubItems(() => err(missing)),
      reviews: new StubReviews(ok, () => ok(approval('solution_version', versionId))),
    });
    const refused = await new PublishSolutionVersionHandler(bench).handle(
      { solutionId: solution.solutionId, solutionVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses when the targeted item version is gone', async () => {
    const item = itemIn('draft');
    const solution = solutionIn('approved', item);
    const versionId = solution.versions[0]!.versionId;
    const otherItem = expectValue(
      createItem({
        itemId: item.itemId,
        itemType: 'SINGLE_CORRECT_MCQ',
        initialVersion: itemVersion(),
      }),
    );
    const bench = deps({
      solutions: new StubSolutions(() => ok(solution)),
      items: new StubItems(() => ok(otherItem)),
      reviews: new StubReviews(ok, () => ok(approval('solution_version', versionId))),
    });
    const refused = await new PublishSolutionVersionHandler(bench).handle(
      { solutionId: solution.solutionId, solutionVersionId: versionId },
      asOps(),
    );
    const error = expectError(refused);
    expect(error.code).toBe('VERSION_NOT_FOUND');
    expect(error.location).toBe('targetItemVersionId');
  });
});

describe('stimulus publication refuses a version the machine will not publish', () => {
  it('refuses a draft stimulus even with an approval on record', async () => {
    const stimulus = stimulusIn('draft');
    const versionId = stimulus.versions[0]!.versionId;
    const bench = deps({
      stimuli: new StubStimuli(() => ok(stimulus)),
      reviews: new StubReviews(ok, () => ok(approval('stimulus_version', versionId))),
    });
    const refused = await new PublishStimulusVersionHandler(bench).handle(
      { stimulusId: stimulus.stimulusId, stimulusVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('solution review decisions', () => {
  it('reports a rejection transition and a refused stimulus transition alike', async () => {
    const item = itemIn('draft');
    const solution = solutionIn('in_review', item);
    const bench = deps({ solutions: new StubSolutions(() => ok(solution)) });
    const moved = expectValue(
      await new RecordSolutionReviewDecisionHandler(bench).handle(
        {
          solutionId: solution.solutionId,
          solutionVersionId: solution.versions[0]!.versionId,
          outcome: 'request_changes',
          justification: 'step 2 skips a substitution',
        },
        as(reviewer),
      ),
    );
    expect(moved.lifecycleState).toBe('changes_requested');

    const stimulus = stimulusIn('draft');
    const refused = await new RecordStimulusReviewDecisionHandler(
      deps({ stimuli: new StubStimuli(() => ok(stimulus)) }),
    ).handle(
      {
        stimulusId: stimulus.stimulusId,
        stimulusVersionId: stimulus.versions[0]!.versionId,
        outcome: 'approve',
      },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('an illegal transition is refused wherever it is attempted', () => {
  it('refuses submitting something that is not in an editable state', async () => {
    const item = deps({ items: new StubItems(() => ok(itemIn('published'))) });
    expect(
      expectError(await new SubmitItemForReviewHandler(item).handle({ itemId: 'x' }, as(author))).code,
    ).toBe('TRANSITION_ILLEGAL');

    const stimulus = deps({ stimuli: new StubStimuli(() => ok(stimulusIn('in_review'))) });
    expect(
      expectError(
        await new SubmitStimulusForReviewHandler(stimulus).handle({ stimulusId: 'x' }, as(author)),
      ).code,
    ).toBe('TRANSITION_ILLEGAL');

    const solution = deps({
      solutions: new StubSolutions(() => ok(solutionIn('in_review', itemIn('draft')))),
    });
    expect(
      expectError(
        await new SubmitSolutionForReviewHandler(solution).handle({ solutionId: 'x' }, as(author)),
      ).code,
    ).toBe('TRANSITION_ILLEGAL');
  });

  it('refuses a decision on an item that is not under review', async () => {
    const item = itemIn('draft');
    const bench = deps({ items: new StubItems(() => ok(item)) });
    const refused = await new RecordItemReviewDecisionHandler(bench).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });

  it('refuses a decision on a solution that is not under review', async () => {
    const solution = solutionIn('draft', itemIn('draft'));
    const bench = deps({ solutions: new StubSolutions(() => ok(solution)) });
    const refused = await new RecordSolutionReviewDecisionHandler(bench).handle(
      {
        solutionId: solution.solutionId,
        solutionVersionId: solution.versions[0]!.versionId,
        outcome: 'approve',
      },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });

  it('refuses publishing a solution version the machine will not publish', async () => {
    const item = itemIn('draft');
    const solution = solutionIn('published', item);
    const versionId = solution.versions[0]!.versionId;
    const bench = deps({
      solutions: new StubSolutions(() => ok(solution)),
      items: new StubItems(() => ok(item)),
      reviews: new StubReviews(ok, () => ok(approval('solution_version', versionId))),
    });
    const refused = await new PublishSolutionVersionHandler(bench).handle(
      { solutionId: solution.solutionId, solutionVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('a decision the record will not accept stops a stimulus or solution too', () => {
  it('refuses the stimulus decision', async () => {
    const stimulus = stimulusIn('in_review');
    const bench = deps({
      stimuli: new StubStimuli(() => ok(stimulus)),
      reviews: new StubReviews(() => err(rejected)),
    });
    const refused = await new RecordStimulusReviewDecisionHandler(bench).handle(
      {
        stimulusId: stimulus.stimulusId,
        stimulusVersionId: stimulus.versions[0]!.versionId,
        outcome: 'approve',
      },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('refuses the solution decision', async () => {
    const solution = solutionIn('in_review', itemIn('draft'));
    const bench = deps({
      solutions: new StubSolutions(() => ok(solution)),
      reviews: new StubReviews(() => err(rejected)),
    });
    const refused = await new RecordSolutionReviewDecisionHandler(bench).handle(
      {
        solutionId: solution.solutionId,
        solutionVersionId: solution.versions[0]!.versionId,
        outcome: 'approve',
      },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});

describe('retirement carries what it is asked to carry', () => {
  it('records the item that replaces a retired one', async () => {
    const item = itemIn('published');
    const replacement = itemIn('draft');
    const bench = deps({ items: new StubItems(() => ok(item)) });
    const retired = expectValue(
      await new RetireItemHandler(bench).handle(
        {
          itemId: item.itemId,
          retirementReason: 'superseded by a clearer wording',
          replacedByItemId: replacement.itemId,
        },
        asOps(),
      ),
    );
    expect(retired.replacedByItemId).toBe(replacement.itemId);
  });

  it('retires a stimulus nothing published references', async () => {
    const stimulus = stimulusIn('published');
    const bench = deps({
      stimuli: new StubStimuli(() => ok(stimulus)),
      items: new StubItems(() => err(missing), ok, () => ok(0)),
    });
    const retired = expectValue(
      await new RetireStimulusHandler(bench).handle(
        { stimulusId: stimulus.stimulusId, retirementReason: 'the passage is out of syllabus' },
        asOps(),
      ),
    );
    expect(retired.lifecycleState).toBe('retired');
    expect(retired.retirementReason).toBe('the passage is out of syllabus');
  });
});

describe('the media asset transitions fail closed too', () => {
  function mediaAsset(state: LifecycleState): MediaAsset {
    const version = expectValue(
      createMediaAssetVersion(
        {
          versionId: identifiers.next(),
          versionNo: 1,
          storageKey: 'content/media/ramp.png',
          checksum: 'sha256:abcd',
          mimeType: 'image/png',
          width: 800,
          height: 600,
          altText: 'A block on a ramp inclined at thirty degrees',
          longDescription: 'The ramp rises left to right at 30°.',
          licensing: { status: 'owned' },
          authoredBy: author,
          createdAt: NOW.toISOString(),
        },
        'diagram',
      ),
    );
    const needsPublished = state === 'published' || state === 'suspended';
    return expectValue(
      reconstituteMediaAsset({
        assetId: identifiers.next(),
        assetType: 'diagram',
        lifecycleState: state,
        versions: [version],
        aggregateVersion: 1,
        ...(needsPublished ? { currentPublishedVersionId: version.versionId } : {}),
      }),
    );
  }

  const matchingStore: MediaStore = {
    async put() {
      throw new Error('the upload edge is not exercised here');
    },
    async head() {
      return {
        storageKey: 'content/media/ramp.png',
        checksum: 'sha256:abcd',
        contentType: 'image/png',
        byteLength: 4,
      };
    },
  };

  it('reports a submission the repository refused', async () => {
    const bench = deps({ assets: new StubAssets(() => ok(mediaAsset('draft')), refusingSave<MediaAsset>()) });
    expect(
      expectError(
        await new SubmitMediaAssetForReviewHandler(bench).handle({ assetId: 'x' }, as(author)),
      ).code,
    ).toBe('CONFLICT');
  });

  it('refuses a submission the machine will not make', async () => {
    const bench = deps({ assets: new StubAssets(() => ok(mediaAsset('published'))) });
    expect(
      expectError(
        await new SubmitMediaAssetForReviewHandler(bench).handle({ assetId: 'x' }, as(author)),
      ).code,
    ).toBe('TRANSITION_ILLEGAL');
  });

  it('reports a decision the record will not accept, and one the repository refuses', async () => {
    const asset = mediaAsset('in_review');
    const versionId = asset.versions[0]!.versionId;

    expect(
      expectError(
        await new RecordMediaAssetReviewDecisionHandler(
          deps({ assets: new StubAssets(() => ok(asset)), reviews: new StubReviews(() => err(rejected)) }),
        ).handle({ assetId: asset.assetId, assetVersionId: versionId, outcome: 'approve' }, as(reviewer)),
      ).code,
    ).toBe('CONFLICT');

    expect(
      expectError(
        await new RecordMediaAssetReviewDecisionHandler(
          deps({ assets: new StubAssets(() => ok(asset), refusingSave<MediaAsset>()) }),
        ).handle({ assetId: asset.assetId, assetVersionId: versionId, outcome: 'approve' }, as(reviewer)),
      ).code,
    ).toBe('CONFLICT');
  });

  it('refuses a decision on an asset that is not under review', async () => {
    const asset = mediaAsset('draft');
    const bench = deps({ assets: new StubAssets(() => ok(asset)) });
    expect(
      expectError(
        await new RecordMediaAssetReviewDecisionHandler(bench).handle(
          { assetId: asset.assetId, assetVersionId: asset.versions[0]!.versionId, outcome: 'approve' },
          as(reviewer),
        ),
      ).code,
    ).toBe('TRANSITION_ILLEGAL');
  });

  it('refuses publication of a version the asset does not hold', async () => {
    const asset = mediaAsset('approved');
    const bench = deps({ assets: new StubAssets(() => ok(asset)) });
    expect(
      expectError(
        await new PublishMediaAssetVersionHandler(bench).handle(
          { assetId: asset.assetId, assetVersionId: 'not-a-version' },
          asOps(),
        ),
      ).code,
    ).toBe('VERSION_NOT_FOUND');
  });

  it('refuses publication from a state the machine will not leave', async () => {
    const asset = mediaAsset('draft');
    const versionId = asset.versions[0]!.versionId;
    const bench = deps({
      assets: new StubAssets(() => ok(asset)),
      reviews: new StubReviews(ok, () => ok(approval('media_asset_version', versionId))),
      store: matchingStore,
    });
    expect(
      expectError(
        await new PublishMediaAssetVersionHandler(bench).handle(
          { assetId: asset.assetId, assetVersionId: versionId },
          asOps(),
        ),
      ).code,
    ).toBe('TRANSITION_ILLEGAL');
  });

  it('reports a publication the repository refused', async () => {
    const asset = mediaAsset('approved');
    const versionId = asset.versions[0]!.versionId;
    const bench = deps({
      assets: new StubAssets(() => ok(asset), refusingSave<MediaAsset>()),
      reviews: new StubReviews(ok, () => ok(approval('media_asset_version', versionId))),
      store: matchingStore,
    });
    expect(
      expectError(
        await new PublishMediaAssetVersionHandler(bench).handle(
          { assetId: asset.assetId, assetVersionId: versionId },
          asOps(),
        ),
      ).code,
    ).toBe('CONFLICT');
  });
});
