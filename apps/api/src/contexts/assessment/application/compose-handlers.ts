import { HandlerRegistry } from './handler-registry.js';
import {
  CreateAttemptHandler,
  GetAttemptHandler,
  GetAttemptResultHandler,
  IngestResponseEventsHandler,
  StartAttemptHandler,
  SubmitAttemptHandler,
  type AttemptDependencies,
} from './handlers/attempt-handlers.js';
import { AssembleDraftFormHandler, GetFormHandler, PublishFormHandler, ScheduleFormHandler, type FormDependencies } from './handlers/form-handlers.js';
import { GetPracticeFeedbackHandler, type PracticeFeedbackDependencies } from './handlers/practice-feedback-handler.js';
import { CreatePracticeAttemptHandler, GrowPracticeAttemptHandler, type PracticeDependencies } from './handlers/practice-handlers.js';
import { GetFormPackageHandler, GetPackageSigningKeyHandler, type PackageDependencies } from './handlers/package-handler.js';
import { SubmitExpiredAttemptsHandler, type ExpiryDependencies } from './handlers/expiry-handler.js';
import { SweepWindowsHandler, type SweepDependencies } from './handlers/sweep-handler.js';

export type AssessmentDependencies = FormDependencies & SweepDependencies & PackageDependencies & AttemptDependencies & ExpiryDependencies & PracticeDependencies & PracticeFeedbackDependencies;

/**
 * Builds the registry. A handler without a policy throws here (F36), so a
 * context whose handlers are unguarded never reaches the module and the
 * application does not boot.
 */
export function composeAssessmentHandlers(deps: AssessmentDependencies): HandlerRegistry {
  return HandlerRegistry.of([
    new AssembleDraftFormHandler(deps),
    new PublishFormHandler(deps),
    new ScheduleFormHandler(deps),
    new GetFormHandler(deps),
    new GetFormPackageHandler(deps),
    new GetPackageSigningKeyHandler(deps),
    new SweepWindowsHandler(deps),
    new SubmitExpiredAttemptsHandler(deps),
    new CreateAttemptHandler(deps),
    new StartAttemptHandler(deps),
    new GetAttemptHandler(deps),
    new GetAttemptResultHandler(deps),
    new IngestResponseEventsHandler(deps),
    new SubmitAttemptHandler(deps),
    new CreatePracticeAttemptHandler(deps),
    new GrowPracticeAttemptHandler(deps),
    new GetPracticeFeedbackHandler(deps),
  ] as never);
}
