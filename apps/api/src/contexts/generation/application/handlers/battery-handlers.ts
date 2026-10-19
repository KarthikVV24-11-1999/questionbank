import { err, ok, type Result } from '../../domain/result.js';
import type { GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import { PRECHECKS } from '../../domain/precheck-vocabulary.js';
import { applicationError, authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { DisposeCandidate, RecordPrecheckVerdict, RunPrecheckBattery } from '../commands/generation-commands.js';
import type { Handler } from '../handler-registry.js';
import { RUN_PRECHECK_BATTERY_POLICY } from '../policies.js';
import type { Disposition } from './decision-handlers.js';
import type { ApplicationContext, AuditRecorder, Clock } from '../ports.js';
import type { BatteryReport, BlockedPrecheck, CheckReport, DispositionReport, PrecheckRunner } from '../prechecks/battery.js';

export interface BatteryDependencies {
  readonly candidates: GenerationCandidateRepository;
  /** The real `RecordPrecheckVerdict` handler: the battery records through the same boundary everything else does. */
  readonly recordVerdict: Handler<RecordPrecheckVerdict, GenerationCandidate>;
  /** The real `DisposeCandidate` handler: what the pipeline does with the result, through the boundary it always uses. */
  readonly dispose: Handler<DisposeCandidate, Disposition>;
  readonly runners: readonly PrecheckRunner[];
  readonly blocked: readonly BlockedPrecheck[];
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

function describeError(error: ApplicationError): { code: string; message: string } {
  return { code: error.code, message: error.message };
}

/**
 * Runs every check that can run against a proposed candidate and records each
 * result — one verdict per check, through `RecordPrecheckVerdict`, so the
 * vocabulary is enforced at the boundary, the audit trail is written, and a
 * second verdict for a check is the `Conflict` it has always been.
 *
 * **It is idempotent by construction.** A check the candidate already has a
 * verdict for is not run again: a re-run of the battery after a partial failure
 * fills the gaps and leaves every earlier verdict standing, so it can never
 * write two for the same check or let a later pass sit beside an earlier fail.
 *
 * **It records only what ran.** A check that cannot run — blocked, or hit a
 * provider failure — records nothing and is reported as such. The report always
 * has one line per check in the vocabulary, so a check is never silently
 * missing from it.
 *
 * A verdict records the check, outcome and reasoning but not the registry rows of
 * the prompt that produced it (debt D44).
 *
 * **It then acts on the result (M5-40, ADR-0029)**, through `DisposeCandidate`:
 * every blocking check passed → the candidate is accepted into a draft awaiting a
 * reviewer; a blocking check failed → it is rejected, terminally; a check that has
 * not run → nothing, and the report says `undecided`. It decides nothing itself —
 * whether the candidate may be accepted is `acceptCandidate`'s, from the verdicts —
 * and a disposition that fails does not undo the verdicts: they stand, and the
 * report carries the failure.
 */
export class RunPrecheckBatteryHandler implements Handler<RunPrecheckBattery, BatteryReport> {
  readonly name = 'RunPrecheckBattery';
  readonly policy = RUN_PRECHECK_BATTERY_POLICY;

  constructor(private readonly deps: BatteryDependencies) {}

  async handle(command: RunPrecheckBattery, context: ApplicationContext): Promise<Result<BatteryReport, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findById(command.candidateId);
    if (!found.ok) return err(fromGeneration(found.error));
    const candidate = found.value;

    if (candidate.state !== 'proposed') {
      return err(
        applicationError(
          'RuleViolation',
          'VERDICT_CANDIDATE_NOT_PROPOSED',
          `the battery runs on a proposed candidate, and this one is ${candidate.state}`,
          'state',
        ),
      );
    }

    const recordedChecks = new Set<string>(candidate.verdicts.map((verdict) => verdict.check));
    const checks: CheckReport[] = [];

    for (const { id: check, severity } of PRECHECKS) {
      const base = { check, severity };

      if (recordedChecks.has(check)) {
        checks.push({ ...base, status: 'already_recorded' });
        continue;
      }

      const blocked = this.deps.blocked.find((entry) => entry.check === check);
      if (blocked !== undefined) {
        checks.push({ ...base, status: 'blocked', blocked: { reason: blocked.reason, successor: blocked.successor } });
        continue;
      }

      const runner = this.deps.runners.find((entry) => entry.check === check);
      if (runner === undefined) {
        checks.push({ ...base, status: 'unaccounted' });
        continue;
      }

      checks.push(await this.#runOne(base, runner, candidate, context));
    }

    const disposition = await this.#dispose(candidate.candidateId, context);

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'GenerationCandidate',
      targetId: candidate.candidateId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok({ candidateId: candidate.candidateId, checks, disposition });
  }

  async #dispose(candidateId: string, context: ApplicationContext): Promise<DispositionReport> {
    let disposed: Awaited<ReturnType<Handler<DisposeCandidate, Disposition>['handle']>>;
    try {
      disposed = await this.deps.dispose.handle({ candidateId }, context);
    } catch (error) {
      return { status: 'failed', error: { code: 'DISPOSE_RAISED', message: error instanceof Error ? error.message : String(error) } };
    }
    if (!disposed.ok) return { status: 'failed', error: describeError(disposed.error) };
    switch (disposed.value.disposition) {
      case 'accept':
        return { status: 'accepted', contentItemId: disposed.value.contentItemId! };
      case 'reject':
        return { status: 'rejected' };
      case 'undecided':
        return { status: 'undecided' };
    }
  }

  async #runOne(
    base: Pick<CheckReport, 'check' | 'severity'>,
    runner: PrecheckRunner,
    candidate: GenerationCandidate,
    context: ApplicationContext,
  ): Promise<CheckReport> {
    let result: Awaited<ReturnType<PrecheckRunner['run']>>;
    try {
      result = await runner.run(candidate, context);
    } catch (error) {
      // A check that raises has not produced a result, which is the same as
      // one that could not run: nothing is recorded, and the rest still run.
      return {
        ...base,
        status: 'could_not_run',
        error: { code: 'CHECK_RAISED', message: error instanceof Error ? error.message : String(error) },
      };
    }
    if (!result.ok) return { ...base, status: 'could_not_run', error: describeError(result.error) };

    const recorded = await this.deps.recordVerdict.handle(
      {
        candidateId: candidate.candidateId,
        check: base.check,
        outcome: result.value.outcome,
        ...(result.value.detail === undefined ? {} : { detail: result.value.detail }),
      },
      context,
    );
    if (!recorded.ok) return { ...base, status: 'could_not_record', error: describeError(recorded.error) };

    return {
      ...base,
      status: 'recorded',
      outcome: result.value.outcome,
      ...(result.value.detail === undefined ? {} : { detail: result.value.detail }),
    };
  }
}
