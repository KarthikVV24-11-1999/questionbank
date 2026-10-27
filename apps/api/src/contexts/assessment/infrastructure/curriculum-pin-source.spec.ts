import { describe, expect, it } from 'vitest';
import { createPracticePolicy } from '../domain/delivery-policy.js';
import { err, ok } from '../domain/result.js';
import { CurriculumPinSource, type ProfilePinsView } from './curriculum-pin-source.js';
import type { ApplicationContext } from '../application/ports.js';

const ctx: ApplicationContext = { principal: { kind: 'human', id: 'u', roleContext: ['learner'] }, correlationId: 'c' };
const VIEW: ProfilePinsView = {
  state: 'published',
  taxonomyVersionId: 'tv',
  markingRuleSetHash: 'a'.repeat(64),
  totalDurationMinutes: 180,
  sectionLocking: false,
  autoSubmitOnExpiry: true,
  crossSectionNavigation: true,
  allowMarkForReview: true,
  allowAnswerChange: true,
  allowClearResponse: false,
};
const source = (view: ProfilePinsView) => new CurriculumPinSource({ handle: async () => ok(view) });

describe('the pins an attempt copies from an exam profile version', () => {
  it('carries the taxonomy, the marking hash, the length in milliseconds and the delivery policy', async () => {
    const pins = await source(VIEW).pinsFor('p', ctx);
    expect(pins).toEqual({
      ok: true,
      value: {
        taxonomyVersionId: 'tv',
        markingRuleSetHash: 'a'.repeat(64),
        durationMs: 10_800_000,
        deliveryPolicy: {
          timing: { totalDurationMinutes: 180, sectionLocking: false, autoSubmitOnExpiry: true },
          navigation: { crossSectionNavigation: true, allowMarkForReview: true, allowAnswerChange: true, allowClearResponse: false },
          feedbackMode: 'deferred',
          pausable: false,
        },
      },
    });
  });

  it('asks curriculum for the profile it was given, as the caller', async () => {
    const asked: unknown[] = [];
    await new CurriculumPinSource({ handle: async (query, context) => (asked.push([query, context]), ok(VIEW)) }).pinsFor('p-1', ctx);
    expect(asked).toEqual([[{ profileVersionId: 'p-1' }, ctx]]);
  });

  it('refuses a profile with no marking rule set — it could not be scored — and one still a draft', async () => {
    const unscorable = await source({ ...VIEW, markingRuleSetHash: null }).pinsFor('p', ctx);
    expect(unscorable).toMatchObject({ ok: false, error: { kind: 'PreconditionFailed', code: 'PROFILE_NOT_SCORABLE' } });
    const draft = await source({ ...VIEW, state: 'draft' }).pinsFor('p', ctx);
    expect(draft).toMatchObject({ ok: false, error: { kind: 'PreconditionFailed', code: 'PROFILE_NOT_PUBLISHED' } });
    for (const state of ['published', 'superseded']) expect((await source({ ...VIEW, state }).pinsFor('p', ctx)).ok, state).toBe(true);
  });

  it('passes curriculum\'s refusal through unchanged', async () => {
    const refusal = { kind: 'NotFound' as const, code: 'NOT_FOUND', message: 'no profile' };
    expect(await new CurriculumPinSource({ handle: async () => err(refusal) }).pinsFor('p', ctx)).toEqual({ ok: false, error: refusal });
  });

  describe('for a practice run', () => {
    const policy = expectPolicy();
    it('carries the profile\'s taxonomy and rules, and a delivery that is untimed, immediate and pausable', async () => {
      const pins = await source(VIEW).practicePinsFor('p', policy, ctx);
      expect(pins).toMatchObject({ ok: true, value: { taxonomyVersionId: 'tv', markingRuleSetHash: 'a'.repeat(64), isTimed: false, durationMs: null } });
      expect((pins as { value: { deliveryPolicy: Record<string, unknown> } }).value.deliveryPolicy).toMatchObject({ feedbackMode: 'immediate', pausable: true });
    });

    it('refuses what a mock refuses — no rules to score by, a draft — and passes curriculum\'s refusal through', async () => {
      expect(await source({ ...VIEW, markingRuleSetHash: null }).practicePinsFor('p', policy, ctx)).toMatchObject({ ok: false, error: { code: 'PROFILE_NOT_SCORABLE' } });
      expect(await source({ ...VIEW, state: 'draft' }).practicePinsFor('p', policy, ctx)).toMatchObject({ ok: false, error: { code: 'PROFILE_NOT_PUBLISHED' } });
      const refusal = { kind: 'NotFound' as const, code: 'NOT_FOUND', message: 'no profile' };
      expect(await new CurriculumPinSource({ handle: async () => err(refusal) }).practicePinsFor('p', policy, ctx)).toEqual({ ok: false, error: refusal });
    });
  });
});

function expectPolicy() {
  const made = createPracticePolicy({ selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' } });
  if (!made.ok) throw new Error('fixture policy');
  return made.value;
}
