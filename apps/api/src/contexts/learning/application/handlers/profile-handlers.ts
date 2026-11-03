import { ROLES } from '../../../../platform/auth/roles.js';
import {
  chooseExam,
  clearScope,
  conceptsInScope,
  declareScope,
  newProfile,
  onboardingState,
  scopeStatus,
  setCurrentClass,
  setPriorScore,
  skipOnboarding,
  type ExamChoice,
  type LearnerProfile,
  type OnboardingState,
  type PriorScore,
} from '../../domain/learner-profile.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, CurriculumSource, ExamOption, LearnerProfileStore, ScopeNode } from '../ports.js';

/**
 * The learner's profile and onboarding (M8-18, M8-20, FR-STU-01, FR-STU-02). Every handler names `learner` and acts on the caller's own profile only: the learner is the principal and never
 * a field of the request, so there is no way to name another's.
 *
 * **Skippable, and skipping never blocks anything.** Nothing here refuses a learner for a profile that is empty, partial or skipped, and the handlers that read a profile for another
 * purpose (a recommendation, a practice run) treat a missing profile and a missing scope as "everything", never as a reason to refuse (`platform/composition/learning-profile-http.integration.spec.ts` skips every
 * step and then uses the product). **Resumable:** where the learner was is `onboardingState`, derived from the fields (`domain/learner-profile.ts`). **No payment is asked for** at any step
 * (PRD §5 J1); there is no commerce before M9, and ADR-0060 writes it down (DEC-M8-11 in docs/IMPLEMENTATION-DECISIONS.md) so that it stays true when there is. **A scope belongs to the taxonomy version it was declared against** (DEC-M8-10): after a bump it needs review and filters nothing.
 *
 * **What a bumped taxonomy does to a scope (FR-STU-02 rule 2).** A scope is declared against one taxonomy version and applies to that version only. When Curriculum now resolves the
 * learner's exam to another taxonomy version, the scope is reported as `needs_review`, everything that reads scope treats it as none, and nothing is guessed across the bump. An edit of
 * the scope re-resolves the exam first, so it is declared against the version now in force: the exam and year stay as the learner chose them, the versions they resolve to are brought
 * up to date, and the chapters are picked from the new version's list.
 */
export const GET_LEARNER_PROFILE_POLICY = policy('GetLearnerProfile', [ROLES.learner]);
export const UPDATE_LEARNER_PROFILE_POLICY = policy('UpdateLearnerProfile', [ROLES.learner]);
export const SKIP_ONBOARDING_POLICY = policy('SkipOnboarding', [ROLES.learner]);
export const LIST_EXAM_CHOICES_POLICY = policy('ListExamChoices', [ROLES.learner]);
export const GET_SCOPE_OPTIONS_POLICY = policy('GetScopeOptions', [ROLES.learner]);
export const GET_LEARNER_SCOPE_POLICY = policy('GetLearnerScope', [ROLES.learner]);

export type ScopeView = null | {
  /** `unchecked`: Curriculum could not be asked whether the version is still the one in force, so nothing is claimed either way. */
  readonly status: 'in_force' | 'needs_review' | 'unchecked';
  readonly taxonomyVersionId: string;
  readonly nodeIds: readonly string[];
  readonly conceptCount: number;
  readonly conceptTotal: number;
  /** The share of the syllabus the scope covers, between 0 and 1, to four places. */
  readonly coverageFraction: number;
};

export interface LearnerProfileView {
  readonly exam: ExamChoice | null;
  readonly currentClass: LearnerProfile['currentClass'];
  readonly priorScore: PriorScore | null;
  readonly scope: ScopeView;
  readonly onboarding: OnboardingState;
  readonly version: number;
}

interface Deps {
  readonly profiles: LearnerProfileStore;
  readonly curriculum: CurriculumSource;
  readonly clock: Clock;
}

const EXAM_FIRST = applicationError('PreconditionFailed', 'EXAM_FIRST', 'choose an exam and a year first: the chapters are those of its syllabus');

const coverage = (concepts: number, total: number): number => Math.round((concepts / total) * 10_000) / 10_000;

/** What a learner is told of a profile. The scope's status is Curriculum's word for whether its version is still the one in force; when Curriculum cannot say, so is the view. */
async function viewOf(profile: LearnerProfile, deps: Deps, context: ApplicationContext): Promise<LearnerProfileView> {
  let scope: ScopeView = null;
  if (profile.scope !== null) {
    let status: 'in_force' | 'needs_review' | 'unchecked' = 'unchecked';
    if (profile.exam !== null) {
      const current = await deps.curriculum.resolveExam(profile.exam.examCode, profile.exam.targetYear, context);
      if (current.ok) status = scopeStatus(profile, current.value.taxonomyVersionId) === 'in_force' ? 'in_force' : 'needs_review';
    }
    scope = Object.freeze({
      status,
      taxonomyVersionId: profile.scope.taxonomyVersionId,
      nodeIds: profile.scope.nodeIds,
      conceptCount: profile.scope.conceptIdentityIds.length,
      conceptTotal: profile.scope.conceptTotal,
      coverageFraction: coverage(profile.scope.conceptIdentityIds.length, profile.scope.conceptTotal),
    });
  }
  return Object.freeze({ exam: profile.exam, currentClass: profile.currentClass, priorScore: profile.priorScore, scope, onboarding: onboardingState(profile), version: profile.version });
}

