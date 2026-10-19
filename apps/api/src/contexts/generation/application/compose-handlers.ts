import type { AIBudgetRepository, EvaluationRunRepository, GenerationCandidateRepository, GenerationRunRepository } from '../domain/repository-ports.js';
import { HandlerRegistry, type Handler } from './handler-registry.js';
import type { AuditRecorder, Clock, ContentAuthoring, IdentifierFactory, ProposalProvider } from './ports.js';
import { DeclareAIBudgetHandler, RecordEvaluationRunHandler, StartGenerationRunHandler } from './handlers/run-handlers.js';
import { AcceptCandidateHandler, DisposeCandidateHandler, RejectCandidateHandler } from './handlers/decision-handlers.js';
import { RunPrecheckBatteryHandler } from './handlers/battery-handlers.js';
import type { BlockedPrecheck, PrecheckRunner } from './prechecks/battery.js';
import { ProposeCandidateHandler } from './handlers/propose-handlers.js';
import { RecordPrecheckVerdictHandler } from './handlers/verdict-handlers.js';
import { GetCandidateHandler, ListRunCandidatesHandler } from './queries/candidate-queries.js';

/** Everything the context's handlers need from outside it. */
export interface GenerationDependencies {
  readonly runs: GenerationRunRepository;
  readonly budgets: AIBudgetRepository;
  readonly evaluations: EvaluationRunRepository;
  readonly candidates: GenerationCandidateRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  /** The provider port; the composition root supplies an adapter, and nothing in here knows which. */
  readonly provider: ProposalProvider;
  /** The checks that can run, and the ones declared unrunnable. Every check in the vocabulary is one or the other. */
  readonly runners: readonly PrecheckRunner[];
  readonly blocked: readonly BlockedPrecheck[];
  /** Content's authoring, supplied by the composition root; generation holds no write capability of its own. */
  readonly content: ContentAuthoring;
}

/**
 * Builds every handler the context declares and registers them all through the
 * one registry, so a handler without a policy fails here, at boot, and not when
 * somebody first calls it. The composition root (Track F) calls this; nothing
 * else constructs a handler.
 */
export function composeGenerationHandlers(deps: GenerationDependencies): HandlerRegistry {
  const recordVerdict = new RecordPrecheckVerdictHandler(deps);
  const dispose = new DisposeCandidateHandler(deps);
  const handlers: readonly Handler<never, unknown>[] = [
    new StartGenerationRunHandler(deps),
    new DeclareAIBudgetHandler(deps),
    new RecordEvaluationRunHandler(deps),
    new ProposeCandidateHandler(deps),
    recordVerdict,
    new RunPrecheckBatteryHandler({ ...deps, recordVerdict, dispose }),
    dispose,
    new AcceptCandidateHandler(deps),
    new RejectCandidateHandler(deps),
    new GetCandidateHandler(deps),
    new ListRunCandidatesHandler(deps),
  ];
  return HandlerRegistry.of(handlers);
}
