import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTHOR } from '../../../../testing/content-fixtures.js';
import {
  CONTENT_EVENT_REGISTRY,
  CONTENT_EVENT_TYPES,
  registrationFor,
  type ContentEvent,
  type ContentEventType,
  type ItemPublished,
  type ItemRetired,
  type ItemSuspended,
  type MediaAssetPublished,
  type SolutionPublished,
  type StimulusPublished,
} from './content-events.js';

const TAXONOMY_DOC = readFileSync(
  fileURLToPath(new URL('../../../../../../../docs/EVENT-TAXONOMY.md', import.meta.url)),
  'utf8',
);

const ENVELOPE = {
  eventId: '018f2c...-event',
  schemaVersion: 1,
  occurredAt: new Date('2026-08-10T09:00:00Z'),
  principal: AUTHOR,
  correlationId: 'correlation-1',
} as const;

const ITEM_PUBLISHED: ItemPublished = {
  ...ENVELOPE,
  eventType: 'ItemPublished',
  payload: {
    itemId: 'item-1',
    itemVersionId: 'version-1',
    itemType: 'SINGLE_CORRECT_MCQ',
    versionNo: 1,
    sourceType: 'original',
    primaryConceptIdentityId: 'concept-kinematics',
    taxonomyVersionId: 'taxonomy-2026',
  },
};

const ITEM_SUSPENDED: ItemSuspended = {
  ...ENVELOPE,
  eventType: 'ItemSuspended',
  payload: { itemId: 'item-1', itemVersionId: 'version-1', reason: 'credible wrong-key report' },
};

const ITEM_RETIRED: ItemRetired = {
  ...ENVELOPE,
  eventType: 'ItemRetired',
  payload: {
    itemId: 'item-1',
    itemVersionId: 'version-1',
    retirementReason: 'off syllabus',
    replacedByItemId: 'item-2',
  },
};

const STIMULUS_PUBLISHED: StimulusPublished = {
  ...ENVELOPE,
  eventType: 'StimulusPublished',
  payload: {
    stimulusId: 'stimulus-1',
    stimulusVersionId: 'stimulus-version-1',
    stimulusType: 'passage',
    versionNo: 1,
  },
};

const SOLUTION_PUBLISHED: SolutionPublished = {
  ...ENVELOPE,
  eventType: 'SolutionPublished',
  payload: {
    solutionId: 'solution-1',
    solutionVersionId: 'solution-version-1',
    itemId: 'item-1',
    targetItemVersionId: 'version-1',
  },
};

const MEDIA_PUBLISHED: MediaAssetPublished = {
  ...ENVELOPE,
  eventType: 'MediaAssetPublished',
  payload: {
    assetId: 'asset-1',
    assetVersionId: 'asset-version-1',
    assetType: 'diagram',
    mimeType: 'image/svg+xml',
  },
};

const ALL: readonly ContentEvent[] = [
  ITEM_PUBLISHED,
  ITEM_SUSPENDED,
  ITEM_RETIRED,
  STIMULUS_PUBLISHED,
  SOLUTION_PUBLISHED,
  MEDIA_PUBLISHED,
];

describe('the event vocabulary', () => {
  it('names six events, all past tense (§2)', () => {
    expect([...CONTENT_EVENT_TYPES]).toEqual([
      'ItemPublished',
      'ItemSuspended',
      'ItemRetired',
      'StimulusPublished',
      'SolutionPublished',
      'MediaAssetPublished',
    ]);
    for (const eventType of CONTENT_EVENT_TYPES) {
      expect(eventType).toMatch(/(Published|Suspended|Retired)$/u);
    }
  });

  it('constructs one of each, carrying the full envelope', () => {
    for (const event of ALL) {
      expect(event.eventId).toBeDefined();
      expect(event.schemaVersion).toBe(1);
      expect(event.occurredAt).toBeInstanceOf(Date);
      expect(event.principal.id).toBe('author-1');
      expect(event.correlationId).toBe('correlation-1');
    }
  });

  it('covers every declared type with an event under test', () => {
    expect(ALL.map((event) => event.eventType).sort()).toEqual([...CONTENT_EVENT_TYPES].sort());
  });
});

