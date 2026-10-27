import type { Pool } from 'pg';
import type { DynamicModule } from '@nestjs/common';
import type { Handler } from '../application/handler-registry.js';
import type { AuditRecorder, Clock, IdentifierFactory } from '../application/ports.js';
import type { PrincipalResolver } from '../api/scoring.controller.js';
import { ScoringModule } from '../api/scoring.module.js';
import { PostgresScoreRecordRepository } from '../infrastructure/score-record.repository.js';
import { PostgresRescoringOperationRepository } from '../infrastructure/rescoring-operation.repository.js';
import { ScoreAttemptHandler } from '../application/handlers/scoring-handlers.js';
import {
  ApproveRescoringHandler,
  DraftRescoringHandler,
  ExecuteRescoringHandler,
  RunRescoringDryRunHandler,
} from '../application/handlers/rescoring-handlers.js';
import {
  GetAttemptOutcomesHandler,
  GetRescoringDryRunHandler,
  GetScoreRecordHandler,
  ListScoreRecordGenerationsHandler,
} from '../application/queries/scoring-queries.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015). See `contexts/content/public/composition.ts`
 * for the fuller explanation this file follows exactly.
 *
 * **`PostgresScoreRecordRepository` needs no per-profile context** (ADR-0017)
 * — the pin rides on the record it saves and loads, so one instance is
 * correct for every exam profile, the same as every other repository here.
 *
 * **There is no event publisher.** A score record and its `AttemptScored` event are written by
 * `PostgresScoreRecordRepository.save(record, event)` on one connection in one transaction, and a re-score's completion
 * and `AttemptsRescored` by `PostgresRescoringOperationRepository.save(operation, event)` the same way (DEC-M7-6). An
 * earlier adapter opened a second transaction per event, which left a crash window between the two commits: a score with
 * no event, which Learning would never hear about and the dead-letter queue could not show.
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

export function register(deps: ScoringCompositionDeps): DynamicModule {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`scoring composition is missing required dependency: ${key}`);
    }
  }

  const records = new PostgresScoreRecordRepository(deps.pool);
  const operations = new PostgresRescoringOperationRepository(deps.pool);

  const bag = {
    records,
    operations,
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
      clock: deps.clock,
      identifiers: deps.identifiers,
      audit: deps.audit,
    }),
    scoreRecord: new GetScoreRecordHandler(records),
  };
}

/**
 * What the learning context consumes from scoring (M7-02, DEC-M7-1): the per-slot outcomes of one attempt, and nothing more.
 * Learning reads the owning context rather than trusting a copy of its facts in an event, and this is the one door it reads
 * through. Adding a second handler here is a deliberate change to what Learning may ask of scoring, and is reviewed as one.
 */
export interface ScoringForLearning {
  readonly outcomesForAttempt: GetAttemptOutcomesHandler;
}

export function scoringForLearning(deps: ScoringCompositionDeps): ScoringForLearning {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`scoring composition is missing required dependency: ${key}`);
    }
  }
  return { outcomesForAttempt: new GetAttemptOutcomesHandler(new PostgresScoreRecordRepository(deps.pool)) };
}
