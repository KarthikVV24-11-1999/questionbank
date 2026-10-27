import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { D002_THRESHOLDS } from '../../../testing/learning-thresholds.js';
import { applicationError } from './authorization.js';
import { PublishMasteryRuleSetHandler } from './handlers/rule-set-handlers.js';
import { createMasteryRuleSet } from '../domain/mastery-rule-set.js';
import { err, ok } from '../domain/result.js';

const principal = (roles: string[]) => ({ kind: 'human' as const, id: randomUUID(), roleContext: roles });
const admin = { principal: principal(['admin']), correlationId: 'c', stepUpSatisfied: true };

function handler(append: (draft: never) => unknown = async () => ok(expectValue(createMasteryRuleSet({ ruleSetId: randomUUID(), taxonomyVersionId: null, versionNo: 1, thresholds: D002_THRESHOLDS })))) {
  const audited: unknown[] = [];
  return {
    audited,
    handler: new PublishMasteryRuleSetHandler({
      ruleSets: { append, currentFor: async () => err(applicationError('NotFound', 'x', 'x')), byId: async () => err(applicationError('NotFound', 'x', 'x')) } as never,
      clock: { now: () => new Date('2026-10-28T09:00:00.000Z') },
      identifiers: { next: () => randomUUID() },
      audit: { record: async (entry) => void audited.push(entry) },
    }),
  };
}

describe('PublishMasteryRuleSet', () => {
  it('is an administrator\'s, behind step-up, and refuses everyone else before anything is written', async () => {
    let written = 0;
    const { handler: h } = handler(async () => void (written += 1));
    expect(h.policy).toMatchObject({ allowedRoles: ['admin'], requiresStepUp: true });
    for (const roles of [['learner'], ['content_ops'], ['system']]) {
      expect(expectError(await h.handle({ taxonomyVersionId: null, thresholds: D002_THRESHOLDS }, { principal: principal(roles), correlationId: 'c', stepUpSatisfied: true })).code).toBe('NOT_PERMITTED');
    }
    expect(expectError(await h.handle({ taxonomyVersionId: null, thresholds: D002_THRESHOLDS }, { principal: principal(['admin']), correlationId: 'c' })).code).toBe('STEP_UP_REQUIRED');
    expect(written).toBe(0);
  });

  it('refuses thresholds that are not valid, writing and auditing nothing', async () => {
    let written = 0;
    const { handler: h, audited } = handler(async () => void (written += 1));
    expect(expectError(await h.handle({ taxonomyVersionId: null, thresholds: { nope: true } }, admin)).kind).toBe('Validation');
    expect([written, audited.length]).toEqual([0, 0]);
  });

  it('hands the store a validated, hashed draft naming who published it, and audits what it saved', async () => {
    let seen: Record<string, unknown> | undefined;
    const { handler: h, audited } = handler(async (draft) => {
      seen = draft as Record<string, unknown>;
      return ok(expectValue(createMasteryRuleSet({ ruleSetId: randomUUID(), taxonomyVersionId: null, versionNo: 4, thresholds: D002_THRESHOLDS })));
    });
    expectValue(await h.handle({ taxonomyVersionId: null, thresholds: D002_THRESHOLDS }, admin));
    expect(seen).toMatchObject({ taxonomyVersionId: null, principal: admin.principal, createdAt: new Date('2026-10-28T09:00:00.000Z') });
    expect(audited).toMatchObject([{ action: 'PublishMasteryRuleSet', targetContext: 'learning', targetVersion: 4 }]);
  });

  it('passes a store failure through and audits nothing for a publication that did not happen', async () => {
    const { handler: h, audited } = handler(async () => err(applicationError('Conflict', 'RULE_SET_VERSION_TAKEN', 'x')));
    expect(expectError(await h.handle({ taxonomyVersionId: null, thresholds: D002_THRESHOLDS }, admin)).code).toBe('RULE_SET_VERSION_TAKEN');
    expect(audited).toEqual([]);
  });
});
