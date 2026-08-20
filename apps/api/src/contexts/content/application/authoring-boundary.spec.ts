import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import { err, ok, type Result } from '../domain/result.js';
import type { ItemRepository, RepositoryError, SubmittedForReviewPage } from '../domain/repository-ports.js';
import { createItem, type Item } from '../domain/item.js';
import { createItemVersion, type ItemVersion } from '../domain/item-version.js';
import {
  applicationError,
  authorize,
  authorizeDraftAccess,
  DRAFT_OVERSIGHT_ROLES,
  policy,
} from './authorization.js';
import {
  DuplicateHandlerError,
  HandlerRegistry,
  MissingAuthorizationPolicyError,
  type Handler,
} from './handler-registry.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
} from './ports.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';
import {
  CreateItemDraftHandler,
  DeleteItemDraftHandler,
  DeriveDraftFromVersionHandler,
  UpdateItemDraftHandler,
  type ItemAuthoringDependencies,
} from './handlers/authoring-handlers.js';

/**
 * The authorization surface and the failure paths a happy-path integration
 * test never reaches — a rejected write, a broken identifier adapter, a
 * policy-less handler. §5 makes 100% on authorization negative paths a
 * requirement rather than a target, and a handler that reports success after a
 * failed save is the defect that loses an author's work silently.
 */

