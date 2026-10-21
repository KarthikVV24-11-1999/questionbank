import { HandlerRegistry } from './handler-registry.js';
import { AssembleDraftFormHandler, GetFormHandler, PublishFormHandler, ScheduleFormHandler, type FormDependencies } from './handlers/form-handlers.js';
import { GetFormPackageHandler, GetPackageSigningKeyHandler, type PackageDependencies } from './handlers/package-handler.js';
import { SweepWindowsHandler, type SweepDependencies } from './handlers/sweep-handler.js';

export type AssessmentDependencies = FormDependencies & SweepDependencies & PackageDependencies;

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
  ] as never);
}
