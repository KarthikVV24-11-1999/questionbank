import { err, ok, type Result } from '../../domain/result.js';
import { recordVerdict, type GenerationCandidate, type PrecheckVerdict } from '../../domain/generation-candidate.js';
import { isPrecheckId } from '../../domain/precheck-vocabulary.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import { applicationError, authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { RecordPrecheckVerdict } from '../commands/generation-commands.js';
import type { Handler } from '../handler-registry.js';
import { RECORD_PRECHECK_VERDICT_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock } from '../ports.js';

export interface VerdictDependencies {
  readonly candidates: GenerationCandidateRepository;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

/**
 * Turns one check's result into a recorded verdict.
 *
 * **The vocabulary is enforced at this boundary.** A check the battery does not
 * have is refused before the candidate is read, let alone written: the schema
 * would refuse it too, but "the database said no" is a rejection an operator
 * cannot act on, and a producer sending a check that does not exist is a bug
 * worth naming (`check`) rather than a constraint worth catching.
 *
 * Everything else about whether a verdict may be recorded is the domain's —
 * only on a proposed candidate, once per check — and arrives here as a typed
 * failure: a decided candidate is a `RuleViolation` naming its state, a
 * repeated check a `Conflict`.
 */
export class RecordPrecheckVerdictHandler implements Handler<RecordPrecheckVerdict, GenerationCandidate> {
  readonly name = 'RecordPrecheckVerdict';
  readonly policy = RECORD_PRECHECK_VERDICT_POLICY;

  constructor(private readonly deps: VerdictDependencies) {}

  async handle(
    command: RecordPrecheckVerdict,
    context: ApplicationContext,
  ): Promise<Result<GenerationCandidate, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    if (!isPrecheckId(command.check)) {
      return err(
        applicationError('Validation', 'VERDICT_CHECK_UNKNOWN', `"${command.check}" is not one of the pre-checks`, 'check'),
      );
    }

    const found = await this.deps.candidates.findById(command.candidateId);
    if (!found.ok) return err(fromGeneration(found.error));

    const verdict: PrecheckVerdict = {
      check: command.check,
      outcome: command.outcome as PrecheckVerdict['outcome'],
      ...(command.detail === undefined ? {} : { detail: command.detail }),
    };
    const recorded = recordVerdict(found.value, verdict);
    if (!recorded.ok) return err(fromGeneration(recorded.error));

    const saved = await this.deps.candidates.save(recorded.value);
    if (!saved.ok) return err(fromGeneration(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'GenerationCandidate',
      targetId: command.candidateId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(saved.value);
  }
}
