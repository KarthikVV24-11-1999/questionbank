import { err, ok, type Result } from '../../domain/result.js';
import { createGenerationRun, type GenerationRun } from '../../domain/generation-run.js';
import type { GenerationRunRepository } from '../../domain/repository-ports.js';
import { authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { StartGenerationRun } from '../commands/generation-commands.js';
import type { Handler } from '../handler-registry.js';
import { START_GENERATION_RUN_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';

export interface RunDependencies {
  readonly runs: GenerationRunRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

/**
 * The first real producer of a `GenerationRun`.
 *
 * **The pin is taken here, once, and written down.** The model and prompt
 * versions are what the caller names in the command, recorded against a run id
 * and a timestamp this handler supplies from its own ports — never read from
 * configuration later (ARCHITECTURE §8), so "prompt v7 had a defect" keeps
 * meaning prompt v7 whatever the deployment is changed to.
 *
 * Nothing here can change a run afterwards. There is no update path in the
 * repository, the table refuses an UPDATE from every role, and a second save of
 * the same run is a `Conflict`.
 */
export class StartGenerationRunHandler implements Handler<StartGenerationRun, GenerationRun> {
  readonly name = 'StartGenerationRun';
  readonly policy = START_GENERATION_RUN_POLICY;

  constructor(private readonly deps: RunDependencies) {}

  async handle(command: StartGenerationRun, context: ApplicationContext): Promise<Result<GenerationRun, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const at = this.deps.clock.now();
    const run = createGenerationRun({
      pin: {
        modelVersionId: command.modelVersionId,
        promptVersionId: command.promptVersionId,
        runId: this.deps.identifiers.next(),
      },
      requestedAt: at.toISOString(),
      request: command.request,
    });
    if (!run.ok) return err(fromGeneration(run.error));

    const saved = await this.deps.runs.save(run.value);
    if (!saved.ok) return err(fromGeneration(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'GenerationRun',
      targetId: run.value.pin.runId,
      correlationId: context.correlationId,
      occurredAt: at,
    });
    return ok(saved.value);
  }
}