describe('payloads carry identifiers, never content (§9 rules 10 and 12)', () => {
  // The temptation is real — ItemPublished carrying the stem would save every
  // consumer a fetch. The outbox drains to analytics, which is exactly where
  // a key must never arrive.
  const FORBIDDEN = [
    'stem',
    'body',
    'blocks',
    'options',
    'correctOptionId',
    'correctOptionIds',
    'answerKey',
    'expectedValue',
    'spec',
    'pairs',
    'isCorrect',
    'solutionSteps',
    'steps',
    'finalAnswer',
    'misconception',
    'altText',
    'email',
    'displayName',
    'phone',
  ];

  it.each(ALL.map((event) => [event.eventType, event] as const))(
    '%s carries no content-bearing or key-bearing field',
    (_type, event) => {
      const serialized = JSON.stringify(event.payload);
      for (const field of FORBIDDEN) {
        expect(serialized).not.toMatch(new RegExp(`"${field}"`, 'u'));
      }
    },
  );

  it('carries no free text beyond a reason a human wrote deliberately', () => {
    // Reasons are the one narrative field, and they are operator-authored on
    // a governance action rather than content.
    expect(ITEM_SUSPENDED.payload.reason).toBe('credible wrong-key report');
    expect(ITEM_RETIRED.payload.retirementReason).toBe('off syllabus');
  });

  it('gives Assessment what it needs to pin a slot without fetching', () => {
    expect(ITEM_PUBLISHED.payload).toMatchObject({
      itemId: 'item-1',
      itemVersionId: 'version-1',
      itemType: 'SINGLE_CORRECT_MCQ',
    });
  });

  it('lets a supersession be expressed without carrying the old version', () => {
    const superseding: ItemPublished = {
      ...ITEM_PUBLISHED,
      payload: { ...ITEM_PUBLISHED.payload, versionNo: 2, supersedesItemVersionId: 'version-1' },
    };
    expect(superseding.payload.supersedesItemVersionId).toBe('version-1');
  });

  it('omits the supersession key on a first publication', () => {
    expect(Object.hasOwn(ITEM_PUBLISHED.payload, 'supersedesItemVersionId')).toBe(false);
  });

  it('omits the replacement key when a retirement names none', () => {
    const withoutReplacement: ItemRetired = {
      ...ITEM_RETIRED,
      payload: { itemId: 'item-1', itemVersionId: 'version-1', retirementReason: 'off syllabus' },
    };
    expect(Object.hasOwn(withoutReplacement.payload, 'replacedByItemId')).toBe(false);
  });
});

describe('F18 — every event has an analytics counterpart or a written exemption', () => {
  it('registers every declared event type exactly once', () => {
    expect(CONTENT_EVENT_REGISTRY.map((entry) => entry.eventType).sort()).toEqual(
      [...CONTENT_EVENT_TYPES].sort(),
    );
    expect(CONTENT_EVENT_REGISTRY).toHaveLength(CONTENT_EVENT_TYPES.length);
  });

  // "We did not think about it" and "it deliberately has none" are
  // indistinguishable without a written reason.
  it('gives every registration either a counterpart or a reason, never neither and never both', () => {
    for (const entry of CONTENT_EVENT_REGISTRY) {
      const hasCounterpart = entry.analyticsEvent !== null;
      const hasExemption = entry.analyticsExemptionReason !== null;
      expect(hasCounterpart !== hasExemption).toBe(true);
    }
  });

  it('gives a non-empty reason wherever it claims an exemption', () => {
    for (const entry of CONTENT_EVENT_REGISTRY) {
      if (entry.analyticsExemptionReason !== null) {
        expect(entry.analyticsExemptionReason.trim().length).toBeGreaterThan(10);
      }
    }
  });

  // The counterpart has to exist in the taxonomy, or the reconciliation is
  // against a name nobody publishes.
  it('names only analytics events EVENT-TAXONOMY actually catalogues', () => {
    for (const entry of CONTENT_EVENT_REGISTRY) {
      if (entry.analyticsEvent !== null) {
        expect(TAXONOMY_DOC).toContain(entry.analyticsEvent);
      }
    }
  });

  it('follows the taxonomy’s naming convention for every counterpart', () => {
    for (const entry of CONTENT_EVENT_REGISTRY) {
      if (entry.analyticsEvent !== null) {
        expect(entry.analyticsEvent).toMatch(/^[a-z_]+\.[a-z_]+$/u);
      }
    }
  });

  it('is frozen, registry and entries alike', () => {
    expect(Object.isFrozen(CONTENT_EVENT_REGISTRY)).toBe(true);
    for (const entry of CONTENT_EVENT_REGISTRY) expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('registrationFor', () => {
  it('finds the registration for every declared type', () => {
    for (const eventType of CONTENT_EVENT_TYPES) {
      expect(registrationFor(eventType)?.eventType).toBe(eventType);
    }
  });

  // Handing back another event's registration would emit under the wrong
  // analytics name, which is worse than returning nothing.
  it('returns nothing for a type it does not know, rather than another entry', () => {
    expect(registrationFor('ItemArchived' as ContentEventType)).toBeUndefined();
  });
});
