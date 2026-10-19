import { describe, expect, it } from 'vitest';
import {
  ACCEPT_CANDIDATE_POLICY,
  CONTENT_OPS_ROLE,
  GENERATION_PIPELINE_ROLE,
  GENERATION_POLICIES,
  DISPOSE_CANDIDATE_POLICY,
  GET_CANDIDATE_POLICY,
  LIST_RUN_CANDIDATES_POLICY,
  PROPOSE_CANDIDATE_POLICY,
  RECORD_PRECHECK_VERDICT_POLICY,
  RUN_PRECHECK_BATTERY_POLICY,
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
      DeclareAIBudget: ['content_ops'],
      RecordEvaluationRun: ['content_ops'],
      ProposeCandidate: ['generation_pipeline'],
      RunPrecheckBattery: ['generation_pipeline'],
      RecordPrecheckVerdict: ['generation_pipeline'],
      DisposeCandidate: ['generation_pipeline'],
      AcceptCandidate: ['content_ops'],
      RejectCandidate: ['content_ops'],
      GetCandidate: ['content_ops'],
      ListRunCandidates: ['content_ops'],
    });
    expect(GENERATION_POLICIES).toHaveLength(11);
  });

  it('names a role on every policy, and a distinct name on each', () => {
    for (const entry of GENERATION_POLICIES) expect(entry.allowedRoles.length, entry.name).toBeGreaterThan(0);
    expect(new Set(GENERATION_POLICIES.map((entry) => entry.name)).size).toBe(GENERATION_POLICIES.length);
  });

  // INV-01 as roles: the machine that proposes holds no judgement of its own, and
  // the person who intervenes cannot write the audit trail the result rests on. The
  // machine's accept capability is DisposeCandidate (ADR-0029) — it acts on recorded
  // verdicts — and the manual accept and reject stay out of its reach.
  it('keeps the proposing machine away from the manual decisions and every read', () => {
    for (const decided of [ACCEPT_CANDIDATE_POLICY, REJECT_CANDIDATE_POLICY, GET_CANDIDATE_POLICY, LIST_RUN_CANDIDATES_POLICY]) {
      expect(decided.allowedRoles, decided.name).not.toContain(GENERATION_PIPELINE_ROLE);
    }
  });

  it('lets only the machine dispose, and keeps the operator on the override', () => {
    expect([...DISPOSE_CANDIDATE_POLICY.allowedRoles]).toEqual([GENERATION_PIPELINE_ROLE]);
  });

  it('keeps the deciding human away from the battery’s verdicts', () => {
    expect(RECORD_PRECHECK_VERDICT_POLICY.allowedRoles).not.toContain(CONTENT_OPS_ROLE);
  });

  it('lets only the machine propose: a human typing a candidate in would be authoring through the AI’s door', () => {
    expect([...PROPOSE_CANDIDATE_POLICY.allowedRoles]).toEqual([GENERATION_PIPELINE_ROLE]);
  });

  it('lets only the machine run the battery, so the verdicts a decision rests on have one author', () => {
    expect([...RUN_PRECHECK_BATTERY_POLICY.allowedRoles]).toEqual([GENERATION_PIPELINE_ROLE]);
  });

  it('lets either start a run', () => {
    expect(START_GENERATION_RUN_POLICY.allowedRoles).toContain(GENERATION_PIPELINE_ROLE);
    expect(START_GENERATION_RUN_POLICY.allowedRoles).toContain(CONTENT_OPS_ROLE);
  });

  it('asks for no step-up anywhere: publication is content’s, and this context never publishes', () => {
    for (const entry of GENERATION_POLICIES) expect(entry.requiresStepUp, entry.name).toBe(false);
  });
});
