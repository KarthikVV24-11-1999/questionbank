import { GENERATION_FEATURE, createAIBudget, type AIBudget } from '../../domain/ai-budget.js';
import { evaluate, versionsNotEvaluated, type EvaluationRun, type SubjectKind } from '../../domain/evaluation-run.js';
import { err, ok, type Result } from '../../domain/result.js';
import { createGenerationRun, type GenerationRun } from '../../domain/generation-run.js';
import type { AIBudgetRepository, EvaluationRunRepository, GenerationRunRepository } from '../../domain/repository-ports.js';
import { authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { DeclareAIBudget, RecordEvaluationRun, StartGenerationRun } from '../commands/generation-commands.js';
import type { Handler } from '../handler-registry.js';
import { DECLARE_AI_BUDGET_POLICY, RECORD_EVALUATION_RUN_POLICY, START_GENERATION_RUN_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';

export interface RunDependencies {
  readonly runs: GenerationRunRepository;
  readonly evaluations: EvaluationRunRepository;
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
 * **A version with no passing evaluation run is not activated** (M5-43, F31): a run naming one is
 * refused, naming it, before the budget is consulted.
 *
 * **A run is admitted against its period's budget before it is written** (M5-41):
 * one that would not fit, or that has no budget declared to fit in, is refused with
 * the figures, and nothing is spent or recorded.
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
      budgetTokens: command.budgetTokens,
    });
    if (!run.ok) return err(fromGeneration(run.error));

    // F31: naming a version in a run is what activates it — checked once the command is known to be well formed,
    // so a blank id is a validation failure and not a version nobody evaluated — and a version with no passing evaluation run
    // does not activate. Refused here, naming it; the database refuses it too (a trigger on the run), so
    // a path that skipped this check could not activate anything either.
    const unevaluated: { kind: SubjectKind; versionId: string }[] = [];
    for (const version of [
      { kind: 'model' as const, versionId: run.value.pin.modelVersionId },
      { kind: 'prompt' as const, versionId: run.value.pin.promptVersionId },
    ]) {
      const passing = await this.deps.evaluations.hasPassing(version.kind, version.versionId);
      if (!passing.ok) return err(fromGeneration(passing.error));
      if (!passing.value) unevaluated.push(version);
    }
    if (unevaluated.length > 0) return err(fromGeneration(versionsNotEvaluated(unevaluated)));

    // Enqueue is the enforcement point (M5-41, DEC-M5-9): the budget decides here, in the
    // transaction that writes the run, so a run that does not fit is never written and
    // nothing downstream can start it.
    const saved = await this.deps.runs.saveWithinBudget(run.value, GENERATION_FEATURE);
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

export interface BudgetDependencies {
  readonly budgets: AIBudgetRepository;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

/**
 * Declares a period's ceiling. It is the one way a budget comes to exist, so a
 * budget always has a named declarer and a time, and the table's own rules make it
 * permanent: there is no edit, and a second declaration for a period is a conflict
 * (D48).
 */
export class DeclareAIBudgetHandler implements Handler<DeclareAIBudget, AIBudget> {
  readonly name = 'DeclareAIBudget';
  readonly policy = DECLARE_AI_BUDGET_POLICY;

  constructor(private readonly deps: BudgetDependencies) {}

  async handle(command: DeclareAIBudget, context: ApplicationContext): Promise<Result<AIBudget, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const budget = createAIBudget({ feature: command.feature, period: command.period, ceilingTokens: command.ceilingTokens });
    if (!budget.ok) return err(fromGeneration(budget.error));

    const at = this.deps.clock.now();
    const saved = await this.deps.budgets.declare(budget.value, context.principal, at.toISOString());
    if (!saved.ok) return err(fromGeneration(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'AIBudget',
      targetId: `${budget.value.feature}:${budget.value.period}`,
      correlationId: context.correlationId,
      occurredAt: at,
    });
    return ok(saved.value);
  }
}

export interface EvaluationDependencies {
  readonly evaluations: EvaluationRunRepository;
  readonly identifiers: IdentifierFactory;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

/**
 * Records an evaluation of a model or prompt version (M5-43, F31).
 *
 * The outcome is **derived here by the domain**, from the scores and the baseline, and stored with the
 * regressions that decided it. A caller supplies measurements; it cannot supply a verdict. A regression is
 * stored as `fail` — which the activation gate does not accept — and not as a pass with a warning beside it
 * (AI-ARCHITECTURE §14: regression blocks promotion).
 */
export class RecordEvaluationRunHandler implements Handler<RecordEvaluationRun, EvaluationRun> {
  readonly name = 'RecordEvaluationRun';
  readonly policy = RECORD_EVALUATION_RUN_POLICY;

  constructor(private readonly deps: EvaluationDependencies) {}

  async handle(command: RecordEvaluationRun, context: ApplicationContext): Promise<Result<EvaluationRun, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    let baseline: EvaluationRun | undefined;
    if (command.baselineRunId !== undefined) {
      const found = await this.deps.evaluations.findById(command.baselineRunId);
      if (!found.ok) return err(fromGeneration(found.error));
      baseline = found.value;
    }

    const at = this.deps.clock.now();
    const evaluated = evaluate({
      evaluationRunId: this.deps.identifiers.next(),
      subject: command.subject,
      corpus: command.corpus,
      scores: command.scores,
      ...(baseline === undefined ? {} : { baseline }),
      evaluatedAt: at.toISOString(),
    });
    if (!evaluated.ok) return err(fromGeneration(evaluated.error));

    const saved = await this.deps.evaluations.save(evaluated.value, context.principal);
    if (!saved.ok) return err(fromGeneration(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'EvaluationRun',
      targetId: saved.value.evaluationRunId,
      correlationId: context.correlationId,
      occurredAt: at,
    });
    return ok(saved.value);
  }
}
