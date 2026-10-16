import { describe, expect, it } from 'vitest';
import {
  ACCEPT_CANDIDATE_POLICY,
  CONTENT_OPS_ROLE,
  GENERATION_PIPELINE_ROLE,
  GENERATION_POLICIES,
  GET_CANDIDATE_POLICY,
  LIST_RUN_CANDIDATES_POLICY,
  RECORD_PRECHECK_VERDICT_POLICY,
  REJECT_CANDIDATE_POLICY,
  START_GENERATION_RUN_POLICY,
} from './policies.js';

describe('the generation policies, by name', () => {
  // Asserted as a set against literals: a loop over the list cannot notice the
  // list getting shorter, or a role quietly widening.
  it('grants exactly these roles to exactly these acts', () => {
    const granted = Object.fromEntries(GENERATION_POLICIES.map((entry) => [entry.name, [...entry.allowedRoles].sort()]));
    expect(granted).toEqual({
      StartGenerationRun: ['content_ops', 'generation_pipeline'],
      RecordPrecheckVerdict: ['generation_pipeline'],
      AcceptCandidate: ['content_ops'],
      RejectCandidate: ['content_ops'],
      GetCandidate: ['content_ops'],
      ListRunCandidates: ['content_ops'],
    });
    expect(GENERATION_POLICIES).toHaveLength(6);
  });

  it('names a role on every policy, and a distinct name on each', () => {
    for (const entry of GENERATION_POLICIES) expect(entry.allowedRoles.length, entry.name).toBeGreaterThan(0);
    expect(new Set(GENERATION_POLICIES.map((entry) => entry.name)).size).toBe(GENERATION_POLICIES.length);
  });

  // INV-01 as roles: the machine that proposes cannot decide, and the person
  // who decides cannot write the audit trail the decision rests on.
  it('keeps the proposing machine away from every decision and every read', () => {
    for (const decided of [ACCEPT_CANDIDATE_POLICY, REJECT_CANDIDATE_POLICY, GET_CANDIDATE_POLICY, LIST_RUN_CANDIDATES_POLICY]) {
      expect(decided.allowedRoles, decided.name).not.toContain(GENERATION_PIPELINE_ROLE);
    }
  });

  it('keeps the deciding human away from the battery’s verdicts', () => {
    expect(RECORD_PRECHECK_VERDICT_POLICY.allowedRoles).not.toContain(CONTENT_OPS_ROLE);
  });

  it('lets either start a run', () => {
    expect(START_GENERATION_RUN_POLICY.allowedRoles).toContain(GENERATION_PIPELINE_ROLE);
    expect(START_GENERATION_RUN_POLICY.allowedRoles).toContain(CONTENT_OPS_ROLE);
  });

  it('asks for no step-up anywhere: publication is content’s, and this context never publishes', () => {
    for (const entry of GENERATION_POLICIES) expect(entry.requiresStepUp, entry.name).toBe(false);
  });
});
