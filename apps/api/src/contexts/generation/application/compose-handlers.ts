import type { GenerationCandidateRepository, GenerationRunRepository } from '../domain/repository-ports.js';
import { HandlerRegistry, type Handler } from './handler-registry.js';
import type { AuditRecorder, Clock, ContentAuthoring, IdentifierFactory } from './ports.js';
import { StartGenerationRunHandler } from './handlers/run-handlers.js';
import { AcceptCandidateHandler, RejectCandidateHandler } from './handlers/decision-handlers.js';
import { RecordPrecheckVerdictHandler } from './handlers/verdict-handlers.js';
import { GetCandidateHandler, ListRunCandidatesHandler } from './queries/candidate-queries.js';

/** Everything the context's handlers need from outside it. */
export interface GenerationDependencies {
  readonly runs: GenerationRunRepository;
  readonly candidates: GenerationCandidateRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
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
  const handlers: readonly Handler<never, unknown>[] = [
    new StartGenerationRunHandler(deps),
    new RecordPrecheckVerdictHandler(deps),
    new AcceptCandidateHandler(deps),
    new RejectCandidateHandler(deps),
    new GetCandidateHandler(deps),
    new ListRunCandidatesHandler(deps),
  ];
  return HandlerRegistry.of(handlers);
}
