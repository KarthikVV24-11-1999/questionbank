import { assembleForm, type AssemblyError } from '../../domain/assembly.js';
import { BLUEPRINT_ITEM_TYPES, createBlueprint } from '../../domain/blueprint.js';
import { createForm } from '../../domain/form.js';
import type { FormRepository } from '../../domain/repository-ports.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, fromAssessment, type ApplicationError } from '../authorization.js';
import type { AssembleDraftForm, GetForm, PublishForm, ScheduleForm } from '../commands/form-commands.js';
import type { Handler } from '../handler-registry.js';
import { ASSEMBLE_DRAFT_FORM_POLICY, GET_FORM_POLICY, PUBLISH_FORM_POLICY, SCHEDULE_FORM_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock, FormCorpus, IdentifierFactory } from '../ports.js';
import { toFormView, type FormView } from '../views.js';

export interface FormDependencies {
  readonly forms: FormRepository;
  readonly corpus: FormCorpus;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

async function record(deps: FormDependencies, context: ApplicationContext, action: string, formId: string): Promise<void> {
  await deps.audit.record({
    principal: context.principal,
    action,
    targetContext: 'assessment',
    targetType: 'form',
    targetId: formId,
    correlationId: context.correlationId,
    occurredAt: deps.clock.now(),
  });
}

/**
 * An assembly that could not be done is reported as one of two **different**
 * things, because they ask different things of the operator:
 *
 *  - `ASSEMBLY_INFEASIBLE` — no arrangement of the eligible items satisfies the
 *    named constraint. Asking again changes nothing; the blueprint or the pool
 *    has to. Reported as a rule violation (422).
 *  - `ASSEMBLY_SEARCH_EXHAUSTED` — the search gave up at its step budget without
 *    having shown the blueprint impossible. Asking again with a larger budget
 *    might succeed. Reported as unavailable and retryable (503).
 *
 * Both carry the constraint that blocked them.
 */
export function fromAssembly(error: AssemblyError): ApplicationError {
  return error.code === 'ASSEMBLY_SEARCH_EXHAUSTED'
    ? applicationError('Unavailable', error.code, error.message, error.location, { constraint: error.constraint })
    : applicationError('RuleViolation', error.code, error.message, error.location, { constraint: error.constraint });
}

export interface AssembledDraft {
  readonly form: FormView;
  /** How well the soft constraints were met. A miss here does not make the form invalid. */
  readonly soft: { readonly difficultyShortfall: number; readonly withinDifficultyTolerance: boolean; readonly distinctConcepts: number; readonly meanExposure: number };
  /** Published item versions content could not certify duplicate-free, left out of the pool (D55). */
  readonly unevaluated: readonly string[];
}

export class AssembleDraftFormHandler implements Handler<AssembleDraftForm, AssembledDraft> {
  readonly name = 'AssembleDraftForm';
  readonly policy = ASSEMBLE_DRAFT_FORM_POLICY;

  constructor(private readonly deps: FormDependencies) {}

  async handle(command: AssembleDraftForm, context: ApplicationContext): Promise<Result<AssembledDraft, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const blueprint = createBlueprint(command.blueprint);
    if (!blueprint.ok) return err(fromAssessment(blueprint.error));

    const loaded = await this.deps.corpus.load(
      {
        ...(command.subject === undefined ? {} : { subject: command.subject }),
        itemTypes: BLUEPRINT_ITEM_TYPES.filter((type) => blueprint.value.sections.some((section) => (section.typeMix[type] ?? 0) > 0)),
      },
      context,
    );
    if (!loaded.ok) return err(loaded.error);

    const assembled = assembleForm({
      blueprint: blueprint.value,
      candidates: loaded.value.candidates,
      exposure: loaded.value.exposure,
      nearDuplicates: loaded.value.nearDuplicates,
      // Called once per slot, when the finished form is laid out: the search itself names no slot.
      newSlotId: () => this.deps.identifiers.next(),
      ...(command.maxSteps === undefined ? {} : { maxSteps: command.maxSteps }),
    });
    if (!assembled.ok) return err(fromAssembly(assembled.error));

    const form = createForm({
      formId: this.deps.identifiers.next(),
      examProfileVersionId: blueprint.value.examProfileVersionId,
      formType: blueprint.value.formType,
      sessionRefs: command.sessionRefs,
      blueprintConformance: { satisfied: true, ...assembled.value.soft },
      sections: assembled.value.sections,
    });
    if (!form.ok) return err(fromAssessment(form.error));

    const saved = await this.deps.forms.save(form.value);
    if (!saved.ok) return err(fromAssessment(saved.error));

    await record(this.deps, context, 'AssembleDraftForm', saved.value.formId);
    return ok(Object.freeze({ form: toFormView(saved.value), soft: assembled.value.soft, unevaluated: loaded.value.unevaluated }));
  }
}

export class PublishFormHandler implements Handler<PublishForm, FormView> {
  readonly name = 'PublishForm';
  readonly policy = PUBLISH_FORM_POLICY;

  constructor(private readonly deps: FormDependencies) {}

  async handle(command: PublishForm, context: ApplicationContext): Promise<Result<FormView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    // The repository's transaction checks the pool, writes the ledger and moves the state, or does none of them.
    const published = await this.deps.forms.publish(command.formId, this.deps.clock.now().toISOString());
    if (!published.ok) return err(fromAssessment(published.error));

    await record(this.deps, context, 'PublishForm', published.value.formId);
    return ok(toFormView(published.value));
  }
}

export class ScheduleFormHandler implements Handler<ScheduleForm, FormView> {
  readonly name = 'ScheduleForm';
  readonly policy = SCHEDULE_FORM_POLICY;

  constructor(private readonly deps: FormDependencies) {}

  async handle(command: ScheduleForm, context: ApplicationContext): Promise<Result<FormView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const scheduled = await this.deps.forms.schedule(
      command.formId,
      { opensAt: command.opensAt, closesAt: command.closesAt },
      this.deps.clock.now().toISOString(),
    );
    if (!scheduled.ok) return err(fromAssessment(scheduled.error));

    await record(this.deps, context, 'ScheduleForm', scheduled.value.formId);
    return ok(toFormView(scheduled.value));
  }
}

export class GetFormHandler implements Handler<GetForm, FormView> {
  readonly name = 'GetForm';
  readonly policy = GET_FORM_POLICY;

  constructor(private readonly deps: Pick<FormDependencies, 'forms'>) {}

  async handle(query: GetForm, context: ApplicationContext): Promise<Result<FormView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const form = await this.deps.forms.findById(query.formId);
    return form.ok ? ok(toFormView(form.value)) : err(fromAssessment(form.error));
  }
}
