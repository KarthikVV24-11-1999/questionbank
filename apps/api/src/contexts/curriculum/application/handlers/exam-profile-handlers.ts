import { err, ok, type Result } from '../../domain/result.js';
import { Exam } from '../../domain/exam.js';
import {
  ExamProfileVersion,
  type CreateExamProfileVersionProps,
} from '../../domain/exam-profile-version.js';
import { SectionSpec } from '../../domain/section-spec.js';
import { MarkingRuleSet } from '../../domain/value-objects/marking-rule-set.js';
import { NumericAnswerSpec } from '../../domain/value-objects/numeric-answer-spec.js';
import { TimingPolicy } from '../../domain/value-objects/timing-policy.js';
import { NavigationPolicy } from '../../domain/value-objects/navigation-policy.js';
import type { Persisted, RepositoryError } from '../../domain/repository-ports.js';
import type { DrizzleExamRepository } from '../../infrastructure/exam.repository.js';
import type { DrizzleExamProfileVersionRepository } from '../../infrastructure/exam-profile-version.repository.js';
import type { TaxonomyVersionRepository } from '../../domain/repository-ports.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import type {
  CreateExam,
  CreateProfileDraft,
  ProfileDraftContent,
  PublishProfileVersion,
  SupersedeProfileVersion,
  UpdateProfileDraft,
} from '../commands/exam-profile-commands.js';

/** Repository shapes the profile handlers need, named as ports. */
export interface ExamRepositoryPort {
  insert: DrizzleExamRepository['insert'];
  update: DrizzleExamRepository['update'];
  findById: DrizzleExamRepository['findById'];
}

export interface ExamProfileVersionRepositoryPort {
  insert: DrizzleExamProfileVersionRepository['insert'];
  update: DrizzleExamProfileVersionRepository['update'];
  findById: DrizzleExamProfileVersionRepository['findById'];
}

export interface ExamProfileHandlerDependencies {
  readonly exams: ExamRepositoryPort;
  readonly profiles: ExamProfileVersionRepositoryPort;
  readonly versions: TaxonomyVersionRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
}

export interface ProfileWriteResult {
  readonly profileVersionId: string;
  readonly aggregateVersion: number;
}

const PROFILE_AUTHOR = ['exam_owner', 'content_ops'] as const;
const PROFILE_PUBLISHER = ['exam_owner'] as const;

function toApplicationError(error: RepositoryError): ApplicationError {
  return { kind: error.kind, code: error.code, message: error.message };
}

function domainError(error: { kind: string; code: string; message: string }): ApplicationError {
  return {
    kind: error.kind === 'Validation' ? 'Validation' : 'RuleViolation',
    code: error.code,
    message: error.message,
  };
}

/** Builds the value objects a draft is made of, failing on the first problem. */
function composeContent(
  content: ProfileDraftContent,
): Result<
  Pick<
    CreateExamProfileVersionProps,
    | 'sections'
    | 'totalMarks'
    | 'timingPolicy'
    | 'navigationPolicy'
    | 'markingRuleSet'
    | 'toleranceDefault'
    | 'itemTypeAllowances'
  >,
  ApplicationError
> {
  const sections: SectionSpec[] = [];
  for (const props of content.sections) {
    const section = SectionSpec.create(props);
    if (!section.ok) return err(domainError(section.error));
    sections.push(section.value);
  }

  const timing = TimingPolicy.create(content.timingPolicy);
  if (!timing.ok) return err(domainError(timing.error));

  const navigation = NavigationPolicy.create(content.navigationPolicy);
  if (!navigation.ok) return err(domainError(navigation.error));

  const ruleSet = MarkingRuleSet.create(content.markingRuleSet);
  if (!ruleSet.ok) return err(domainError(ruleSet.error));

  let tolerance: NumericAnswerSpec | undefined;
  if (content.toleranceDefault !== undefined) {
    const parsed = NumericAnswerSpec.create(content.toleranceDefault);
    if (!parsed.ok) return err(domainError(parsed.error));
    tolerance = parsed.value;
  }

  return ok({
    sections,
    totalMarks: content.totalMarks,
    timingPolicy: timing.value,
    navigationPolicy: navigation.value,
    markingRuleSet: ruleSet.value,
    ...(tolerance !== undefined ? { toleranceDefault: tolerance } : {}),
    itemTypeAllowances: content.itemTypeAllowances,
  });
}

export class CreateExamHandler implements Handler<CreateExam, { examId: string }> {
  readonly name = 'CreateExam';
  readonly policy = policy('CreateExam', PROFILE_AUTHOR);

  constructor(private readonly deps: ExamProfileHandlerDependencies) {}

  async handle(
    command: CreateExam,
    context: ApplicationContext,
  ): Promise<Result<{ examId: string }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const created = Exam.create({ examId: this.deps.identifiers.next(), ...command });
    if (!created.ok) return err(domainError(created.error));

    const saved = await this.deps.exams.insert(created.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'Exam',
      targetId: created.value.examId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({ examId: created.value.examId });
  }
}

export class CreateProfileDraftHandler implements Handler<CreateProfileDraft, ProfileWriteResult> {
  readonly name = 'CreateProfileDraft';
  readonly policy = policy('CreateProfileDraft', PROFILE_AUTHOR);

  constructor(private readonly deps: ExamProfileHandlerDependencies) {}

  async handle(
    command: CreateProfileDraft,
    context: ApplicationContext,
  ): Promise<Result<ProfileWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const exam = await this.deps.exams.findById(command.examId);
    if (!exam.ok) return err(toApplicationError(exam.error));

    const content = composeContent(command);
    if (!content.ok) return content;

