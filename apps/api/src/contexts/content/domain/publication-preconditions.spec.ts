import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  AI_AGENT,
  AUTHOR,
  aiProvenance,
  itemVersionProps,
  PROVENANCE_CONTEXT,
  REVIEWER,
} from '../../../testing/content-fixtures.js';
import { createItemVersion, type ItemVersion } from './item-version.js';
import { createItem, publishVersion, reconstituteItem, type Item } from './item.js';
import {
  arePublicationPreconditionsSatisfied,
  checkNoMachinePublishesItsOwnContent,
  checkPublishable,
  PRECONDITION_CODES,
  type PublicationFacts,
  type ReviewerSignature,
} from './publication-preconditions.js';

const NOW = '2026-08-12T09:00:00Z';

function version(overrides: Parameters<typeof itemVersionProps>[0] = {}): ItemVersion {
  return expectValue(createItemVersion(itemVersionProps(overrides), PROVENANCE_CONTEXT));
}

const V1 = version();

function item(current: ItemVersion = V1): Item {
  return expectValue(createItem({ itemId: 'item-1', itemType: 'SINGLE_CORRECT_MCQ', initialVersion: current }));
}

function signature(overrides: Partial<ReviewerSignature> = {}): ReviewerSignature {
  return {
    reviewer: REVIEWER,
    itemVersionId: V1.versionId,
    decision: 'approve',
    signedAt: '2026-08-11T09:00:00Z',
    ...overrides,
  };
}

function facts(overrides: Partial<PublicationFacts> = {}): PublicationFacts {
  return {
    signature: signature(),
    solution: {
      solutionVersionId: 'solution-version-1',
      targetItemVersionId: V1.versionId,
      agreesWithKey: true,
    },
    renderVerdict: {
      itemVersionId: V1.versionId,
      surfacesChecked: ['web', 'mobile', 'offline', 'print'],
      failures: [],
    },
    answerSpecificationAccepted: true,
    asOf: NOW,
    ...overrides,
  };
}

function codesFor(overrides: Partial<PublicationFacts>, current: ItemVersion = V1): readonly string[] {
  return expectError(checkPublishable(item(current), current, facts(overrides))).unmet.map(
    (failure) => failure.code,
  );
}

describe('a complete item publishes', () => {
  it('passes with every precondition satisfied', () => {
    expect(expectValue(checkPublishable(item(), V1, facts()))).toBe(true);
  });

  it('reports satisfied through the boolean the aggregate takes', () => {
    expect(arePublicationPreconditionsSatisfied(item(), V1, facts())).toBe(true);
  });
});

describe('INV-07 — tags, provenance, licensing, answer specification', () => {
  it('refuses an item with no concept tag', () => {
    const untagged = { ...V1, taxonomyTags: [] } as ItemVersion;
    expect(codesFor({}, untagged)).toContain('TAGS_MISSING');
  });

  it('refuses a tag set with no primary', () => {
    const noPrimary = {
      ...V1,
      taxonomyTags: [{ ...V1.taxonomyTags[0]!, isPrimary: false }],
    } as ItemVersion;
    expect(codesFor({}, noPrimary)).toContain('PRIMARY_TAG_MISSING');
  });

  // A version with no provenance can only exist if something assembled it
  // around the constructor. It must fail — and it must fail by returning,
  // never by throwing (§8), on the one path that decides what reaches a
  // student. Reading sourceType off it unguarded threw on the first run.
  it('refuses a version assembled around the provenance constructor', () => {
    const noProvenance = { ...V1, provenance: undefined } as unknown as ItemVersion;
    expect(codesFor({}, noProvenance)).toContain('PROVENANCE_MISSING');
  });

  it('returns rather than throwing when provenance is absent', () => {
    const noProvenance = { ...V1, provenance: undefined } as unknown as ItemVersion;
    expect(() => checkPublishable(item(noProvenance), noProvenance, facts())).not.toThrow();
    expect(() => checkNoMachinePublishesItsOwnContent(noProvenance, signature())).not.toThrow();
    expect(expectValue(checkNoMachinePublishesItsOwnContent(noProvenance, signature()))).toBe(true);
  });

  it('refuses unresolved licensing, unconditionally (FR-QM-05 rule 4)', () => {
    const unresolved = version({ licensing: { status: 'unresolved' } });
    expect(codesFor({}, unresolved)).toContain('LICENSING_NOT_RESOLVED');
  });

  it('refuses a licence that has expired, naming the expiry', () => {
    const expired = version({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme',
        expiresAt: '2026-01-01T00:00:00Z',
      },
    });
    const failure = expectError(checkPublishable(item(expired), expired, facts()));
    const licensing = failure.unmet.find((entry) => entry.code === 'LICENSING_NOT_RESOLVED');
    expect(licensing?.message).toContain('2026-01-01T00:00:00Z');
  });

  it('permits a licence that has not yet expired', () => {
    const licensed = version({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme',
        expiresAt: '2027-01-01T00:00:00Z',
      },
    });
    expect(expectValue(checkPublishable(item(licensed), licensed, facts()))).toBe(true);
  });

  it('refuses a key the scoring executor does not accept', () => {
    expect(codesFor({ answerSpecificationAccepted: false })).toContain('ANSWER_SPECIFICATION_INVALID');
  });
});

