import { describe, expect, it } from 'vitest';
import { ConceptIdentity } from '../domain/concept-identity.js';
import { toConceptIdentity, toConceptIdentityRow } from './concept-identity.repository.js';
import { toConceptNode, toPrerequisiteEdge, toTaxonomyVersionRow } from './taxonomy-version.repository.js';
import { TaxonomyVersion } from '../domain/taxonomy-version.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const IDENTITY_ROW = {
  conceptIdentityId: '019fd4bc-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-0000-0000-000000000000',
  canonicalName: 'Rotational Motion',
  subjectDomain: 'physics',
  createdInVersion: '019fd4bc-0000-7000-8000-0000000000ff',
  supersededBy: null,
  aggregateVersion: 1,
  createdAt: new Date('2026-08-05T00:00:00.000Z'),
};

const NODE_ROW = {
  conceptNodeId: '019fd4bc-0000-7000-8000-000000000010',
  taxonomyVersionId: '019fd4bc-0000-7000-8000-0000000000ff',
  conceptIdentityId: IDENTITY_ROW.conceptIdentityId,
  parentNodeId: '019fd4bc-0000-7000-8000-000000000009',
  displayName: 'Mechanics',
  examWeight: '0.25000',
  depth: 2,
  estimatedTeachingHours: '12.50',
};

const EDGE_ROW = {
  taxonomyVersionId: NODE_ROW.taxonomyVersionId,
  fromConceptIdentityId: '019fd4bc-0000-7000-8000-000000000001',
  toConceptIdentityId: '019fd4bc-0000-7000-8000-000000000002',
  strength: '0.800',
};

describe('concept identity mapping', () => {
  it('maps snake_case columns onto the domain object', () => {
    const identity = expectValue(toConceptIdentity(IDENTITY_ROW));

    expect(identity.conceptIdentityId).toBe(IDENTITY_ROW.conceptIdentityId);
    expect(identity.canonicalName).toBe('Rotational Motion');
    expect(identity.subjectDomain).toBe('physics');
    expect(identity.createdInVersion).toBe(IDENTITY_ROW.createdInVersion);
    expect(identity.supersededBy).toBeUndefined();
  });

  it('maps a null supersededBy to undefined and back to null', () => {
    const identity = expectValue(toConceptIdentity(IDENTITY_ROW));

    expect(toConceptIdentityRow(identity).supersededBy).toBeNull();
  });

  it('round-trips supersession through the row shape', () => {
    const superseded = expectValue(
      toConceptIdentity({ ...IDENTITY_ROW, supersededBy: '019fd4bc-0000-7000-8000-000000000002' }),
    );

    expect(superseded.supersededBy).toBe('019fd4bc-0000-7000-8000-000000000002');
    expect(toConceptIdentityRow(superseded).supersededBy).toBe('019fd4bc-0000-7000-8000-000000000002');
  });

  it('reports a row that cannot form a valid aggregate as corrupt', () => {
    const error = expectError(toConceptIdentity({ ...IDENTITY_ROW, canonicalName: '   ' }));

    expect(error.code).toBe('CORRUPT_ROW');
    expect(error.message).toContain(IDENTITY_ROW.conceptIdentityId);
  });

  it('writes exactly the columns the table declares', () => {
    const row = toConceptIdentityRow(expectValue(toConceptIdentity(IDENTITY_ROW)));

    expect(Object.keys(row).sort()).toEqual([
      'canonicalName',
      'conceptIdentityId',
      'createdInVersion',
      'subjectDomain',
      'supersededBy',
    ]);
  });
});

describe('concept node mapping', () => {
  it('converts numeric columns from their string representation', () => {
    const node = expectValue(toConceptNode(NODE_ROW));

    expect(node.examWeight).toBe(0.25);
    expect(node.estimatedTeachingHours).toBe(12.5);
    expect(node.depth).toBe(2);
    expect(node.parentNodeId).toBe(NODE_ROW.parentNodeId);
  });

  it('maps a null parent to a root node', () => {
    const node = expectValue(toConceptNode({ ...NODE_ROW, parentNodeId: null, depth: 0 }));

    expect(node.isRoot).toBe(true);
    expect(node.parentNodeId).toBeUndefined();
  });

  it('reports an out-of-range stored weight as corrupt', () => {
    const error = expectError(toConceptNode({ ...NODE_ROW, examWeight: '9.00000' }));

    expect(error.code).toBe('CORRUPT_ROW');
    expect(error.message).toContain(NODE_ROW.conceptNodeId);
  });
});

describe('prerequisite edge mapping', () => {
  it('converts the strength column', () => {
    expect(expectValue(toPrerequisiteEdge(EDGE_ROW)).strength).toBe(0.8);
  });

  it('reports a self-referencing stored edge as corrupt', () => {
    const error = expectError(
      toPrerequisiteEdge({ ...EDGE_ROW, toConceptIdentityId: EDGE_ROW.fromConceptIdentityId }),
    );

    expect(error.code).toBe('CORRUPT_ROW');
  });
});

describe('taxonomy version mapping', () => {
  it('writes camelCase domain fields into snake_case columns', () => {
    const version = expectValue(
      TaxonomyVersion.createDraft({
        taxonomyVersionId: '019fd4bc-0000-7000-8000-0000000000ff',
        examFamily: 'JEE',
        academicYear: '2026-27',
      }),
    );

    const row = toTaxonomyVersionRow(version);

    expect(row).toEqual({
      taxonomyVersionId: '019fd4bc-0000-7000-8000-0000000000ff',
      examFamily: 'JEE',
      academicYear: '2026-27',
      state: 'draft',
      publishedAt: null,
      publishedByKind: null,
      publishedById: null,
    });
  });

  it('writes the publishing principal when the version is published', () => {
    const published = expectValue(
      expectValue(
        TaxonomyVersion.createDraft({
          taxonomyVersionId: '019fd4bc-0000-7000-8000-0000000000ff',
          examFamily: 'JEE',
          academicYear: '2026',
        }),
      ).publish(
        { kind: 'system', id: '019fd4bc-0000-7000-8000-00000000000a', roleContext: [] },
        new Date('2026-08-05T10:00:00.000Z'),
      ),
    );

    const row = toTaxonomyVersionRow(published);

    expect(row.state).toBe('published');
    expect(row.publishedByKind).toBe('system');
    expect(row.publishedById).toBe('019fd4bc-0000-7000-8000-00000000000a');
    expect((row.publishedAt as Date).toISOString()).toBe('2026-08-05T10:00:00.000Z');
  });
});

describe('reconstitution guards', () => {
  it('rejects a stored node whose depth is negative', () => {
    expect(expectError(toConceptNode({ ...NODE_ROW, depth: -1 })).code).toBe('CORRUPT_ROW');
  });

  it('rejects a stored identity that supersedes itself', () => {
    const error = expectError(
      toConceptIdentity({ ...IDENTITY_ROW, supersededBy: IDENTITY_ROW.conceptIdentityId }),
    );

    expect(error.code).toBe('CORRUPT_ROW');
  });

  it('accepts a well-formed identity through the domain factory', () => {
    expect(
      expectValue(
        ConceptIdentity.reconstitute({
          conceptIdentityId: IDENTITY_ROW.conceptIdentityId,
          canonicalName: IDENTITY_ROW.canonicalName,
          subjectDomain: IDENTITY_ROW.subjectDomain,
          createdInVersion: IDENTITY_ROW.createdInVersion,
        }),
      ).isSuperseded,
    ).toBe(false);
  });
});
