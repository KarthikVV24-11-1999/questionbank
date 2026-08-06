import { describe, expect, it, beforeEach } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../../domain/concept-identity.js';
import { HandlerRegistry, MissingAuthorizationPolicyError, type Handler } from '../handler-registry.js';
import type { ApplicationError } from '../authorization.js';
import type { Result } from '../../domain/result.js';
import { InMemoryAuditRecorder, type ApplicationContext } from '../ports.js';
import {
  AddConceptNodeHandler,
  AddPrerequisiteEdgeHandler,
  CreateTaxonomyDraftHandler,
  MoveConceptNodeHandler,
  PublishTaxonomyVersionHandler,
  RemoveConceptNodeHandler,
  taxonomyHandlers,
  type TaxonomyHandlerDependencies,
} from './taxonomy-handlers.js';
import {
  FixedClock,
  InMemoryConceptIdentityRepository,
  InMemoryTaxonomyVersionRepository,
  SequentialIdentifiers,
} from '../../../../testing/in-memory-repositories.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const curator: PrincipalRef = { kind: 'human', id: 'usr_curator', roleContext: ['curriculum_curator'] };
const ops: PrincipalRef = { kind: 'human', id: 'usr_ops', roleContext: ['content_ops'] };
const learner: PrincipalRef = { kind: 'human', id: 'usr_learner', roleContext: ['learner'] };

function contextFor(principal: PrincipalRef, stepUpSatisfied = false): ApplicationContext {
  return { principal, stepUpSatisfied, correlationId: 'corr_1' };
}

let deps: TaxonomyHandlerDependencies;
let audit: InMemoryAuditRecorder;
let versions: InMemoryTaxonomyVersionRepository;
let identities: InMemoryConceptIdentityRepository;

async function seedIdentity(id: string, subjectDomain = 'physics'): Promise<ConceptIdentity> {
  const identity = expectValue(
    ConceptIdentity.create({
      conceptIdentityId: id,
      canonicalName: id,
      subjectDomain,
      createdInVersion: 'tv_seed',
    }),
  );
  expectValue(await identities.insert(identity));
  return identity;
}

/** A draft with a root and one child, and the version it is stored at. */
async function seedTree(): Promise<{ versionId: string; aggregateVersion: number; rootNodeId: string }> {
  const created = expectValue(
    await new CreateTaxonomyDraftHandler(deps).handle(
      { examFamily: 'JEE', academicYear: '2026' },
      contextFor(curator),
    ),
  );

  await seedIdentity('ci_physics');
  await seedIdentity('ci_mechanics');

  const withRoot = expectValue(
    await new AddConceptNodeHandler(deps).handle(
      {
        taxonomyVersionId: created.taxonomyVersionId,
        conceptIdentityId: 'ci_physics',
        displayName: 'Physics',
        examWeight: 1,
        estimatedTeachingHours: 300,
        expectedAggregateVersion: created.aggregateVersion,
      },
      contextFor(curator),
    ),
  );

  const rootNodeId = (versions.rows.get(created.taxonomyVersionId)?.aggregate.nodes[0]?.conceptNodeId ??
    '') as string;

  const withChild = expectValue(
    await new AddConceptNodeHandler(deps).handle(
      {
        taxonomyVersionId: created.taxonomyVersionId,
        conceptIdentityId: 'ci_mechanics',
        parentNodeId: rootNodeId,
        displayName: 'Mechanics',
        examWeight: 0.3,
        estimatedTeachingHours: 80,
        expectedAggregateVersion: withRoot.aggregateVersion,
      },
      contextFor(curator),
    ),
  );

  return { versionId: created.taxonomyVersionId, aggregateVersion: withChild.aggregateVersion, rootNodeId };
}

beforeEach(() => {
  audit = new InMemoryAuditRecorder();
  versions = new InMemoryTaxonomyVersionRepository();
  identities = new InMemoryConceptIdentityRepository();
  deps = {
    versions,
    identities,
    audit,
    clock: new FixedClock(),
    identifiers: new SequentialIdentifiers('tv'),
  };
});