describe('INV-07 and INV-12 — the reviewer signature', () => {
  it('refuses an unsigned version', () => {
    const withoutSignature: Partial<PublicationFacts> = {};
    const built = facts();
    delete (built as { signature?: unknown }).signature;
    expect(
      expectError(checkPublishable(item(), V1, { ...built, ...withoutSignature })).unmet.map((f) => f.code),
    ).toContain('REVIEWER_SIGNATURE_MISSING');
  });

  // A signature on version 1 says nothing about version 2, which is the whole
  // reason versions are reviewed rather than items.
  it('refuses a signature naming a different version', () => {
    expect(codesFor({ signature: signature({ itemVersionId: 'version-9' }) })).toContain(
      'REVIEWER_SIGNATURE_MISSING',
    );
  });

  it('accepts an approve-with-edits signature', () => {
    expect(expectValue(checkPublishable(item(), V1, facts({ signature: signature({ decision: 'approve_with_edits' }) })))).toBe(
      true,
    );
  });

  // INV-12, checked here as well as at assignment — a precondition that
  // depends on another milestone's diligence is not a precondition.
  it('refuses a version reviewed by its own author', () => {
    expect(codesFor({ signature: signature({ reviewer: AUTHOR }) })).toContain('REVIEWER_IS_AUTHOR');
  });

  it('permits a different human reviewer', () => {
    expect(expectValue(checkPublishable(item(), V1, facts({ signature: signature({ reviewer: REVIEWER }) })))).toBe(
      true,
    );
  });
});

