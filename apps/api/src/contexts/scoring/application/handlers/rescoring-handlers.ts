import { err, ok, type Result } from '../../domain/result.js';
import { scoreAttemptAtPinnedVersion } from '../../domain/schema-version-registry.js';
import type { ScoreRecord } from '../../domain/score-record.js';
import { buildDryRunResult, type DryRunResult, type RescoringPair } from '../../domain/rescoring-dry-run.js';
import {
  approveRescoring,
  beginExecution,
  completeExecution,
  draftRescoring,
  recordDryRun,
  type RescoringOperation,
} from '../../domain/rescoring-operation.js';
import type { RescoringOperationRepository, ScoreRecordRepository } from '../../domain/repository-ports.js';
import type { AttemptsRescored } from '../../domain/events/scoring-events.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import type { Handler } from '../handler-registry.js';
import type {
  ApproveRescoring,
  DraftRescoring,
  ExecuteRescoring,
  RunRescoringDryRun,
  ScoreAttempt,
} from '../commands/scoring-commands.js';

/**
 * Re-scoring is the consequential command in this context: it changes numbers
 * people have already been told. Approval requires step-up, and the dry run
 * uses the **same executor** as execution, so a preview cannot promise one
 * thing and the run deliver another.
 */

export interface RescoringEventPublisher {
  publish(event: AttemptsRescored): Promise<void>;
}

export const DRAFT_RESCORING_POLICY = policy('DraftRescoring', ['ops', 'admin']);
export const RUN_RESCORING_DRY_RUN_POLICY = policy('RunRescoringDryRun', ['ops', 'admin']);
export const APPROVE_RESCORING_POLICY = policy('ApproveRescoring', ['admin'], true);
export const EXECUTE_RESCORING_POLICY = policy('ExecuteRescoring', ['admin'], true);

export interface RescoringDependencies {
  readonly operations: RescoringOperationRepository;
  readonly records: ScoreRecordRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly events: RescoringEventPublisher;
}

function toApplicationError(error: { kind: string; code: string; message: string }): ApplicationError {
  return applicationError(error.kind as ApplicationError['kind'], error.code, error.message);
}

/** Re-scores every attempt in scope without persisting anything. */
async function previewScope(
  deps: RescoringDependencies,
  attempts: readonly ScoreAttempt[],
): Promise<Result<{ pairs: RescoringPair[]; successors: ScoreRecord[] }, ApplicationError>> {
  const pairs: RescoringPair[] = [];
  const successors: ScoreRecord[] = [];

  for (const attempt of attempts) {
    const before = await deps.records.findCurrentByAttemptId(attempt.input.attemptId);
    if (!before.ok) return err(toApplicationError(before.error));

    const after = scoreAttemptAtPinnedVersion({
      input: attempt.input,
      ruleSet: attempt.ruleSet,
      ruleSetHash: attempt.ruleSetHash,
      aggregation: attempt.aggregation,
      computedAt: deps.clock.now().toISOString(),
      scoreRecordId: deps.identifiers.next(),
      generation: before.value.generation + 1,
      supersedesScoreRecordId: before.value.scoreRecordId,
      reasonForRescore: 'rescoring operation',
    });
    if (!after.ok) return err(toApplicationError(after.error));

    pairs.push({ before: before.value, after: after.value });
    successors.push(after.value);
  }

  return ok({ pairs, successors });
}

export class DraftRescoringHandler implements Handler<DraftRescoring, RescoringOperation> {
  readonly name = 'DraftRescoring';
  readonly policy = DRAFT_RESCORING_POLICY;

  constructor(private readonly deps: RescoringDependencies) {}

  async handle(command: DraftRescoring, context: ApplicationContext): Promise<Result<RescoringOperation, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const drafted = draftRescoring({ operationId: this.deps.identifiers.next(), ...command });
    if (!drafted.ok) return err(toApplicationError(drafted.error));

    const saved = await this.deps.operations.save(drafted.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: 'DraftRescoring',
      targetContext: 'scoring',
      targetType: 'RescoringOperation',
      targetId: saved.value.operationId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(saved.value);
  }
}

