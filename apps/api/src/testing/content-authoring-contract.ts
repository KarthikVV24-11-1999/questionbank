import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CreateItemDraft } from '../contexts/content/public/index.js';
import type { ContentAuthoring } from '../contexts/generation/application/ports.js';
import { singleCorrectSpec, textBody } from './content-fixtures.js';
import { expectError, expectValue } from './expect-result.js';
import { contextFor, principalWith } from './generation-context.js';

/**
 * One contract, run against every implementation of `ContentAuthoring`. Two
 * implementations of one interface is exactly where a parity test belongs
 * (ENGINEERING-HANDBOOK §5): they are two statements of what "put a draft in
 * content's queue" means, and they drift unless one suite holds both to it.
 *
 * Each implementation runs over content's real handlers on real Postgres; the
 * suite reads the result back from content to see what actually happened.
 */
export interface ContentAuthoringUnderTest {
  readonly authoring: ContentAuthoring;
  /** What content holds, read back for assertions. */
  readonly itemStateOf: (itemId: string) => Promise<{ readonly lifecycleState: string; readonly authoredById: string } | undefined>;
  readonly itemCount: () => Promise<number>;
}

export function draftCommand(overrides: Partial<CreateItemDraft> = {}): CreateItemDraft {
  return {
    itemType: 'SINGLE_CORRECT_MCQ',
    subject: 'physics',
    content: {
      stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
      responseSpec: singleCorrectSpec(),
      taxonomyTags: [{ conceptIdentityId: randomUUID(), taxonomyVersionId: randomUUID(), weight: 1, isPrimary: true }],
      difficultyEstimate: 'moderate',
      provenance: {
        sourceType: 'ai_generated',
        modelVersionId: randomUUID(),
        promptVersionId: randomUUID(),
        generationRunId: randomUUID(),
        confidence: 0.7,
      },
      licensing: { status: 'owned' },
    },
    ...overrides,
  };
}

export function describeContentAuthoringContract(name: string, build: () => ContentAuthoringUnderTest): void {
  describe(`ContentAuthoring contract — ${name}`, () => {
    const ops = principalWith(['content_ops']);

    it('creates a draft and returns its identifier and nothing else', async () => {
      const { authoring, itemStateOf } = build();
      const created = expectValue(await authoring.createDraft(draftCommand(), contextFor(ops)));

      expect(Object.keys(created)).toEqual(['itemId']);
      expect(created.itemId).toMatch(/^[0-9a-f-]{36}$/u);
      const held = await itemStateOf(created.itemId);
      expect(held?.lifecycleState).toBe('draft');
    });

    it('runs under the caller’s own context: the draft’s author is the caller', async () => {
      const { authoring, itemStateOf } = build();
      const created = expectValue(await authoring.createDraft(draftCommand(), contextFor(ops)));
      expect((await itemStateOf(created.itemId))?.authoredById).toBe(ops.id);
    });

    it('puts the draft in front of reviewers, and says so with true', async () => {
      const { authoring, itemStateOf } = build();
      const created = expectValue(await authoring.createDraft(draftCommand(), contextFor(ops)));
      const submitted = expectValue(await authoring.submitForReview({ itemId: created.itemId }, contextFor(ops)));

      expect(submitted).toBe(true);
      expect((await itemStateOf(created.itemId))?.lifecycleState).toBe('in_review');
    });

    it('returns content’s own refusal unchanged, writing nothing: a principal content does not admit', async () => {
      const { authoring, itemCount } = build();
      const before = await itemCount();
      const failure = expectError(await authoring.createDraft(draftCommand(), contextFor(principalWith(['learner']))));
      expect(failure.kind).toBe('Authorization');
      expect(failure.code).toBe('NOT_PERMITTED');
      expect(await itemCount()).toBe(before);
    });

    it('returns content’s own refusal unchanged: a draft that needs a subject and names none', async () => {
      const { authoring } = build();
      const { subject: _subject, ...withoutSubject } = draftCommand();
      const failure = expectError(await authoring.createDraft(withoutSubject, contextFor(ops)));
      expect(failure.kind).toBe('Validation');
      expect(failure.code).toBe('SUBJECT_REQUIRED');
      expect(failure.location).toBe('subject');
    });

    it('returns content’s own refusal unchanged when submitting what does not exist', async () => {
      const { authoring } = build();
      const failure = expectError(await authoring.submitForReview({ itemId: randomUUID() }, contextFor(ops)));
      expect(failure.kind).toBe('NotFound');
    });

    it('returns content’s own refusal unchanged when submitting what was already submitted, leaving it in review', async () => {
      const { authoring, itemStateOf } = build();
      const created = expectValue(await authoring.createDraft(draftCommand(), contextFor(ops)));
      expectValue(await authoring.submitForReview({ itemId: created.itemId }, contextFor(ops)));
      const again = expectError(await authoring.submitForReview({ itemId: created.itemId }, contextFor(ops)));
      expect(again.kind).not.toBe('Authorization');
      expect((await itemStateOf(created.itemId))?.lifecycleState).toBe('in_review');
    });
  });
}
