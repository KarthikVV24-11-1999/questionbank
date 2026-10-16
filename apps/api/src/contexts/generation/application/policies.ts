import { policy, type AuthorizationPolicy } from './authorization.js';

/**
 * Who may do what in the generation context.
 *
 * Two kinds of caller, kept apart on purpose:
 *
 *   - **`generation_pipeline`** is the machine — the pre-check battery and the
 *     scheduler that starts runs. It may start a run and record a verdict, and
 *     it may do **nothing else**: it cannot accept a candidate, reject one, or
 *     read one back. INV-01 is structural here — the thing that proposes holds
 *     no capability to decide.
 *   - **`content_ops`** is the human who decides. It accepts and rejects, reads
 *     candidates, and may start a run by hand. It may **not** record a verdict:
 *     the battery's results are the audit trail a decision rests on, and a
 *     person able to write them could write the result they wanted.
 *
 * Accepting hands the candidate to content's authoring command under the same
 * principal, so `content_ops` is also a role content's own policy admits; the
 * two policy sets are separate and happen to agree.
 */
export const GENERATION_PIPELINE_ROLE = 'generation_pipeline';
export const CONTENT_OPS_ROLE = 'content_ops';

export const START_GENERATION_RUN_POLICY: AuthorizationPolicy = policy('StartGenerationRun', [
  GENERATION_PIPELINE_ROLE,
  CONTENT_OPS_ROLE,
]);

export const RECORD_PRECHECK_VERDICT_POLICY: AuthorizationPolicy = policy('RecordPrecheckVerdict', [
  GENERATION_PIPELINE_ROLE,
]);

export const ACCEPT_CANDIDATE_POLICY: AuthorizationPolicy = policy('AcceptCandidate', [CONTENT_OPS_ROLE]);

export const REJECT_CANDIDATE_POLICY: AuthorizationPolicy = policy('RejectCandidate', [CONTENT_OPS_ROLE]);

export const GET_CANDIDATE_POLICY: AuthorizationPolicy = policy('GetCandidate', [CONTENT_OPS_ROLE]);

export const LIST_RUN_CANDIDATES_POLICY: AuthorizationPolicy = policy('ListRunCandidates', [CONTENT_OPS_ROLE]);

/** Every policy this module declares — what the specs walk, so a policy cannot be added unseen. */
export const GENERATION_POLICIES: readonly AuthorizationPolicy[] = Object.freeze([
  START_GENERATION_RUN_POLICY,
  RECORD_PRECHECK_VERDICT_POLICY,
  ACCEPT_CANDIDATE_POLICY,
  REJECT_CANDIDATE_POLICY,
  GET_CANDIDATE_POLICY,
  LIST_RUN_CANDIDATES_POLICY,
]);
