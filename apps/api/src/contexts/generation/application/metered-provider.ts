import { err, ok, type Result } from '../domain/result.js';
import { versionsNotEvaluated, type SubjectKind } from '../domain/evaluation-run.js';
import { createSpendEntry, type SpendKind, type TokenUsage } from '../domain/ai-spend.js';
import type { AISpendLedger, EvaluationRunRepository, GenerationRunRepository } from '../domain/repository-ports.js';
import { applicationError, fromGeneration, type ApplicationError } from './authorization.js';
import type {
  BudgetScope,
  Clock,
  IdentifierFactory,
  JudgementProvider,
  JudgementRequest,
  JudgementResponse,
  ProposalProvider,
  ProposalRequest,
  ProposalResponse,
} from './ports.js';

export interface MeteredProviderDependencies {
  readonly inner: ProposalProvider & JudgementProvider;
  readonly runs: GenerationRunRepository;
  readonly ledger: AISpendLedger;
  readonly evaluations: EvaluationRunRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
}

/**
 * **The meter every provider call goes through** (M5-42, F32, AI-ARCHITECTURE §14).
 *
 * It wraps the provider the context was composed with — the root hands handlers and
 * checks *this*, never the adapter — and does two things around each call:
 *
 *   - **Before dispatch, it checks the versions the call names have a passing evaluation (F31)** and
 *     **the call's budget scope.** The scope names a
 *     run; the run holds its reservation (M5-41); what the run has consumed is a
 *     sum over the ledger. A call is refused, and the provider never reached, when
 *     the scope names a run that does not exist or one that has already consumed all
 *     it reserved. ("Budget checked at enqueue" decides whether a run starts; this is
 *     the other half — a run cannot spend past what it reserved — and it is checked
 *     before the call, not after billing.)
 *   - **After a successful call, it appends what the call consumed to the ledger**,
 *     under the model and prompt version the call ran under. A call whose spend
 *     cannot be recorded is *not returned*: an interaction with no ledger row is
 *     spend nobody can account for, and an answer that cost something unrecorded is
 *     worth less than the books agreeing. The tokens are spent either way; this keeps
 *     them from being invisible.
 *
 * **A failed call is not recorded.** A provider that is unavailable consumed
 * nothing the ledger could attribute, and an entry for it would be a guess.
 *
 * **One call may cross the line.** The cost of a call is known only after it, so the
 * check is "has the run consumed everything it reserved", not "will this call fit":
 * the call that takes a run past its reservation is allowed, recorded, and the next
 * one refused. The overshoot is bounded by one call (D50).
 */
export class MeteredProvider implements ProposalProvider, JudgementProvider {
  constructor(private readonly deps: MeteredProviderDependencies) {}

  propose(request: ProposalRequest): Promise<Result<ProposalResponse, ApplicationError>> {
    return this.#metered(
      request.budgetScope,
      'propose',
      request.pin.modelVersionId,
      request.pin.promptVersionId,
      () => this.deps.inner.propose(request),
    );
  }

  judge(request: JudgementRequest): Promise<Result<JudgementResponse, ApplicationError>> {
    return this.#metered(request.budgetScope, 'judge', request.modelVersionId, request.promptVersionId, () =>
      this.deps.inner.judge(request),
    );
  }

  async #metered<T extends { readonly usage: TokenUsage }>(
    scope: BudgetScope,
    kind: SpendKind,
    modelVersionId: string,
    promptVersionId: string,
    call: () => Promise<Result<T, ApplicationError>>,
  ): Promise<Result<T, ApplicationError>> {
    const run = await this.deps.runs.findById(scope.runId);
    if (!run.ok) {
      return err(
        applicationError(
          'PreconditionFailed',
          'BUDGET_SCOPE_UNKNOWN_RUN',
          `the call is charged to run ${scope.runId}, which has no reservation to spend from`,
          'budgetScope',
        ),
      );
    }

    // F31 at the call, not only at the run: a judged check names a model and a prompt of its own, in
    // configuration, and naming a version in a call is activating it just as naming one in a run is.
    const unevaluated: { kind: SubjectKind; versionId: string }[] = [];
    for (const version of [
      { kind: 'model' as const, versionId: modelVersionId },
      { kind: 'prompt' as const, versionId: promptVersionId },
    ]) {
      const passing = await this.deps.evaluations.hasPassing(version.kind, version.versionId);
      if (!passing.ok) return err(fromGeneration(passing.error));
      if (!passing.value) unevaluated.push(version);
    }
    if (unevaluated.length > 0) return err(fromGeneration(versionsNotEvaluated(unevaluated)));

    const spent = await this.deps.ledger.spentByRun(scope.runId);
    if (!spent.ok) return err(fromGeneration(spent.error));
    if (spent.value >= run.value.budgetTokens) {
      return err(
        applicationError(
          'PreconditionFailed',
          'RUN_BUDGET_EXHAUSTED',
          `run ${scope.runId} has consumed ${spent.value} of the ${run.value.budgetTokens} tokens it reserved, so no further call is made`,
          'budgetScope',
        ),
      );
    }

    const answered = await call();
    if (!answered.ok) return answered;

    const entry = createSpendEntry({
      ledgerId: this.deps.identifiers.next(),
      feature: scope.feature,
      runId: scope.runId,
      modelVersionId,
      promptVersionId,
      kind,
      usage: answered.value.usage,
      occurredAt: this.deps.clock.now().toISOString(),
    });
    if (!entry.ok) return err(fromGeneration(entry.error));

    const recorded = await this.deps.ledger.append(entry.value);
    if (!recorded.ok) {
      return err(
        applicationError(
          'Unavailable',
          'SPEND_NOT_RECORDED',
          'the provider answered but its spend could not be recorded, so the answer is not used',
          undefined,
          { runId: scope.runId, cause: recorded.error.code, reason: recorded.error.message },
        ),
      );
    }
    return ok(answered.value);
  }
}