describe('INV-01 — no code path from a model to a published item', () => {
  const AI_VERSION = version({ authoredBy: AI_AGENT, provenance: aiProvenance() });

  function aiFacts(overrides: Partial<PublicationFacts> = {}): PublicationFacts {
    return facts({
      signature: signature({ itemVersionId: AI_VERSION.versionId, reviewer: REVIEWER }),
      solution: {
        solutionVersionId: 'solution-version-1',
        targetItemVersionId: AI_VERSION.versionId,
        agreesWithKey: true,
      },
      renderVerdict: {
        itemVersionId: AI_VERSION.versionId,
        surfacesChecked: ['web', 'mobile', 'offline', 'print'],
        failures: [],
      },
      ...overrides,
    });
  }

  it('publishes AI-sourced content that a human signed', () => {
    expect(expectValue(checkPublishable(item(AI_VERSION), AI_VERSION, aiFacts()))).toBe(true);
  });

  it.each([['ai_agent'], ['system']] as const)(
    'refuses AI-sourced content signed by a %s',
    (kind) => {
      const machineSigned = aiFacts({
        signature: signature({
          itemVersionId: AI_VERSION.versionId,
          reviewer: { kind, id: 'agent-1', roleContext: ['reviewer'] },
        }),
      });
      const codes = expectError(checkPublishable(item(AI_VERSION), AI_VERSION, machineSigned)).unmet.map(
        (failure) => failure.code,
      );
      expect(codes).toContain('AI_CONTENT_NOT_HUMAN_REVIEWED');
    },
  );

  it('refuses ai_assisted content signed by a machine, not only ai_generated', () => {
    const assisted = version({
      authoredBy: AI_AGENT,
      provenance: aiProvenance({ sourceType: 'ai_assisted' }),
    });
    const machineSigned = facts({
      signature: signature({ itemVersionId: assisted.versionId, reviewer: AI_AGENT }),
    });
    expect(
      expectError(checkPublishable(item(assisted), assisted, machineSigned)).unmet.map((f) => f.code),
    ).toContain('AI_CONTENT_NOT_HUMAN_REVIEWED');
  });

  it('permits a machine signature on human-authored content, which is not what INV-01 forbids', () => {
    const machineSigned = facts({
      signature: signature({ reviewer: { kind: 'system', id: 'importer', roleContext: ['reviewer'] } }),
    });
    expect(expectValue(checkPublishable(item(), V1, machineSigned))).toBe(true);
  });

  describe('asserted directly, not inferred from a list', () => {
    it('permits human-authored content with no signature at all', () => {
      expect(expectValue(checkNoMachinePublishesItsOwnContent(V1, undefined))).toBe(true);
    });

    it('permits AI content with a human signature', () => {
      expect(expectValue(checkNoMachinePublishesItsOwnContent(AI_VERSION, signature()))).toBe(true);
    });

    it('refuses AI content with no signature', () => {
      expect(expectError(checkNoMachinePublishesItsOwnContent(AI_VERSION, undefined)).code).toBe(
        'AI_CONTENT_NOT_HUMAN_REVIEWED',
      );
    });

    it('refuses AI content signed by a machine', () => {
      const failure = expectError(
        checkNoMachinePublishesItsOwnContent(AI_VERSION, signature({ reviewer: AI_AGENT })),
      );
      expect(failure.code).toBe('AI_CONTENT_NOT_HUMAN_REVIEWED');
      expect(failure.kind).toBe('RuleViolation');
    });
  });
});

describe('D5 / INV-08 — a solution', () => {
  it('refuses an item with no solution', () => {
    const built = facts();
    delete (built as { solution?: unknown }).solution;
    expect(expectError(checkPublishable(item(), V1, built)).unmet.map((f) => f.code)).toContain(
      'SOLUTION_MISSING',
    );
  });

  // A solution targets a version, so a solution for version 1 does not license
  // publishing version 2.
  it('refuses a solution targeting a different version', () => {
    expect(
      codesFor({
        solution: {
          solutionVersionId: 'solution-version-1',
          targetItemVersionId: 'version-9',
          agreesWithKey: true,
        },
      }),
    ).toContain('SOLUTION_MISSING');
  });

  it('refuses a solution whose final answer disagrees with the key', () => {
    expect(
      codesFor({
        solution: {
          solutionVersionId: 'solution-version-1',
          targetItemVersionId: V1.versionId,
          agreesWithKey: false,
        },
      }),
    ).toContain('SOLUTION_DISAGREES_WITH_KEY');
  });
});

describe('INV-14 / FR-QM-14 — renders on every supported surface', () => {
  it('refuses an item with no render verdict', () => {
    const built = facts();
    delete (built as { renderVerdict?: unknown }).renderVerdict;
    expect(expectError(checkPublishable(item(), V1, built)).unmet.map((f) => f.code)).toContain(
      'RENDER_VERDICT_MISSING',
    );
  });

  it('refuses a verdict for a different version', () => {
    expect(
      codesFor({
        renderVerdict: { itemVersionId: 'version-9', surfacesChecked: ['web'], failures: [] },
      }),
    ).toContain('RENDER_VERDICT_MISSING');
  });

  it('refuses a version that fails on any surface, naming the failure', () => {
    const failure = expectError(
      checkPublishable(
        item(),
        V1,
        facts({
          renderVerdict: {
            itemVersionId: V1.versionId,
            surfacesChecked: ['web', 'mobile', 'offline', 'print'],
            failures: ['print: blocks[0] overflows the page width'],
          },
        }),
      ),
    );
    const render = failure.unmet.find((entry) => entry.code === 'RENDER_FAILED');
    expect(render?.message).toContain('print: blocks[0] overflows');
  });
});

