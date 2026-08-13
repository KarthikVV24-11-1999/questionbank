import { describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import * as content from './public/index.js';

/**
 * The M3 → M4 seam, written against `content/public/` **and nothing else**.
 *
 * M4 builds the review workspace: assignment routing, ageing, the rejection
 * taxonomy, the decision screen. It needs to name what it is routing, show what
 * a reviewer is looking at, and drive the transitions Content owns. Every one
 * of those needs a shape from this barrel.
 *
 * The point of the file is the import above: it names the barrel, so a missing
 * export is a compile failure here rather than something M4 discovers by
 * reaching past the barrel into `content/domain`. The M2→M3 seam found a real
 * gap that way — content had no vocabulary to compare against scoring's — and
 * this is the same instrument pointed at the next milestone.
 */

const reviewer: PrincipalRef = { kind: 'human', id: 'reviewer-1', roleContext: ['reviewer'] };

describe('M4 can name what it routes', () => {
  it('reads the lifecycle states and transitions from the barrel', () => {
    // The queue is "everything in_review"; ageing escalates on the same list.
    const states: readonly content.LifecycleState[] = content.LIFECYCLE_STATES;
    expect(states).toContain('in_review');
    expect(states).toContain('changes_requested');

    const transitions: readonly content.LifecycleTransition[] = content.LIFECYCLE_TRANSITIONS;
    expect(transitions).toContain('approve');
    expect(transitions).toContain('request_changes');
  });

  it('reads the review outcomes a decision screen offers (FR-TCH-12 rule 3)', () => {
    const outcomes: readonly content.ReviewOutcome[] = content.REVIEW_OUTCOMES;
    expect([...outcomes]).toEqual(['approve', 'approve_with_edits', 'request_changes', 'reject']);
  });

  it('reads the owner types a decision can be recorded against', () => {
    const owners: readonly content.ReviewedOwnerType[] = [
      'item_version',
      'stimulus_version',
      'solution_version',
    ];
    expect(owners).toHaveLength(3);
  });
});

describe('M4 can construct the commands it drives', () => {
  it('builds a review decision command from barrel types alone', () => {
    const decision: content.RecordItemReviewDecision = {
      itemId: 'item-1',
      itemVersionId: 'version-1',
      outcome: 'request_changes',
      justification: 'the stem does not say the ramp is frictionless',
    };
    expect(decision.outcome).toBe('request_changes');
  });

  it('builds the transitions a workspace triggers', () => {
    const submit: content.SubmitItemForReview = { itemId: 'item-1' };
    const withdraw: content.WithdrawItemFromReview = { itemId: 'item-1' };
    const publish: content.PublishItemVersion = { itemId: 'item-1', itemVersionId: 'version-1' };
    const suspend: content.SuspendItem = { itemId: 'item-1', justification: 'defect reported' };
    const retire: content.RetireItem = { itemId: 'item-1', retirementReason: 'out of syllabus' };

    expect([submit, withdraw, publish, suspend, retire]).toHaveLength(5);
  });

  it('builds the stimulus and solution equivalents', () => {
    const stimulus: content.RecordStimulusReviewDecision = {
      stimulusId: 's-1',
      stimulusVersionId: 'sv-1',
      outcome: 'approve',
    };
    const solution: content.RecordSolutionReviewDecision = {
      solutionId: 'sol-1',
      solutionVersionId: 'solv-1',
      outcome: 'approve',
    };
    expect([stimulus.outcome, solution.outcome]).toEqual(['approve', 'approve']);
  });
});

describe('M4 can render what a reviewer looks at (FR-TCH-12 rule 1)', () => {
  it('constructs a content body through the barrel’s own constructor', () => {
    const body = content.createContentBody([
      { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'A block on a ramp.', marks: [] }] },
      { kind: 'MATH_BLOCK', latex: 'a = g\\sin\\theta', textAlternative: 'a equals g sine theta' },
    ]);
    expect(body.ok).toBe(true);
    if (!body.ok) return;

    // Reading order, which is what a reviewer's screen and the search index
    // both need — and it renders notation as its authored alternative.
    const projections = content.projectContentBody(body.value);
    expect(projections.plainText).toContain('a equals g sine theta');
    expect(projections.notationTerms.length).toBeGreaterThan(0);
    expect(projections.referencedMediaIds).toEqual([]);
  });

  it('types an authoring view, which is what a reviewer is shown', () => {
    const view: Pick<content.AuthoringItemVersionView, 'versionId' | 'itemType' | 'authoredById'> = {
      versionId: 'version-1',
      itemType: 'SINGLE_CORRECT_MCQ',
      authoredById: 'author-1',
    };
    // INV-12 at assignment: the workspace excludes the author from the pool,
    // and the identifier it needs to do that is on the view.
    expect(view.authoredById).not.toBe(reviewer.id);
  });

  it('types a delivery view, which carries no key for M4 to leak', () => {
    const view: content.DeliveryItemView = {
      itemId: 'item-1',
      itemVersionId: 'version-1',
      versionNo: 1,
      itemType: 'SINGLE_CORRECT_MCQ',
      stem: { schemaVersion: 1, blocks: [] } as unknown as content.ContentBody,
      options: [],
    };
    expect(Object.keys(view)).not.toContain('responseSpec');
  });
});