export class RunRescoringDryRunHandler implements Handler<RunRescoringDryRun, DryRunResult> {
  readonly name = 'RunRescoringDryRun';
  readonly policy = RUN_RESCORING_DRY_RUN_POLICY;

  constructor(private readonly deps: RescoringDependencies) {}

  async handle(command: RunRescoringDryRun, context: ApplicationContext): Promise<Result<DryRunResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const operation = await this.deps.operations.findById(command.operationId);
    if (!operation.ok) return err(toApplicationError(operation.error));

    const preview = await previewScope(this.deps, command.attempts);
    if (!preview.ok) return err(preview.error);

    const result = buildDryRunResult(preview.value.pairs);
    const previewed = recordDryRun(operation.value, result);
    if (!previewed.ok) return err(toApplicationError(previewed.error));

    const saved = await this.deps.operations.save(previewed.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    return ok(result);
  }
}

export class ApproveRescoringHandler implements Handler<ApproveRescoring, RescoringOperation> {
  readonly name = 'ApproveRescoring';
  readonly policy = APPROVE_RESCORING_POLICY;

  constructor(private readonly deps: RescoringDependencies) {}

  async handle(command: ApproveRescoring, context: ApplicationContext): Promise<Result<RescoringOperation, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const operation = await this.deps.operations.findById(command.operationId);
    if (!operation.ok) return err(toApplicationError(operation.error));

    const approved = approveRescoring(operation.value, context.principal.id);
    if (!approved.ok) return err(toApplicationError(approved.error));

    const saved = await this.deps.operations.save(approved.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: 'ApproveRescoring',
      targetContext: 'scoring',
      targetType: 'RescoringOperation',
      targetId: saved.value.operationId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(saved.value);
  }
}

export class ExecuteRescoringHandler implements Handler<ExecuteRescoring, RescoringOperation> {
  readonly name = 'ExecuteRescoring';
  readonly policy = EXECUTE_RESCORING_POLICY;

  constructor(private readonly deps: RescoringDependencies) {}

  async handle(command: ExecuteRescoring, context: ApplicationContext): Promise<Result<RescoringOperation, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const operation = await this.deps.operations.findById(command.operationId);
    if (!operation.ok) return err(toApplicationError(operation.error));

    // Execution without a prior dry run is refused here as well as in the
    // domain: the state machine makes it unreachable, and this makes the
    // refusal legible at the boundary an operator actually calls.
    const executing = beginExecution(operation.value);
    if (!executing.ok) return err(toApplicationError(executing.error));

    const saved = await this.deps.operations.save(executing.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    const rerun = await previewScope(this.deps, command.attempts);
    if (!rerun.ok) return err(rerun.error);

    for (const successor of rerun.value.successors) {
      const predecessor = successor.supersedesScoreRecordId as string;
      const written = await this.deps.records.supersede(predecessor, successor, operation.value.operationId);
      if (!written.ok) return err(toApplicationError(written.error));
    }

    const completed = completeExecution(
      expectLoaded(await this.deps.operations.findById(command.operationId)),
      this.deps.clock.now().toISOString(),
    );
    if (!completed.ok) return err(toApplicationError(completed.error));

    const finished = await this.deps.operations.save(completed.value);
    if (!finished.ok) return err(toApplicationError(finished.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: 'ExecuteRescoring',
      targetContext: 'scoring',
      targetType: 'RescoringOperation',
      targetId: finished.value.operationId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    await this.deps.events.publish({
      eventId: this.deps.identifiers.next(),
      eventType: 'AttemptsRescored',
      schemaVersion: 1,
      occurredAt: this.deps.clock.now(),
      principal: context.principal,
      correlationId: context.correlationId,
      payload: {
        rescoringOperationId: finished.value.operationId,
        attemptCount: rerun.value.successors.length,
        trigger: finished.value.trigger,
        scope: finished.value.scope,
      },
    });

    return ok(finished.value);
  }
}

/** The operation was loaded a moment ago and written since; it cannot be missing. */
function expectLoaded(result: Result<RescoringOperation, { message: string }>): RescoringOperation {
  if (!result.ok) throw new Error(`scoring: rescoring operation vanished mid-execution: ${result.error.message}`);
  return result.value;
}