    const draft = ExamProfileVersion.createDraft({
      profileVersionId: this.deps.identifiers.next(),
      examId: command.examId,
      academicYear: command.academicYear,
      taxonomyVersionId: command.taxonomyVersionId,
      ...content.value,
    });
    if (!draft.ok) return err(domainError(draft.error));

    const saved = await this.deps.profiles.insert(draft.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    return ok(await this.recordAudit(saved.value, this.name, context));
  }

  protected async recordAudit(
    saved: Persisted<ExamProfileVersion>,
    action: string,
    context: ApplicationContext,
  ): Promise<ProfileWriteResult> {
    await this.deps.audit.record({
      principal: context.principal,
      action,
      targetContext: 'curriculum',
      targetType: 'ExamProfileVersion',
      targetId: saved.aggregate.profileVersionId,
      targetVersion: saved.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return {
      profileVersionId: saved.aggregate.profileVersionId,
      aggregateVersion: saved.aggregateVersion,
    };
  }
}

export class UpdateProfileDraftHandler implements Handler<UpdateProfileDraft, ProfileWriteResult> {
  readonly name = 'UpdateProfileDraft';
  readonly policy = policy('UpdateProfileDraft', PROFILE_AUTHOR);

  constructor(private readonly deps: ExamProfileHandlerDependencies) {}

  async handle(
    command: UpdateProfileDraft,
    context: ApplicationContext,
  ): Promise<Result<ProfileWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.profiles.findById(command.profileVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const content = composeContent(command);
    if (!content.ok) return content;

    const rebuilt = ExamProfileVersion.createDraft({
      profileVersionId: loaded.value.aggregate.profileVersionId,
      examId: loaded.value.aggregate.examId,
      academicYear: loaded.value.aggregate.academicYear,
      taxonomyVersionId: loaded.value.aggregate.taxonomyVersionId,
      goldenSetValidation: loaded.value.aggregate.goldenSetValidation,
      ...content.value,
    });
    if (!rebuilt.ok) return err(domainError(rebuilt.error));

    if (!loaded.value.aggregate.isMutable) {
      return err({
        kind: 'RuleViolation',
        code: 'PROFILE_NOT_MUTABLE',
        message: `profile version ${command.profileVersionId} is ${loaded.value.aggregate.state}`,
      });
    }

    const saved = await this.deps.profiles.update(rebuilt.value, command.expectedAggregateVersion);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'ExamProfileVersion',
      targetId: saved.value.aggregate.profileVersionId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({
      profileVersionId: saved.value.aggregate.profileVersionId,
      aggregateVersion: saved.value.aggregateVersion,
    });
  }
}

export class PublishProfileVersionHandler implements Handler<PublishProfileVersion, ProfileWriteResult> {
  readonly name = 'PublishProfileVersion';
  readonly policy = policy('PublishProfileVersion', PROFILE_PUBLISHER, true);

  constructor(private readonly deps: ExamProfileHandlerDependencies) {}

  async handle(
    command: PublishProfileVersion,
    context: ApplicationContext,
  ): Promise<Result<ProfileWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.profiles.findById(command.profileVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const taxonomy = await this.deps.versions.findById(loaded.value.aggregate.taxonomyVersionId);
    if (!taxonomy.ok) return err(toApplicationError(taxonomy.error));

    // Every precondition is evaluated before anything is written.
    const published = loaded.value.aggregate.publish({
      taxonomyVersionIsPublished: taxonomy.value.aggregate.state === 'published',
      publishedBy: context.principal,
      publishedAt: this.deps.clock.now(),
    });
    if (!published.ok) return err(domainError(published.error));

    if (command.activate === true) {
      const exam = await this.deps.exams.findById(published.value.examId);
      if (!exam.ok) return err(toApplicationError(exam.error));

      const activated = exam.value.aggregate.activateProfileVersion(
        published.value.academicYear,
        published.value.profileVersionId,
      );
      if (!activated.ok) return err(domainError(activated.error));
    }

    const saved = await this.deps.profiles.update(
      published.value,
      command.expectedAggregateVersion,
      command.activate === true,
    );
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'ExamProfileVersion',
      targetId: saved.value.aggregate.profileVersionId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({
      profileVersionId: saved.value.aggregate.profileVersionId,
      aggregateVersion: saved.value.aggregateVersion,
    });
  }
}

export class SupersedeProfileVersionHandler implements Handler<SupersedeProfileVersion, ProfileWriteResult> {
  readonly name = 'SupersedeProfileVersion';
  readonly policy = policy('SupersedeProfileVersion', PROFILE_PUBLISHER, true);

  constructor(private readonly deps: ExamProfileHandlerDependencies) {}

  async handle(
    command: SupersedeProfileVersion,
    context: ApplicationContext,
  ): Promise<Result<ProfileWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.profiles.findById(command.profileVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const superseded = loaded.value.aggregate.supersede();
    if (!superseded.ok) return err(domainError(superseded.error));

    const saved = await this.deps.profiles.update(superseded.value, command.expectedAggregateVersion);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'ExamProfileVersion',
      targetId: saved.value.aggregate.profileVersionId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({
      profileVersionId: saved.value.aggregate.profileVersionId,
      aggregateVersion: saved.value.aggregateVersion,
    });
  }
}

export function examProfileHandlers(
  deps: ExamProfileHandlerDependencies,
): readonly Handler<never, unknown>[] {
  return [
    new CreateExamHandler(deps),
    new CreateProfileDraftHandler(deps),
    new UpdateProfileDraftHandler(deps),
    new PublishProfileVersionHandler(deps),
    new SupersedeProfileVersionHandler(deps),
  ] as unknown as readonly Handler<never, unknown>[];
}