describe('M4 can read the findings and preconditions it displays', () => {
  it('groups findings by the codes Content publishes', () => {
    const blocking: readonly content.BlockingCode[] = content.BLOCKING_CODES;
    const warnings: readonly content.WarningCode[] = content.WARNING_CODES;

    expect(blocking).toContain('SOLUTION_MISSING');
    expect(warnings).toContain('PROBABLE_DUPLICATE');
    // Disjoint, so a code belongs to exactly one column of the panel.
    expect(blocking.some((code) => (warnings as readonly string[]).includes(code))).toBe(false);
  });

  it('states plainly that duplicate detection has not run (DEC-7)', () => {
    expect(content.describeDuplicateCheck('not_evaluated')).toMatch(/has not run/u);
  });

  it('groups publication refusals by a stable code, not by message text', () => {
    const codes: readonly string[] = content.PRECONDITION_CODES;
    expect(codes).toContain('REVIEWER_IS_AUTHOR');
    expect(codes).toContain('AI_CONTENT_NOT_HUMAN_REVIEWED');

    const unmet: content.UnmetPrecondition = {
      code: 'REVIEWER_IS_AUTHOR',
      message: 'self-review is prohibited',
      location: 'version.reviewDecision',
    };
    expect(unmet.location).toBeTruthy();
  });
});

describe('M4 can subscribe to what Content publishes', () => {
  it('reads the event vocabulary and a payload shape', () => {
    const types: readonly content.ContentEventType[] = content.CONTENT_EVENT_TYPES;
    expect(types).toContain('ItemPublished');

    const payload: content.ItemPublishedPayload = {
      itemId: 'item-1',
      itemVersionId: 'version-1',
      versionNo: 1,
      itemType: 'SINGLE_CORRECT_MCQ',
      sourceType: 'original',
      primaryConceptIdentityId: 'concept-1',
      taxonomyVersionId: 'taxonomy-1',
    };
    // Identifiers and vocabulary members only. A payload carrying the stem or
    // the key would reach analytics, which is where neither may go (P4/D17).
    expect(Object.keys(payload).every((key) => /Id$|^versionNo$|Type$/u.test(key))).toBe(true);
  });
});

describe('the barrel exports no aggregate, repository or infrastructure type', () => {
  it('exposes only the value-level symbols it means to', () => {
    expect(Object.keys(content).sort()).toEqual([
      'ASSET_TYPES',
      'BLOCKING_CODES',
      'BLOCK_KINDS',
      'CONTENT_BODY_SCHEMA_VERSION',
      'CONTENT_ERROR_KINDS',
      'CONTENT_EVENT_TYPES',
      'DIFFICULTY_BANDS',
      'INLINE_KINDS',
      'ITEM_TYPES',
      'LIFECYCLE_STATES',
      'LIFECYCLE_TRANSITIONS',
      'MEDIA_SIZE_HINTS',
      'PRECONDITION_CODES',
      'REVIEW_OUTCOMES',
      'STIMULUS_TYPES',
      'TEXT_MARKS',
      'WARNING_CODES',
      'createContentBody',
      'describeDuplicateCheck',
      'projectContentBody',
      'projectValidatedAnswerKey',
      'toAnswerKeyData',
    ]);
  });

  it('exports no aggregate constructor, no handler and no repository', () => {
    const forbidden = [
      'createItem',
      'createItemVersion',
      'createSolution',
      'createStimulus',
      'createMediaAsset',
      'transitionItem',
      'publishVersion',
      'PostgresItemRepository',
      'PostgresSolutionRepository',
      'CreateItemDraftHandler',
      'PublishItemVersionHandler',
      'contentSchema',
    ];
    for (const name of forbidden) {
      expect(Object.keys(content), name).not.toContain(name);
    }
  });
});
