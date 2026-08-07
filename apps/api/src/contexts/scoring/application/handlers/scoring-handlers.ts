import { err, ok, type Result } from '../../domain/result.js';
import { scoreAttemptAtPinnedVersion } from '../../domain/schema-version-registry.js';
import { markSuperseded, type ScoreRecord } from '../../domain/score-record.js';
import { rationalToDecimalString } from '../../domain/numeric/decimal.js';
import type { ScoreRecordRepository } from '../../domain/repository-ports.js';
import type { AttemptScored } from '../../domain/events/scoring-events.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import type { Handler } from '../handler-registry.js';
import type { ScoreAttempt } from '../commands/scoring-commands.js';

/**
 * Orchestration only (§1). Every decision about what a mark is belongs to the
 * domain; this layer authorizes, supplies the clock and the identifier, saves,
 * and publishes.
 */

export interface EventPublisher {
  publish(event: AttemptScored): Promise<void>;
}

export const SCORE_ATTEMPT_POLICY = policy('ScoreAttempt', ['ops', 'admin', 'system']);

export interface ScoreAttemptDependencies {
  readonly records: ScoreRecordRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly events: EventPublisher;
}

export class ScoreAttemptHandler implements Handler<ScoreAttempt, ScoreRecord> {
  readonly name = 'ScoreAttempt';
  readonly policy = SCORE_ATTEMPT_POLICY;

  constructor(private readonly deps: ScoreAttemptDependencies) {}

  async handle(command: ScoreAttempt, context: ApplicationContext): Promise<Result<ScoreRecord, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    // REL-02: a retried submission returns what already exists rather than
    // producing a second generation nobody asked for.
    const existing = await this.deps.records.findCurrentByAttemptId(command.input.attemptId);
    if (existing.ok) return ok(existing.value);

    const scored = scoreAttemptAtPinnedVersion({
      input: command.input,
      ruleSet: command.ruleSet,
      ruleSetHash: command.ruleSetHash,
      aggregation: command.aggregation,
      // Read once, here. The domain never sees a clock (F45).
      computedAt: this.deps.clock.now().toISOString(),
      scoreRecordId: this.deps.identifiers.next(),
    });
    if (!scored.ok) {
      return err(applicationError(scored.error.kind, scored.error.code, scored.error.message));
    }

    const saved = await this.deps.records.save(scored.value);
    if (!saved.ok) {
      return err(applicationError(saved.error.kind, saved.error.code, saved.error.message));
    }

    await this.deps.audit.record({
      principal: context.principal,
      action: 'ScoreAttempt',
      targetContext: 'scoring',
      targetType: 'ScoreRecord',
      targetId: saved.value.scoreRecordId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    await this.deps.events.publish({
      eventId: this.deps.identifiers.next(),
      eventType: 'AttemptScored',
      schemaVersion: 1,
      occurredAt: this.deps.clock.now(),
      principal: context.principal,
      correlationId: context.correlationId,
      payload: {
        scoreRecordId: saved.value.scoreRecordId,
        attemptId: saved.value.attemptId,
        generation: saved.value.generation,
        markingRuleSetHash: saved.value.markingRuleSetHash,
        ruleSchemaVersion: saved.value.ruleSchemaVersion,
        totalRaw: rationalToDecimalString(saved.value.totalScore.raw),
        totalMaxAvailable: rationalToDecimalString(saved.value.totalScore.maxAvailable),
      },
    });

    return ok(saved.value);
  }
}

/** Exported for the rescoring handler, which produces successors the same way. */
export { markSuperseded };