describe('handler registry', () => {
  it('registers all six taxonomy handlers', () => {
    const registry = HandlerRegistry.of(taxonomyHandlers(deps));

    expect(registry.names).toEqual([
      'CreateTaxonomyDraft',
      'AddConceptNode',
      'MoveConceptNode',
      'RemoveConceptNode',
      'AddPrerequisiteEdge',
      'PublishTaxonomyVersion',
    ]);
  });

  it('fails to boot when a handler declares no policy', () => {
    const unguarded = { name: 'UnguardedCommand', handle: async () => ok() } as unknown as Handler<
      never,
      unknown
    >;

    expect(() => HandlerRegistry.of([unguarded])).toThrow(MissingAuthorizationPolicyError);
  });

  it('fails to boot when a handler declares an empty policy', () => {
    const empty = {
      name: 'EmptyPolicyCommand',
      policy: { name: 'EmptyPolicyCommand', allowedRoles: [], requiresStepUp: false },
      handle: async () => ok(),
    } as unknown as Handler<never, unknown>;

    expect(() => HandlerRegistry.of([empty])).toThrow(/declares no authorization policy/u);
  });

  it('fails to boot on a duplicate handler name', () => {
    expect(() => HandlerRegistry.of([...taxonomyHandlers(deps), ...taxonomyHandlers(deps)])).toThrow(
      /registered twice/u,
    );
  });

  it('declares step-up only on publication', () => {
    const registry = HandlerRegistry.of(taxonomyHandlers(deps));

    expect(registry.get('PublishTaxonomyVersion')?.policy.requiresStepUp).toBe(true);
    expect(registry.get('AddConceptNode')?.policy.requiresStepUp).toBe(false);
  });
});

function ok(): { ok: true; value: undefined } {
  return { ok: true, value: undefined };
}