const AUTHOR_ID = '00000000-0000-4000-8100-000000000001';
// Subject-scoped (M4-14) so CreateItemDraft calls below that never declare a
// subject still resolve one, from the single scope held.
const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author', 'subject:physics'] };
const contentOps: PrincipalRef = { kind: 'human', id: 'ops-1', roleContext: ['content_ops'] };
const admin: PrincipalRef = { kind: 'human', id: 'admin-1', roleContext: ['admin'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };

let seed = 0;
const identifiers: IdentifierFactory = {
  next: () => {
    seed += 1;
    return `00000000-0000-4000-8200-${seed.toString(16).padStart(12, '0')}`;
  },
};

const CONTENT: AuthoredItemContent = {
  stem: textBody('A block slides down a frictionless ramp.'),
  responseSpec: singleCorrectSpec(),
  taxonomyTags: [
    {
      conceptIdentityId: '00000000-0000-4000-8300-000000000001',
      taxonomyVersionId: '00000000-0000-4000-8300-000000000002',
      weight: 1,
      isPrimary: true,
    },
  ],
  difficultyEstimate: 'moderate',
  provenance: originalProvenance(),
  licensing: { status: 'owned' },
};

function draftVersion(): ItemVersion {
  return expectValue(
    createItemVersion(
      {
        ...CONTENT,
        versionId: identifiers.next(),
        versionNo: 1,
        itemType: 'SINGLE_CORRECT_MCQ',
        authoredBy: author,
        createdAt: NOW.toISOString(),
      },
      { latestPlausibleYear: 2026 },
    ),
  );
}

function draftItem(): Item {
  return expectValue(
    createItem({
      itemId: identifiers.next(),
      itemType: 'SINGLE_CORRECT_MCQ',
      initialVersion: draftVersion(),
      authoringSubject: 'physics',
    }),
  );
}

const rejected: RepositoryError = {
  kind: 'Conflict',
  code: 'CONFLICT',
  message: 'the item moved on',
};

class StubItems implements ItemRepository {
  constructor(
    private readonly onFind: () => Result<Item, RepositoryError>,
    private readonly onSave: (item: Item) => Result<Item, RepositoryError> = ok,
    private readonly onDelete: () => Result<true, RepositoryError> = () => ok(true),
  ) {}
  async save(item: Item) {
    return this.onSave(item);
  }
  async findById() {
    return this.onFind();
  }
  async deleteDraft() {
    return this.onDelete();
  }
  async findDraftsByAuthor(): Promise<Result<readonly Item[], RepositoryError>> {
    return ok([]);
  }
  async findPublishedVersion(): Promise<Result<ItemVersion, RepositoryError>> {
    return err(rejected);
  }
  async countPublishedItemsUsingStimulusVersion(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
  async findSubmittedForReview(): Promise<Result<SubmittedForReviewPage, RepositoryError>> {
    return ok({ items: [] });
  }
}

function deps(items: ItemRepository, over: Partial<ItemAuthoringDependencies> = {}): ItemAuthoringDependencies {
  return {
    items,
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
    ...over,
  };
}

describe('authorization denies by default', () => {
  it('refuses a principal holding no listed role', () => {
    expect(
      expectError(authorize(policy('P', ['author']), { principal: { ...author, roleContext: ['learner'] } })).code,
    ).toBe('NOT_PERMITTED');
  });

  it('refuses a step-up policy when step-up is absent or false', () => {
    const stepUp = policy('P', ['content_ops'], true);
    expect(expectError(authorize(stepUp, { principal: contentOps })).code).toBe('STEP_UP_REQUIRED');
    expect(expectError(authorize(stepUp, { principal: contentOps, stepUpSatisfied: false })).code).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('permits a principal holding the role with step-up satisfied', () => {
    expect(expectValue(authorize(policy('P', ['content_ops'], true), { principal: contentOps, stepUpSatisfied: true }))).toBe(
      true,
    );
  });

  it('omits the location when an error names nowhere in particular', () => {
    expect(applicationError('Conflict', 'C', 'm')).not.toHaveProperty('location');
    expect(applicationError('Conflict', 'C', 'm', 'here').location).toBe('here');
  });
});

describe('draft ownership (FR-TCH-06 rule 1)', () => {
  it('permits the author of the draft', () => {
    expect(expectValue(authorizeDraftAccess(AUTHOR_ID, as(author)))).toBe(true);
  });

  it('permits Content Ops', () => {
    expect(expectValue(authorizeDraftAccess(AUTHOR_ID, as(contentOps)))).toBe(true);
  });

  it('refuses another author, naming the refusal rather than returning nothing', () => {
    const error = expectError(authorizeDraftAccess(AUTHOR_ID, as({ ...author, id: 'someone-else' })));
    expect(error.kind).toBe('Authorization');
    expect(error.code).toBe('NOT_THE_DRAFT_OWNER');
    expect(error.location).toBe('itemId');
  });

  it('refuses a platform administrator — administration is not content oversight', () => {
    expect(expectError(authorizeDraftAccess(AUTHOR_ID, as(admin))).code).toBe('NOT_THE_DRAFT_OWNER');
    expect(DRAFT_OVERSIGHT_ROLES).toEqual(['content_ops']);
  });
});

describe('the registry is the F36 gate', () => {
  const stub = (name: string) => ({
    name,
    policy: policy(name, ['author']),
    async handle() {
      return ok(undefined);
    },
  });

  it('refuses a handler declaring no policy at all', () => {
    const policyless = { name: 'Policyless', async handle() { return ok(undefined); } };
    expect(() => HandlerRegistry.of([policyless as unknown as Handler<never, unknown>])).toThrow(
      MissingAuthorizationPolicyError,
    );
  });

  it('refuses a handler with an empty role list', () => {
    const roleless = { ...stub('Roleless'), policy: policy('Roleless', []) };
    expect(() => HandlerRegistry.of([roleless as unknown as Handler<never, unknown>])).toThrow(
      MissingAuthorizationPolicyError,
    );
  });

  it('refuses the same handler twice', () => {
    const handlers = [stub('Twice'), stub('Twice')] as unknown as Handler<never, unknown>[];
    expect(() => HandlerRegistry.of(handlers)).toThrow(DuplicateHandlerError);
  });

  it('registers every authoring handler and returns them by name', () => {
    const bench = deps(new StubItems(() => err(rejected)));
    const registry = HandlerRegistry.of([
      new CreateItemDraftHandler(bench),
      new UpdateItemDraftHandler(bench),
      new DeriveDraftFromVersionHandler(bench),
      new DeleteItemDraftHandler(bench),
    ] as unknown as Handler<never, unknown>[]);

    expect(registry.names).toEqual([
      'CreateItemDraft',
      'UpdateItemDraft',
      'DeriveDraftFromVersion',
      'DeleteItemDraft',
    ]);
    expect(registry.get('UpdateItemDraft')).toBeDefined();
    expect(registry.get('Nothing')).toBeUndefined();
  });
});

describe('the handlers fail closed on a rejected write', () => {
  it('reports a create the repository refused, and writes no audit record', async () => {
    const bench = deps(new StubItems(() => err(rejected), () => err(rejected)));
    const failed = await new CreateItemDraftHandler(bench).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: CONTENT },
      as(author),
    );
    expect(expectError(failed).code).toBe('CONFLICT');
    expect((bench.audit as InMemoryAuditRecorder).entries).toHaveLength(0);
  });

  it('reports an update the repository refused and leaves the key unremembered', async () => {
    const item = draftItem();
    const idempotency = new InMemoryIdempotencyStore();
    const bench = deps(new StubItems(() => ok(item), () => err(rejected)), { idempotency });

    const failed = await new UpdateItemDraftHandler(bench).handle(
      { itemId: item.itemId, content: CONTENT, idempotencyKey: 'k' },
      as(author),
    );
    expect(expectError(failed).code).toBe('CONFLICT');
    // A save that failed stays retryable, or a dropped connection loses the work.
    expect(await idempotency.seen('k')).toBe(false);
  });

  it('reports a derived version the repository refused', async () => {
    const item = draftItem();
    const bench = deps(new StubItems(() => ok(item), () => err(rejected)));
    const failed = await new DeriveDraftFromVersionHandler(bench).handle(
      { itemId: item.itemId, fromVersionId: item.versions[0]!.versionId },
      as(author),
    );
    expect(expectError(failed).code).toBe('CONFLICT');
  });

  it('reports a deletion the repository refused, and writes no audit record', async () => {
    const item = draftItem();
    const bench = deps(new StubItems(() => ok(item), ok, () => err(rejected)));
    const failed = await new DeleteItemDraftHandler(bench).handle(
      { itemId: item.itemId, justification: 'x' },
      as(author),
    );
    expect(expectError(failed).code).toBe('CONFLICT');
    expect((bench.audit as InMemoryAuditRecorder).entries).toHaveLength(0);
  });

  it('refuses to assemble an item when the identifier adapter yields nothing usable', async () => {
    const bench = deps(new StubItems(() => err(rejected)), { identifiers: { next: () => '   ' } });
    const failed = await new CreateItemDraftHandler(bench).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: CONTENT },
      as(author),
    );
    expect(expectError(failed).code).toBe('VERSION_ID_REQUIRED');
  });

  it('refuses to assemble an item when only the item identifier is unusable', async () => {
    let call = 0;
    const bench = deps(new StubItems(() => err(rejected)), {
      identifiers: { next: () => (call++ === 0 ? identifiers.next() : '   ') },
    });
    const failed = await new CreateItemDraftHandler(bench).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: CONTENT },
      as(author),
    );
    expect(expectError(failed).code).toBe('ITEM_ID_REQUIRED');
  });

  it('refuses a derived version the domain will not build', async () => {
    const item = draftItem();
    const bench = deps(new StubItems(() => ok(item)), { identifiers: { next: () => '   ' } });
    const failed = await new DeriveDraftFromVersionHandler(bench).handle(
      { itemId: item.itemId, fromVersionId: item.versions[0]!.versionId },
      as(author),
    );
    expect(expectError(failed).code).toBe('VERSION_ID_REQUIRED');
  });
});

describe('the audit recorder', () => {
  it('scopes entries to their target', async () => {
    const recorder = new InMemoryAuditRecorder();
    await recorder.record({
      principal: author,
      action: 'CreateItemDraft',
      targetContext: 'content',
      targetType: 'Item',
      targetId: 'a',
      correlationId: 'c',
      occurredAt: NOW,
    });
    expect(recorder.entriesFor('a')).toHaveLength(1);
    expect(recorder.entriesFor('b')).toHaveLength(0);
  });
});
