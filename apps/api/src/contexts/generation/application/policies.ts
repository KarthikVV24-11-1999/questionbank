import { policy, type AuthorizationPolicy } from './authorization.js';
import { ROLES } from '../../../platform/auth/roles.js';

/**
 * Who may do what in the generation context.
 *
 * Two kinds of caller, kept apart on purpose:
 *
 *   - **`generation_pipeline`** is the machine — the pre-check battery and the
 *     scheduler that starts runs. It may start a run, record a verdict, and act on
 *     the battery's result through `DisposeCandidate` (ADR-0029); it cannot read a
 *     candidate back, and it cannot accept or reject by its own say-so.
 *   - **`content_ops`** is the human who intervenes. It may accept or reject a
 *     candidate by hand, read candidates, and start a run. It may **not** record a
 *     verdict: the battery's results are the audit trail a decision rests on, and a
 *     person able to write them could write the result they wanted.
 *
 * Disposing hands the candidate to content's authoring commands under the caller's
 * principal, so both roles are also roles content's own policies admit — for
 * `CreateItemDraft` and `SubmitItemForReview` and for nothing else of content's; the
 * two policy sets are separate and agree.
 */
export const GENERATION_PIPELINE_ROLE = ROLES.generationPipeline;
export const CONTENT_OPS_ROLE = ROLES.contentOps;

export const START_GENERATION_RUN_POLICY: AuthorizationPolicy = policy('StartGenerationRun', [
  GENERATION_PIPELINE_ROLE,
  CONTENT_OPS_ROLE,
]);

/**
 * Declaring a budget is a spending decision, and a person's: `content_ops` alone. The
 * pipeline that spends against a ceiling cannot set it, so a run cannot raise its own
 * limit.
 */
export const DECLARE_AI_BUDGET_POLICY: AuthorizationPolicy = policy('DeclareAIBudget', [CONTENT_OPS_ROLE]);

/**
 * Recording an evaluation is a person's, `content_ops` alone. The pipeline is what a pass lets through, so
 * it cannot certify itself: a machine that could record its own version's evaluation could activate any
 * version it liked, and F31 would gate nothing.
 */
export const RECORD_EVALUATION_RUN_POLICY: AuthorizationPolicy = policy('RecordEvaluationRun', [CONTENT_OPS_ROLE]);

/** Only the pipeline proposes: a human typing a candidate in would be a human authoring through the AI's door, which is content's own. */
export const PROPOSE_CANDIDATE_POLICY: AuthorizationPolicy = policy('ProposeCandidate', [GENERATION_PIPELINE_ROLE]);

/** The battery is the machine's: the verdicts it writes are the audit trail a human decision rests on. */
export const RUN_PRECHECK_BATTERY_POLICY: AuthorizationPolicy = policy('RunPrecheckBattery', [GENERATION_PIPELINE_ROLE]);

export const RECORD_PRECHECK_VERDICT_POLICY: AuthorizationPolicy = policy('RecordPrecheckVerdict', [
  GENERATION_PIPELINE_ROLE,
]);

/**
 * **This is the pipeline's accept capability, and it is not a decision capability.**
 * The handler acts on `dispositionOf`, a function of the verdicts the battery
 * recorded: it carries a result already reached, it does not form a judgement. It
 * cannot accept what the verdicts do not support (`acceptCandidate` still refuses),
 * and it can reject only a candidate that failed a blocking check. What it produces
 * is a draft awaiting a reviewer, never published content — the human decision is
 * the reviewer's, one stage and not two (AI-ARCHITECTURE §13, ADR-0029).
 */
export const DISPOSE_CANDIDATE_POLICY: AuthorizationPolicy = policy('DisposeCandidate', [GENERATION_PIPELINE_ROLE]);

/** The operator's override: an intervention on one candidate, not the path candidates take. */
export const ACCEPT_CANDIDATE_POLICY: AuthorizationPolicy = policy('AcceptCandidate', [CONTENT_OPS_ROLE]);

export const REJECT_CANDIDATE_POLICY: AuthorizationPolicy = policy('RejectCandidate', [CONTENT_OPS_ROLE]);

export const GET_CANDIDATE_POLICY: AuthorizationPolicy = policy('GetCandidate', [CONTENT_OPS_ROLE]);

export const LIST_RUN_CANDIDATES_POLICY: AuthorizationPolicy = policy('ListRunCandidates', [CONTENT_OPS_ROLE]);

/** Every policy this module declares — what the specs walk, so a policy cannot be added unseen. */
export const GENERATION_POLICIES: readonly AuthorizationPolicy[] = Object.freeze([
  START_GENERATION_RUN_POLICY,
  DECLARE_AI_BUDGET_POLICY,
  RECORD_EVALUATION_RUN_POLICY,
  PROPOSE_CANDIDATE_POLICY,
  RUN_PRECHECK_BATTERY_POLICY,
  RECORD_PRECHECK_VERDICT_POLICY,
  DISPOSE_CANDIDATE_POLICY,
  ACCEPT_CANDIDATE_POLICY,
  REJECT_CANDIDATE_POLICY,
  GET_CANDIDATE_POLICY,
  LIST_RUN_CANDIDATES_POLICY,
]);
