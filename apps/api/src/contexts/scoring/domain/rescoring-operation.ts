import { err, ok, type Result } from './result.js';
import { preconditionFailedError, validationError, type ScoringError } from './scoring-error.js';
import type { DryRunResult } from './rescoring-dry-run.js';

/**
 * Correcting historical results, made a governed and previewable operation
 * (DOMAIN-MODEL §7).
 *
 * A re-score changes numbers people have already been told. The state machine
 * exists so that cannot happen quietly: **`approved` is unreachable without a
 * dry-run**, and execution is unreachable without approval. The preview is not
 * advisory — it is the gate.
 */

export const RESCORING_TRIGGERS = ['CHALLENGE_UPHELD', 'KEY_DEFECT_CONFIRMED', 'RULE_CORRECTION'] as const;
export type RescoringTrigger = (typeof RESCORING_TRIGGERS)[number];

export const RESCORING_SCOPES = ['ITEM_VERSION', 'RULE_CHANGE', 'FORM'] as const;
export type RescoringScope = (typeof RESCORING_SCOPES)[number];

export const RESCORING_STATES = ['drafted', 'previewed', 'approved', 'executing', 'completed'] as const;
export type RescoringState = (typeof RESCORING_STATES)[number];

/** The only legal moves. Everything absent from this map is refused. */
const LEGAL_TRANSITIONS: Readonly<Record<RescoringState, readonly RescoringState[]>> = Object.freeze({
  drafted: Object.freeze(['previewed'] as const),
  previewed: Object.freeze(['previewed', 'approved'] as const),
  approved: Object.freeze(['executing'] as const),
  executing: Object.freeze(['completed'] as const),
  completed: Object.freeze([] as const),
});

export interface RescoringOperation {
  readonly operationId: string;
  readonly trigger: RescoringTrigger;
  readonly scope: RescoringScope;
  readonly scopeRef: string;
  readonly reason: string;
  readonly state: RescoringState;
  readonly dryRunResult?: DryRunResult;
  readonly authorizedBy?: string;
  readonly executedAt?: string;
  /** Optimistic concurrency (P8). Set when loaded; absent on a fresh draft. */
  readonly expectedVersion?: number;
}

export type RescoringErrorCode =
  | 'OPERATION_ID_REQUIRED'
  | 'SCOPE_REF_REQUIRED'
  | 'REASON_REQUIRED'
  | 'TRIGGER_UNKNOWN'
  | 'SCOPE_UNKNOWN'
  | 'ILLEGAL_TRANSITION'
  | 'APPROVAL_REQUIRES_DRY_RUN'
  | 'APPROVAL_REQUIRES_PRINCIPAL'
  | 'EXECUTED_AT_REQUIRED';

export type RescoringError = ScoringError<RescoringErrorCode>;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

export interface DraftRescoringProps {
  readonly operationId: string;
  readonly trigger: RescoringTrigger;
  readonly scope: RescoringScope;
  readonly scopeRef: string;
  readonly reason: string;
}

export function draftRescoring(props: DraftRescoringProps): Result<RescoringOperation, RescoringError> {
  if (isBlank(props.operationId)) {
    return err(validationError('OPERATION_ID_REQUIRED', 'operationId is required'));
  }
  if (!(RESCORING_TRIGGERS as readonly string[]).includes(props.trigger)) {
    return err(validationError('TRIGGER_UNKNOWN', `unknown trigger "${props.trigger}"`));
  }
  if (!(RESCORING_SCOPES as readonly string[]).includes(props.scope)) {
    return err(validationError('SCOPE_UNKNOWN', `unknown scope "${props.scope}"`));
  }
  if (isBlank(props.scopeRef)) {
    return err(validationError('SCOPE_REF_REQUIRED', 'a re-score must name what it applies to'));
  }
  // A re-score with no stated reason is a change to published results that
  // nobody can account for afterwards.
  if (isBlank(props.reason)) {
    return err(validationError('REASON_REQUIRED', 'a re-score must record why it is happening'));
  }

  return ok(
    Object.freeze({
      operationId: props.operationId,
      trigger: props.trigger,
      scope: props.scope,
      scopeRef: props.scopeRef,
      reason: props.reason,
      state: 'drafted' as const,
    }),
  );
}

function transition(
  operation: RescoringOperation,
  to: RescoringState,
): Result<RescoringState, RescoringError> {
  return LEGAL_TRANSITIONS[operation.state].includes(to)
    ? ok(to)
    : err(
        validationError(
          'ILLEGAL_TRANSITION',
          `a ${operation.state} re-score cannot move to ${to}`,
        ),
      );
}

/** Recording a preview. Re-running one is legal — an operator may look twice. */
export function recordDryRun(
  operation: RescoringOperation,
  dryRunResult: DryRunResult,
): Result<RescoringOperation, RescoringError> {
  const next = transition(operation, 'previewed');
  if (!next.ok) return err(next.error);
  return ok(Object.freeze({ ...operation, state: next.value, dryRunResult }));
}

export function approveRescoring(
  operation: RescoringOperation,
  authorizedBy: string,
): Result<RescoringOperation, RescoringError> {
  const next = transition(operation, 'approved');
  if (!next.ok) return err(next.error);

  // Belt as well as braces: the state machine already makes `approved`
  // reachable only from `previewed`, and this makes the reason explicit.
  if (operation.dryRunResult === undefined) {
    return err(
      preconditionFailedError('APPROVAL_REQUIRES_DRY_RUN', 'a re-score cannot be approved without a dry run'),
    );
  }
  if (isBlank(authorizedBy)) {
    return err(validationError('APPROVAL_REQUIRES_PRINCIPAL', 'approval must record who gave it'));
  }

  return ok(Object.freeze({ ...operation, state: next.value, authorizedBy }));
}

export function beginExecution(operation: RescoringOperation): Result<RescoringOperation, RescoringError> {
  const next = transition(operation, 'executing');
  if (!next.ok) return err(next.error);
  return ok(Object.freeze({ ...operation, state: next.value }));
}

export function completeExecution(
  operation: RescoringOperation,
  executedAt: string,
): Result<RescoringOperation, RescoringError> {
  const next = transition(operation, 'completed');
  if (!next.ok) return err(next.error);
  if (isBlank(executedAt)) {
    return err(validationError('EXECUTED_AT_REQUIRED', 'executedAt is required'));
  }
  return ok(Object.freeze({ ...operation, state: next.value, executedAt }));
}
