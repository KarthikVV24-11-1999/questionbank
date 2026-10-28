import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PLATFORM_THRESHOLDS_V2, D002_THRESHOLDS, thresholdsWith } from '../../../testing/learning-thresholds.js';
import { err, ok } from '../domain/result.js';
import type { PaceSlot } from '../domain/pace-analytics.js';
import { applicationError } from './authorization.js';
import { GetPaceAnalyticsHandler } from './handlers/pace-handler.js';
import type { MasteryRuleSetRepository, PaceSlotSource } from './ports.js';

const LEARNER = randomUUID();
const ATTEMPT = randomUUID();
const TAX_A = '00000000-0000-4000-8000-00000000a001';
const TAX_B = '00000000-0000-4000-8000-00000000a002';
const context = (roles = ['learner']) => ({ principal: { kind: 'human' as const, id: LEARNER, roleContext: roles }, correlationId: 'c' });

const slot = (taxonomyVersionId: string, timeOnItemMs: number): PaceSlot => ({ slotRef: `s-${taxonomyVersionId.slice(-1)}`, conceptIdentityId: randomUUID(), taxonomyVersionId, difficultyEstimate: 'moderate', outcome: 'correct', timeOnItemMs, discardedMs: 0, unclosedVisits: 0 });

function handler(slots: readonly PaceSlot[], thresholds: Record<string, unknown> = { [TAX_A]: PLATFORM_THRESHOLDS_V2, [TAX_B]: PLATFORM_THRESHOLDS_V2 }, asked: string[] = []) {
  const source: PaceSlotSource = { paceSlotsForAttempt: async (learner, attempt) => { asked.push(`${learner}:${attempt}`); return ok(slots); } };
  const ruleSets = {
    currentFor: async (taxonomy: string) => ok({ ruleSetId: `rs-${taxonomy.slice(-1)}`, taxonomyVersionId: taxonomy, versionNo: 1, thresholds: thresholds[taxonomy], thresholdsHash: `h-${taxonomy.slice(-1)}` }),
  } as unknown as MasteryRuleSetRepository;
  return new GetPaceAnalyticsHandler({ slots: source, ruleSets });
}

describe('GetPaceAnalytics (M7-46)', () => {
  it('is the learner\'s alone, and asks for the caller\'s own attempt: the learner is the principal and not a field', async () => {
    const asked: string[] = [];
    const refused = await handler([], undefined, asked).handle({ attemptId: ATTEMPT }, context(['system']));
    expect(refused.ok === false && refused.error.kind).toBe('Authorization');
    expect(asked).toEqual([]);
    await handler([], undefined, asked).handle({ attemptId: ATTEMPT }, context());
    expect(asked).toEqual([`${LEARNER}:${ATTEMPT}`]);
  });

  it('refuses an attempt id that is not an identifier', async () => {
    const result = await handler([]).handle({ attemptId: 'x' }, context());
    expect(result.ok === false && result.error.code).toBe('PACE_QUERY_INVALID');
  });

  it('draws the line from the rule set, so a rule set that draws it elsewhere reads the same response differently', async () => {
    const line = PLATFORM_THRESHOLDS_V2.pace!.slowAboveMs.moderate;
    const slots = [slot(TAX_A, line + 1)];
    const read = async (thresholds: unknown) => {
      const result = await handler(slots, { [TAX_A]: thresholds }).handle({ attemptId: ATTEMPT }, context());
      return result.ok ? result.value.slots[0]!.pace : null;
    };
    expect(await read(PLATFORM_THRESHOLDS_V2)).toBe('slow');
    expect(await read(thresholdsWith({ pace: { slowAboveMs: { foundational: line + 10, moderate: line + 10, challenging: line + 10, advanced: line + 10 } } }))).toBe('fast');
  });

  it('reads each taxonomy version under its own rule set, and names the rule set that read it', async () => {
    const line = PLATFORM_THRESHOLDS_V2.pace!.slowAboveMs.moderate;
    const result = await handler([slot(TAX_A, line + 1), slot(TAX_B, line + 1)], {
      [TAX_A]: PLATFORM_THRESHOLDS_V2,
      [TAX_B]: thresholdsWith({ pace: { slowAboveMs: { foundational: line * 2, moderate: line * 2, challenging: line * 2, advanced: line * 2 } } }),
    }).handle({ attemptId: ATTEMPT }, context());
    expect(result.ok && result.value.slots.map((s) => s.pace)).toEqual(['slow', 'fast']);
    expect(result.ok && result.value.ruleSets).toEqual([{ taxonomyVersionId: TAX_A, ruleSetId: 'rs-1', thresholdsHash: 'h-1' }, { taxonomyVersionId: TAX_B, ruleSetId: 'rs-2', thresholdsHash: 'h-2' }]);
  });

  it('refuses, and does not fall back on a default, where the rule set in force draws no line for slow', async () => {
    const result = await handler([slot(TAX_A, 1)], { [TAX_A]: D002_THRESHOLDS }).handle({ attemptId: ATTEMPT }, context());
    expect(result.ok === false && result.error).toMatchObject({ kind: 'PreconditionFailed', code: 'PACE_NOT_PUBLISHED' });
  });

  it('passes on the source\'s refusal as it is', async () => {
    const source: PaceSlotSource = { paceSlotsForAttempt: async () => err(applicationError('NotFound', 'ATTEMPT_NOT_FOUND', 'no')) };
    const result = await new GetPaceAnalyticsHandler({ slots: source, ruleSets: {} as never }).handle({ attemptId: ATTEMPT }, context());
    expect(result.ok === false && result.error.code).toBe('ATTEMPT_NOT_FOUND');
  });
});