describe('authorization negative paths', () => {
  it('denies every handler to a principal without the role', async () => {
    const context = contextFor(learner, true);
    const commands: ReadonlyArray<
      [string, () => Promise<Result<unknown, ApplicationError>>]
    > = [
      ['CreateTaxonomyDraft', () => new CreateTaxonomyDraftHandler(deps).handle({ examFamily: 'JEE', academicYear: '2026' }, context)],
      ['AddConceptNode', () => new AddConceptNodeHandler(deps).handle({ taxonomyVersionId: 'tv_1', conceptIdentityId: 'ci_1', displayName: 'X', examWeight: 1, estimatedTeachingHours: 1, expectedAggregateVersion: 1 }, context)],
      ['MoveConceptNode', () => new MoveConceptNodeHandler(deps).handle({ taxonomyVersionId: 'tv_1', conceptNodeId: 'cn_1', newParentNodeId: 'cn_2', expectedAggregateVersion: 1 }, context)],
      ['RemoveConceptNode', () => new RemoveConceptNodeHandler(deps).handle({ taxonomyVersionId: 'tv_1', conceptNodeId: 'cn_1', expectedAggregateVersion: 1 }, context)],
      ['AddPrerequisiteEdge', () => new AddPrerequisiteEdgeHandler(deps).handle({ taxonomyVersionId: 'tv_1', fromConceptIdentityId: 'ci_1', toConceptIdentityId: 'ci_2', strength: 0.5, expectedAggregateVersion: 1 }, context)],
      ['PublishTaxonomyVersion', () => new PublishTaxonomyVersionHandler(deps).handle({ taxonomyVersionId: 'tv_1', expectedAggregateVersion: 1 }, context)],
    ];

    for (const [name, run] of commands) {
      const error = expectError(await run());
      expect(error.kind, name).toBe('Authorization');
      expect(error.code, name).toBe('NOT_PERMITTED');
    }

    expect(versions.rows.size).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('denies publication to a curator who is not content ops', async () => {
    const { versionId, aggregateVersion } = await seedTree();

    const error = expectError(
      await new PublishTaxonomyVersionHandler(deps).handle(
        { taxonomyVersionId: versionId, expectedAggregateVersion: aggregateVersion },
        contextFor(curator, true),
      ),
    );

    expect(error.code).toBe('NOT_PERMITTED');
  });

  it('denies publication without step-up', async () => {
    const { versionId, aggregateVersion } = await seedTree();

    const error = expectError(
      await new PublishTaxonomyVersionHandler(deps).handle(
        { taxonomyVersionId: versionId, expectedAggregateVersion: aggregateVersion },
        contextFor(ops, false),
      ),
    );

    expect(error.code).toBe('STEP_UP_REQUIRED');
    expect(versions.rows.get(versionId)?.aggregate.state).toBe('draft');
  });

  it('checks authorization before touching the repository', async () => {
    await new AddConceptNodeHandler(deps).handle(
      {
        taxonomyVersionId: 'tv_absent',
        conceptIdentityId: 'ci_absent',
        displayName: 'X',
        examWeight: 1,
        estimatedTeachingHours: 1,
        expectedAggregateVersion: 1,
      },
      contextFor(learner),
    );

    expect(versions.rows.size).toBe(0);
  });
});

describe('taxonomy commands', () => {
  it('creates a draft and audits it', async () => {
    const created = expectValue(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: '2026' },
        contextFor(curator),
      ),
    );

    expect(versions.rows.get(created.taxonomyVersionId)?.aggregate.state).toBe('draft');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'CreateTaxonomyDraft',
      targetContext: 'curriculum',
      targetType: 'TaxonomyVersion',
      targetId: created.taxonomyVersionId,
      correlationId: 'corr_1',
    });
    expect(audit.entries[0]?.principal).toEqual(curator);
  });

  it('rejects an invalid draft without writing anything', async () => {
    const error = expectError(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: 'next year' },
        contextFor(curator),
      ),
    );

    expect(error.code).toBe('ACADEMIC_YEAR_INVALID');
    expect(versions.rows.size).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('adds a root and a child node, auditing each', async () => {
    const { versionId } = await seedTree();
    const stored = versions.rows.get(versionId);

    expect(stored?.aggregate.nodes).toHaveLength(2);
    expect(stored?.aggregate.nodes[1]?.depth).toBe(1);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      'CreateTaxonomyDraft',
      'AddConceptNode',
      'AddConceptNode',
    ]);
  });

  it('reports an unknown concept identity', async () => {
    const { versionId, aggregateVersion } = await seedTree();

    const error = expectError(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          conceptIdentityId: 'ci_unknown',
          displayName: 'X',
          examWeight: 1,
          estimatedTeachingHours: 1,
          expectedAggregateVersion: aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    expect(error.kind).toBe('NotFound');
  });

  it('reports an unknown parent node', async () => {
    const { versionId, aggregateVersion } = await seedTree();
    await seedIdentity('ci_optics');

    const error = expectError(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          conceptIdentityId: 'ci_optics',
          parentNodeId: 'cn_absent',
          displayName: 'Optics',
          examWeight: 0.2,
          estimatedTeachingHours: 20,
          expectedAggregateVersion: aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    expect(error.code).toBe('PARENT_NODE_NOT_FOUND');
  });

  it('moves a node and audits it', async () => {
    const { versionId, aggregateVersion, rootNodeId } = await seedTree();
    await seedIdentity('ci_optics');
    const withOptics = expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          conceptIdentityId: 'ci_optics',
          parentNodeId: rootNodeId,
          displayName: 'Optics',
          examWeight: 0.2,
          estimatedTeachingHours: 20,
          expectedAggregateVersion: aggregateVersion,
        },
        contextFor(curator),
      ),
    );
    const stored = versions.rows.get(versionId);
    const mechanics = stored?.aggregate.nodes[1]?.conceptNodeId as string;
    const optics = stored?.aggregate.nodes[2]?.conceptNodeId as string;

    const moved = expectValue(
      await new MoveConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          conceptNodeId: mechanics,
          newParentNodeId: optics,
          expectedAggregateVersion: withOptics.aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    expect(versions.rows.get(versionId)?.aggregate.nodeById(mechanics)?.depth).toBe(2);
    expect(moved.aggregateVersion).toBe(withOptics.aggregateVersion + 1);
    expect(audit.entries.at(-1)?.action).toBe('MoveConceptNode');
  });

  it('removes a node', async () => {
    const { versionId, aggregateVersion } = await seedTree();
    const mechanics = versions.rows.get(versionId)?.aggregate.nodes[1]?.conceptNodeId as string;

    expectValue(
      await new RemoveConceptNodeHandler(deps).handle(
        { taxonomyVersionId: versionId, conceptNodeId: mechanics, expectedAggregateVersion: aggregateVersion },
        contextFor(curator),
      ),
    );

    expect(versions.rows.get(versionId)?.aggregate.nodes).toHaveLength(1);
  });

  it('adds a prerequisite edge and rejects one that would form a cycle', async () => {
    const { versionId, aggregateVersion, rootNodeId } = await seedTree();
    void rootNodeId;

    const added = expectValue(
      await new AddPrerequisiteEdgeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          fromConceptIdentityId: 'ci_physics',
          toConceptIdentityId: 'ci_mechanics',
          strength: 0.7,
          expectedAggregateVersion: aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    const cycle = expectError(
      await new AddPrerequisiteEdgeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          fromConceptIdentityId: 'ci_mechanics',
          toConceptIdentityId: 'ci_physics',
          strength: 0.7,
          expectedAggregateVersion: added.aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    expect(cycle.code).toBe('PREREQUISITE_CYCLE');
    expect(versions.rows.get(versionId)?.aggregate.prerequisites).toHaveLength(1);
  });

  it('publishes with step-up and stamps the principal', async () => {
    const { versionId, aggregateVersion } = await seedTree();

    const published = expectValue(
      await new PublishTaxonomyVersionHandler(deps).handle(
        { taxonomyVersionId: versionId, expectedAggregateVersion: aggregateVersion },
        contextFor(ops, true),
      ),
    );

    const stored = versions.rows.get(versionId);
    expect(stored?.aggregate.state).toBe('published');
    expect(stored?.aggregate.publishedBy).toEqual(ops);
    expect(stored?.aggregate.publishedAt?.toISOString()).toBe('2026-08-05T09:00:00.000Z');
    expect(published.aggregateVersion).toBe(aggregateVersion + 1);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'PublishTaxonomyVersion', targetVersion: published.aggregateVersion });
  });

  it('reports invariant violations from a failed publication and writes nothing', async () => {
    const { versionId, aggregateVersion, rootNodeId } = await seedTree();
    await seedIdentity('ci_organic', 'chemistry');
    const withChemistry = expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: versionId,
          conceptIdentityId: 'ci_organic',
          parentNodeId: rootNodeId,
          displayName: 'Organic Chemistry',
          examWeight: 0.2,
          estimatedTeachingHours: 20,
          expectedAggregateVersion: aggregateVersion,
        },
        contextFor(curator),
      ),
    );
    const auditedBefore = audit.entries.length;

    const error = expectError(
      await new PublishTaxonomyVersionHandler(deps).handle(
        { taxonomyVersionId: versionId, expectedAggregateVersion: withChemistry.aggregateVersion },
        contextFor(ops, true),
      ),
    );

    expect(error.code).toBe('INVARIANT_VIOLATIONS');
    expect(error.detail).toBeDefined();
    expect(versions.rows.get(versionId)?.aggregate.state).toBe('draft');
    expect(audit.entries).toHaveLength(auditedBefore);
  });

  it('raises Conflict on a stale expected version and leaves the aggregate alone', async () => {
    const { versionId, aggregateVersion } = await seedTree();
    const mechanics = versions.rows.get(versionId)?.aggregate.nodes[1]?.conceptNodeId as string;

    const error = expectError(
      await new RemoveConceptNodeHandler(deps).handle(
        { taxonomyVersionId: versionId, conceptNodeId: mechanics, expectedAggregateVersion: aggregateVersion - 1 },
        contextFor(curator),
      ),
    );

    expect(error.kind).toBe('Conflict');
    expect(versions.rows.get(versionId)?.aggregate.nodes).toHaveLength(2);
  });

  it('reports an unknown taxonomy version', async () => {
    const error = expectError(
      await new RemoveConceptNodeHandler(deps).handle(
        { taxonomyVersionId: 'tv_absent', conceptNodeId: 'cn_1', expectedAggregateVersion: 1 },
        contextFor(curator),
      ),
    );

    expect(error.kind).toBe('NotFound');
  });
});