describe('every unmet precondition is reported at once', () => {
  // An author who fixes one thing, resubmits, and is told about the next
  // wastes the session — and stops submitting (UX §10.1).
  it('reports all of them rather than the first', () => {
    const bare = version({ licensing: { status: 'unresolved' } });
    const stripped = facts({ answerSpecificationAccepted: false });
    delete (stripped as { signature?: unknown }).signature;
    delete (stripped as { solution?: unknown }).solution;
    delete (stripped as { renderVerdict?: unknown }).renderVerdict;

    const failure = expectError(checkPublishable(item(bare), bare, stripped));
    expect(failure.unmet.map((entry) => entry.code).sort()).toEqual(
      [
        'ANSWER_SPECIFICATION_INVALID',
        'LICENSING_NOT_RESOLVED',
        'RENDER_VERDICT_MISSING',
        'REVIEWER_SIGNATURE_MISSING',
        'SOLUTION_MISSING',
      ].sort(),
    );
  });

  it('carries a stable code and a location on every failure, so the panel need not parse prose', () => {
    const bare = version({ licensing: { status: 'unresolved' } });
    const failure = expectError(checkPublishable(item(bare), bare, facts()));
    for (const entry of failure.unmet) {
      expect(PRECONDITION_CODES).toContain(entry.code);
      expect(entry.location.length).toBeGreaterThan(0);
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });

  it('summarises the codes in the error message', () => {
    const bare = version({ licensing: { status: 'unresolved' } });
    expect(expectError(checkPublishable(item(bare), bare, facts())).message).toContain(
      'LICENSING_NOT_RESOLVED',
    );
  });

  it('is a PreconditionFailed, and its list is frozen', () => {
    const bare = version({ licensing: { status: 'unresolved' } });
    const failure = expectError(checkPublishable(item(bare), bare, facts()));
    expect(failure.kind).toBe('PreconditionFailed');
    expect(Object.isFrozen(failure.unmet)).toBe(true);
  });
});

describe('the aggregate refuses to publish on an unsatisfied verdict', () => {
  function approved(current: ItemVersion): Item {
    return expectValue(
      reconstituteItem({
        itemId: 'item-1',
        itemType: 'SINGLE_CORRECT_MCQ',
        lifecycleState: 'approved',
        versions: [current],
        aggregateVersion: 2,
      }),
    );
  }

  it('publishes when the preconditions hold', () => {
    const target = approved(V1);
    const satisfied = arePublicationPreconditionsSatisfied(target, V1, facts());
    expect(
      expectValue(publishVersion(target, { versionId: V1.versionId, preconditionsSatisfied: satisfied }))
        .lifecycleState,
    ).toBe('published');
  });

  // End to end: a real unmet precondition stops a real publication.
  it('refuses when licensing is unresolved', () => {
    const unresolved = version({ licensing: { status: 'unresolved' } });
    const target = approved(unresolved);
    const satisfied = arePublicationPreconditionsSatisfied(target, unresolved, facts());
    expect(satisfied).toBe(false);
    expect(
      expectError(publishVersion(target, { versionId: unresolved.versionId, preconditionsSatisfied: satisfied }))
        .code,
    ).toBe('PUBLICATION_NOT_PERMITTED');
  });

  it('refuses when the author reviewed their own version', () => {
    const target = approved(V1);
    const satisfied = arePublicationPreconditionsSatisfied(
      target,
      V1,
      facts({ signature: signature({ reviewer: AUTHOR }) }),
    );
    expect(satisfied).toBe(false);
  });
});

describe('the check is pure', () => {
  it('reads the instant from the supplied facts, never a clock', () => {
    const expiring = version({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme',
        expiresAt: '2026-08-12T09:00:00Z',
      },
    });
    expect(arePublicationPreconditionsSatisfied(item(expiring), expiring, facts({ asOf: '2026-08-12T08:59:59Z' }))).toBe(
      true,
    );
    expect(arePublicationPreconditionsSatisfied(item(expiring), expiring, facts({ asOf: NOW }))).toBe(false);
  });

  it('returns the same verdict on repeated calls', () => {
    const target = item();
    for (let run = 0; run < 50; run += 1) {
      expect(arePublicationPreconditionsSatisfied(target, V1, facts())).toBe(true);
    }
  });
});
