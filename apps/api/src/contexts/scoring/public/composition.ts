import type { Pool } from 'pg';
import type { DynamicModule } from '@nestjs/common';
import type { Handler } from '../application/handler-registry.js';
import type { AuditRecorder, Clock, IdentifierFactory } from '../application/ports.js';
import type { PrincipalResolver } from '../api/scoring.controller.js';
import { ScoringModule } from '../api/scoring.module.js';
import { PostgresScoreRecordRepository } from '../infrastructure/score-record.repository.js';
import { PostgresRescoringOperationRepository } from '../infrastructure/rescoring-operation.repository.js';
import { ScoringOutboxEmitter } from '../infrastructure/outbox-emitter.js';
import { ScoreAttemptHandler, type EventPublisher } from '../application/handlers/scoring-handlers.js';
import {
  ApproveRescoringHandler,
  DraftRescoringHandler,
  ExecuteRescoringHandler,
  RunRescoringDryRunHandler,
  type RescoringEventPublisher,
} from '../application/handlers/rescoring-handlers.js';
import {
  GetRescoringDryRunHandler,
  GetScoreRecordHandler,
  ListScoreRecordGenerationsHandler,
} from '../application/queries/scoring-queries.js';
import type { AttemptScored, AttemptsRescored } from '../domain/events/scoring-events.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015). See `contexts/content/public/composition.ts`
 * for the fuller explanation this file follows exactly.
 *
 * **`PostgresScoreRecordRepository` needs no per-profile context** (ADR-0017)
 * — the pin rides on the record it saves and loads, so one instance is
 * correct for every exam profile, the same as every other repository here.
 *
 * **`PostgresEventPublisher` is a real, durable adapter with one named
 * limitation.** `ScoringOutboxEmitter.emit(client, event)` needs the same
 * transaction the aggregate was saved in — that is §9 rule 4's whole point —
 * but `EventPublisher.publish(event)` is not given that transaction; no
 * milestone through M0 wires a handler's own save and its event publish
 * through one connection. This adapter opens its own short transaction per
 * publish instead: the event is durably written to `platform.outbox_message`,
 * but not atomically with the score record it describes. A crash between the
 * two leaves a score with no event; the relay (D17, closed) delivers events and
 * does not reconcile scores against them, which remains this adapter's limit.
 */
export interface ScoringCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
}

const REQUIRED_DEPS_KEYS = [
  'pool',
  'clock',
  'identifiers',
  'audit',
  'principals',
] as const satisfies readonly (keyof ScoringCompositionDeps)[];

export class PostgresEventPublisher implements EventPublisher, RescoringEventPublisher {
  readonly #pool: Pool;
  readonly #emitter = new ScoringOutboxEmitter();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async publish(event: AttemptScored | AttemptsRescored): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await this.#emitter.emit(client, event);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function register(deps: ScoringCompositionDeps): DynamicModule {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`scoring composition is missing required dependency: ${key}`);
    }
  }

  const records = new PostgresScoreRecordRepository(deps.pool);
  const operations = new PostgresRescoringOperationRepository(deps.pool);
  const events = new PostgresEventPublisher(deps.pool);

  const bag = {
    records,
    operations,
    events,
    clock: deps.clock,
    identifiers: deps.identifiers,
    audit: deps.audit,
  };

  const handlers = [
    new ScoreAttemptHandler(bag),
    new DraftRescoringHandler(bag),
    new RunRescoringDryRunHandler(bag),
    new ApproveRescoringHandler(bag),
    new ExecuteRescoringHandler(bag),
    new GetScoreRecordHandler(records),
    new ListScoreRecordGenerationsHandler(records),
    new GetRescoringDryRunHandler(operations),
  ] as unknown as readonly Handler<never, unknown>[];

  return ScoringModule.register({ handlers, principals: deps.principals });
}

/**
 * What the assessment context consumes from scoring (M6-40): the handler that scores an attempt, and the read of a score record.
 * Both are built from the same assembly `register` uses — the same repository, the same publisher — so a score the consumer
 * makes is the score the routes read. `AnswerKeyData` is what crosses into scoring and nothing else of an item does.
 */
export interface ScoringForAssessment {
  readonly scoreAttempt: ScoreAttemptHandler;
  readonly scoreRecord: GetScoreRecordHandler;
}

export function scoringForAssessment(deps: ScoringCompositionDeps): ScoringForAssessment {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`scoring composition is missing required dependency: ${key}`);
    }
  }
  const records = new PostgresScoreRecordRepository(deps.pool);
  return {
    scoreAttempt: new ScoreAttemptHandler({
      records,
      events: new PostgresEventPublisher(deps.pool),
      clock: deps.clock,
      identifiers: deps.identifiers,
      audit: deps.audit,
    }),
    scoreRecord: new GetScoreRecordHandler(records),
  };
}