/** The learner's profile, or an empty one that has not been saved: reading never creates a row. */
async function load(learnerRef: string, deps: Deps): Promise<Result<{ readonly profile: LearnerProfile; readonly readAt: number | null }, ApplicationError>> {
  const found = await deps.profiles.find(learnerRef);
  if (!found.ok) return err(found.error);
  return ok({ profile: found.value ?? newProfile(learnerRef, deps.clock.now().toISOString()), readAt: found.value?.version ?? null });
}

const asValidation = (failure: ApplicationError, code: string): ApplicationError => (failure.kind === 'NotFound' ? applicationError('Validation', code, failure.message) : failure);

export class GetLearnerProfileHandler {
  readonly name = 'GetLearnerProfile';
  readonly policy = GET_LEARNER_PROFILE_POLICY;

  constructor(private readonly deps: Deps) {}

  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<LearnerProfileView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const loaded = await load(context.principal.id, this.deps);
    if (!loaded.ok) return loaded;
    return ok(await viewOf(loaded.value.profile, this.deps, context));
  }
}

export interface UpdateLearnerProfile {
  readonly examCode?: unknown;
  readonly targetYear?: unknown;
  readonly currentClass?: unknown;
  /** `null` takes the prior score away. */
  readonly priorScore?: unknown;
  /** The chapters picked, or `null` to take the scope away. */
  readonly scopeNodeIds?: unknown;
}

export class UpdateLearnerProfileHandler {
  readonly name = 'UpdateLearnerProfile';
  readonly policy = UPDATE_LEARNER_PROFILE_POLICY;

  constructor(private readonly deps: Deps) {}

  /**
   * Applies what the learner sent, step by step, and saves once over the version it read. A step is whatever fields arrive: the exam and the year together (one may be given alone and
   * the other taken from what is saved), the class, the prior score, the scope. An empty change saves nothing and creates nothing.
   */
  async handle(command: UpdateLearnerProfile, context: ApplicationContext): Promise<Result<LearnerProfileView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const loaded = await load(context.principal.id, this.deps);
    if (!loaded.ok) return loaded;
    let profile = loaded.value.profile;
    const now = this.deps.clock.now().toISOString();
    let changed = false;

    if (command.examCode !== undefined || command.targetYear !== undefined) {
      const examCode = command.examCode ?? profile.exam?.examCode;
      const targetYear = command.targetYear ?? profile.exam?.targetYear;
      if (typeof examCode !== 'string' || typeof targetYear !== 'string') return err(applicationError('Validation', 'EXAM_CHOICE_INVALID', 'an exam, and a year that looks like 2027 or 2026-27'));
      const resolved = await this.deps.curriculum.resolveExam(examCode, targetYear, context);
      if (!resolved.ok) return err(asValidation(resolved.error, 'EXAM_NOT_AVAILABLE'));
      const chosen = chooseExam(profile, resolved.value, now);
      if (!chosen.ok) return err(chosen.error);
      profile = chosen.value;
      changed = true;
    }
    if (command.currentClass !== undefined) {
      const set = setCurrentClass(profile, command.currentClass, now);
      if (!set.ok) return err(set.error);
      profile = set.value;
      changed = true;
    }
    if (command.priorScore !== undefined) {
      const set = setPriorScore(profile, command.priorScore, now);
      if (!set.ok) return err(set.error);
      profile = set.value;
      changed = true;
    }
    if (command.scopeNodeIds !== undefined) {
      if (command.scopeNodeIds === null) {
        profile = clearScope(profile, now);
      } else {
        const declared = await this.declare(profile, command.scopeNodeIds, now, context);
        if (!declared.ok) return declared;
        profile = declared.value;
      }
      changed = true;
    }

