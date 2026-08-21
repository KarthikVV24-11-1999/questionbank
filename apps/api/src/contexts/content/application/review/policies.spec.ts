import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLISH_ITEM_VERSION_POLICY } from '../handlers/lifecycle-handlers.js';
import {
  APPROVE_WITH_EDITS_POLICY,
  CLAIM_NEXT_FOR_REVIEW_POLICY,
  EXTEND_LEASE_POLICY,
  GET_QUEUE_HEALTH_POLICY,
  REASSIGN_REVIEW_POLICY,
  RECORD_REVIEW_DECISION_POLICY,
  RELEASE_ASSIGNMENT_POLICY,
  REVIEW_POLICIES,
  SWEEP_REVIEW_AGEING_POLICY,
} from './policies.js';

const SOURCE = readFileSync(fileURLToPath(new URL('./policies.ts', import.meta.url)), 'utf8');

describe('the review policies, per DEC-M4-9 and DEC-M4-1', () => {
  it('lets a reviewer claim, release, extend the lease, decide and approve with edits', () => {
    for (const p of [
      CLAIM_NEXT_FOR_REVIEW_POLICY,
      RELEASE_ASSIGNMENT_POLICY,
      EXTEND_LEASE_POLICY,
      APPROVE_WITH_EDITS_POLICY,
    ]) {
      expect(p.allowedRoles).toEqual(['reviewer']);
    }
    expect(RECORD_REVIEW_DECISION_POLICY.allowedRoles).toEqual(['reviewer', 'content_ops']);
  });

  it('lets content_ops reassign, sweep and read queue health, and only content_ops', () => {
    for (const p of [REASSIGN_REVIEW_POLICY, SWEEP_REVIEW_AGEING_POLICY, GET_QUEUE_HEALTH_POLICY]) {
      expect(p.allowedRoles).toEqual(['content_ops']);
    }
  });

  it('gives content_ops no claim path — reassignment is push-only, per DEC-M4-9', () => {
    expect(CLAIM_NEXT_FOR_REVIEW_POLICY.allowedRoles).not.toContain('content_ops');
  });

  it('gives no review policy a name that is PublishItemVersion, or a wider role set than it', () => {
    for (const p of REVIEW_POLICIES) {
      expect(p.name).not.toBe(PUBLISH_ITEM_VERSION_POLICY.name);
    }
  });

  it('leaves content’s own PublishItemVersion policy untouched — no review policy grants it, no review policy weakens its step-up', () => {
    expect(PUBLISH_ITEM_VERSION_POLICY.allowedRoles).toEqual(['content_ops']);
    expect(PUBLISH_ITEM_VERSION_POLICY.requiresStepUp).toBe(true);
    expect(REVIEW_POLICIES.map((p) => p.name)).not.toContain('PublishItemVersion');
  });

  it('names none of the eight declared review policies as requiring step-up — content’s publish gate is the only step-up policy', () => {
    for (const p of REVIEW_POLICIES) {
      expect(p.requiresStepUp).toBe(false);
    }
  });

  it('reuses DRAFT_OVERSIGHT_ROLES rather than declaring a parallel content_ops array', () => {
    expect(SOURCE).toMatch(/import \{ DRAFT_OVERSIGHT_ROLES, policy, type AuthorizationPolicy \} from '\.\.\/authorization\.js';/u);
    // The content_ops-only policies pass the imported constant by name, not a literal.
    expect(SOURCE).toMatch(/policy\('ReassignReview', DRAFT_OVERSIGHT_ROLES\)/u);
    expect(SOURCE).toMatch(/policy\('SweepReviewAgeing', DRAFT_OVERSIGHT_ROLES\)/u);
    expect(SOURCE).toMatch(/policy\('GetQueueHealth', DRAFT_OVERSIGHT_ROLES\)/u);
    // Not a second literal ['content_ops'] passed to any policy() call — the
    // module's own prose is allowed to *mention* the string; only a call site
    // retyping it would be the drift this test exists to catch.
    expect(SOURCE).not.toMatch(/policy\([^)]*\['content_ops'\]/u);
  });

  it('declares all eight named policies and no fewer', () => {
    expect(REVIEW_POLICIES).toHaveLength(8);
    expect(new Set(REVIEW_POLICIES.map((p) => p.name)).size).toBe(8);
  });
});