    if (!changed) return ok(await viewOf(profile, this.deps, context));
    const saved = await this.deps.profiles.save(profile, loaded.value.readAt);
    if (!saved.ok) return err(saved.error);
    return ok(await viewOf(saved.value, this.deps, context));
  }

  /** Brings the exam's versions up to date, then resolves the picked chapters against the taxonomy version now in force and declares the scope against it. */
  private async declare(profile: LearnerProfile, nodeIds: unknown, now: string, context: ApplicationContext): Promise<Result<LearnerProfile, ApplicationError>> {
    if (profile.exam === null) return err(EXAM_FIRST);
    if (!Array.isArray(nodeIds) || !nodeIds.every((id) => typeof id === 'string')) return err(applicationError('Validation', 'SCOPE_INVALID', 'the chapters picked are a list of chapter identifiers'));
    const current = await this.deps.curriculum.resolveExam(profile.exam.examCode, profile.exam.targetYear, context);
    if (!current.ok) return err(current.error);
    let working = profile;
    if (current.value.taxonomyVersionId !== profile.exam.taxonomyVersionId || current.value.examProfileVersionId !== profile.exam.examProfileVersionId) {
      const refreshed = chooseExam(profile, current.value, now);
      if (!refreshed.ok) return err(refreshed.error);
      working = refreshed.value;
    }
    const resolved = await this.deps.curriculum.resolveScope(current.value.taxonomyVersionId, nodeIds as string[], context);
    if (!resolved.ok) return err(asValidation(resolved.error, 'SCOPE_NODES_UNKNOWN'));
    const declared = declareScope(working, { taxonomyVersionId: current.value.taxonomyVersionId, nodeIds: nodeIds as string[], conceptIdentityIds: resolved.value.conceptIdentityIds, conceptTotal: resolved.value.conceptTotal }, now);
    return declared.ok ? ok(declared.value) : err(declared.error);
  }
}

export class SkipOnboardingHandler {
  readonly name = 'SkipOnboarding';
  readonly policy = SKIP_ONBOARDING_POLICY;

  constructor(private readonly deps: Deps) {}

  /** Records that the learner skipped. Nothing else changes and nothing is withheld; the next thing they save ends the skip. */
  async handle(_command: Record<string, never>, context: ApplicationContext): Promise<Result<LearnerProfileView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const loaded = await load(context.principal.id, this.deps);
    if (!loaded.ok) return loaded;
    const saved = await this.deps.profiles.save(skipOnboarding(loaded.value.profile, this.deps.clock.now().toISOString()), loaded.value.readAt);
    if (!saved.ok) return err(saved.error);
    return ok(await viewOf(saved.value, this.deps, context));
  }
}

export class ListExamChoicesHandler {
  readonly name = 'ListExamChoices';
  readonly policy = LIST_EXAM_CHOICES_POLICY;

  constructor(private readonly deps: Pick<Deps, 'curriculum'>) {}

  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<{ readonly exams: readonly ExamOption[] }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const options = await this.deps.curriculum.examOptions(context);
    return options.ok ? ok(Object.freeze({ exams: options.value })) : err(options.error);
  }
}

export interface ScopeOptionsView {
  readonly taxonomyVersionId: string;
  readonly nodes: readonly ScopeNode[];
  readonly conceptTotal: number;
  /** The chapters already picked, when the scope declared is for this version; none otherwise, because a scope is not carried across a bump by guesswork. */
  readonly selected: readonly string[];
}

export class GetScopeOptionsHandler {
  readonly name = 'GetScopeOptions';
  readonly policy = GET_SCOPE_OPTIONS_POLICY;

  constructor(private readonly deps: Deps) {}

  /** The chapters of the syllabus now in force for the learner's exam. They are resolved fresh, so a learner editing after a version bump picks from the new version's list. */
  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<ScopeOptionsView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const loaded = await load(context.principal.id, this.deps);
    if (!loaded.ok) return loaded;
    const profile = loaded.value.profile;
    if (profile.exam === null) return err(EXAM_FIRST);
    const current = await this.deps.curriculum.resolveExam(profile.exam.examCode, profile.exam.targetYear, context);
    if (!current.ok) return err(current.error);
    const options = await this.deps.curriculum.scopeOptions(current.value.taxonomyVersionId, context);
    if (!options.ok) return err(options.error);
    const selected = scopeStatus(profile, options.value.taxonomyVersionId) === 'in_force' ? profile.scope!.nodeIds : [];
    return ok(Object.freeze({ ...options.value, selected }));
  }
}

export class GetLearnerScopeHandler {
  readonly name = 'GetLearnerScope';
  readonly policy = GET_LEARNER_SCOPE_POLICY;

  constructor(private readonly deps: Pick<Deps, 'profiles'>) {}

  /**
   * The concepts in the caller's scope for a taxonomy version, or `null` where there is none in force for it: no profile, no scope, or a scope declared against another
   * version. `null` means nothing is filtered. This is the one door the scope leaves through for practice (ADR-0060); mock exams never ask it.
   */
  async handle(query: { readonly taxonomyVersionId: string }, context: ApplicationContext): Promise<Result<{ readonly conceptIdentityIds: readonly string[] | null }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const found = await this.deps.profiles.find(context.principal.id);
    if (!found.ok) return err(found.error);
    const concepts = found.value === null ? null : conceptsInScope(found.value, query.taxonomyVersionId);
    return ok(Object.freeze({ conceptIdentityIds: concepts === null ? null : Object.freeze([...concepts].sort()) }));
  }
}
