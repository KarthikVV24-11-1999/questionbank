import { err, ok, type Result } from './result.js';

/**
 * `LearnerProfile` — what a learner says of themselves, and which part of the syllabus they have studied (M8-18, FR-STU-01, FR-STU-02).
 *
 * **Learning owns it** (ADR-0060, DEC-M8-9 in docs/IMPLEMENTATION-DECISIONS.md). The profile exists to constrain and steer practice and recommendations, which is Learning's work; Identity owns credentials, sessions and roles and
 * does not grow a product profile; and a bounded context for one aggregate would be more structure than it earns. One profile per learner, keyed on the identifier Identity issued,
 * with no reference into Identity's tables.
 *
 * **It references Curriculum, it does not copy it.** The exam the learner chose resolves to an exam profile version, and that to a taxonomy version (INV-04); the profile keeps both
 * *as they were when the choice was made*, the way the evidence rows keep the item version (D70), so that a rule which changes later recomputes against what was chosen and does not
 * ask the learner again. The scope, the chapters picked and the concepts they stand for, is declared against one taxonomy version and says which.
 *
 * **Partial from the start.** Every field may be empty: a learner mid-onboarding has a real profile, not an invalid one, and so has one who skipped. What the profile lacks is not a fault;
 * it is what `onboardingState` reports as still to do.
 *
 * **Where the learner was is read from what the profile holds** (`onboardingState`), not from a step marker kept beside it. A marker can disagree with the fields; the fields cannot.
 */
export const CURRENT_CLASSES = ['class_11', 'class_12', 'repeater'] as const;
export type CurrentClass = (typeof CURRENT_CLASSES)[number];

export const MAX_SCOPE_NODES = 2_000;
const MAX_SCORE_OUT_OF = 100_000;
const ACADEMIC_YEAR = /^[0-9]{4}(-[0-9]{2})?$/u;

/** What an exam and a year resolved to when the learner chose them. */
export interface ExamChoice {
  readonly examCode: string;
  readonly targetYear: string;
  readonly examProfileVersionId: string;
  readonly taxonomyVersionId: string;
}

export interface PriorScore {
  readonly value: number;
  readonly outOf: number;
}

/** The chapters picked, the concepts they stand for, and how many concepts the taxonomy version has: the denominator of the coverage the learner is shown. */
export interface DeclaredScope {
  readonly taxonomyVersionId: string;
  readonly nodeIds: readonly string[];
  readonly conceptIdentityIds: readonly string[];
  readonly conceptTotal: number;
}

export interface LearnerProfile {
  readonly learnerRef: string;
  readonly exam: ExamChoice | null;
  readonly currentClass: CurrentClass | null;
  readonly priorScore: PriorScore | null;
  readonly scope: DeclaredScope | null;
  /** When the learner skipped onboarding; cleared by the next thing they save, which is them resuming. */
  readonly onboardingSkippedAt: string | null;
  /** Counts saves, for the store to refuse a write made over a newer one. */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProfileErrorCode = 'EXAM_CHOICE_INVALID' | 'CLASS_INVALID' | 'PRIOR_SCORE_INVALID' | 'SCOPE_INVALID';

export interface ProfileError {
  readonly kind: 'Validation';
  readonly code: ProfileErrorCode;
  readonly message: string;
}

const invalid = (code: ProfileErrorCode, message: string): ProfileError => Object.freeze({ kind: 'Validation' as const, code, message });

export function newProfile(learnerRef: string, now: string): LearnerProfile {
  return Object.freeze({ learnerRef, exam: null, currentClass: null, priorScore: null, scope: null, onboardingSkippedAt: null, version: 1, createdAt: now, updatedAt: now });
}

/** Any save is the learner carrying on, so a skip is over; and each is one more version. */
const saved = (profile: LearnerProfile, change: Partial<LearnerProfile>, now: string): LearnerProfile =>
  Object.freeze({ ...profile, ...change, onboardingSkippedAt: null, version: profile.version + 1, updatedAt: now });

export const isAcademicYear = (value: unknown): value is string => typeof value === 'string' && ACADEMIC_YEAR.test(value);

/** The exam and the year, as Curriculum resolved them. Choosing again replaces the choice; a scope declared against another taxonomy version is kept and reported as needing review, not deleted. */
export function chooseExam(profile: LearnerProfile, choice: ExamChoice, now: string): Result<LearnerProfile, ProfileError> {
  if (choice.examCode.trim().length === 0 || !isAcademicYear(choice.targetYear)) {
    return err(invalid('EXAM_CHOICE_INVALID', 'an exam, and a year that looks like 2027 or 2026-27'));
  }
  return ok(saved(profile, { exam: Object.freeze({ ...choice }) }, now));
}

export function setCurrentClass(profile: LearnerProfile, value: unknown, now: string): Result<LearnerProfile, ProfileError> {
  if (!(CURRENT_CLASSES as readonly unknown[]).includes(value)) return err(invalid('CLASS_INVALID', `the current class is one of ${CURRENT_CLASSES.join(', ')}`));
  return ok(saved(profile, { currentClass: value as CurrentClass }, now));
}

/** A score out of a maximum, or `null` to take it away: it is optional and was only ever the learner's say. */
export function setPriorScore(profile: LearnerProfile, value: unknown, now: string): Result<LearnerProfile, ProfileError> {
  if (value === null) return ok(saved(profile, { priorScore: null }, now));
  const candidate = value as Partial<PriorScore> | undefined;
  const score = candidate?.value;
  const outOf = candidate?.outOf;
  if (typeof score !== 'number' || typeof outOf !== 'number' || !Number.isFinite(score) || !Number.isFinite(outOf) || outOf <= 0 || outOf > MAX_SCORE_OUT_OF || score < 0 || score > outOf) {
    return err(invalid('PRIOR_SCORE_INVALID', 'a score that is no more than its maximum, and a maximum above zero'));
  }
  return ok(saved(profile, { priorScore: Object.freeze({ value: score, outOf }) }, now));
}

/** The scope, declared against one taxonomy version. It has at least one concept and no more than the version has. */
export function declareScope(profile: LearnerProfile, scope: DeclaredScope, now: string): Result<LearnerProfile, ProfileError> {
  const nodes = new Set(scope.nodeIds);
  const concepts = new Set(scope.conceptIdentityIds);
  if (nodes.size === 0 || nodes.size !== scope.nodeIds.length || nodes.size > MAX_SCOPE_NODES || concepts.size === 0 || concepts.size !== scope.conceptIdentityIds.length || !Number.isInteger(scope.conceptTotal) || concepts.size > scope.conceptTotal) {
    return err(invalid('SCOPE_INVALID', 'at least one chapter, each once, standing for at least one concept and for no more than the syllabus has'));
  }
  return ok(saved(profile, { scope: Object.freeze({ ...scope, nodeIds: Object.freeze([...scope.nodeIds]), conceptIdentityIds: Object.freeze([...scope.conceptIdentityIds]) }) }, now));
}

/** Takes the scope away: everything is in scope, which is where a learner who never declared one stands. */
export function clearScope(profile: LearnerProfile, now: string): LearnerProfile {
  return saved(profile, { scope: null }, now);
}

export function skipOnboarding(profile: LearnerProfile, now: string): LearnerProfile {
  return Object.freeze({ ...profile, onboardingSkippedAt: now, version: profile.version + 1, updatedAt: now });
}

export type OnboardingStep = 'exam' | 'class' | 'coverage' | 'prior_score';
export type StepState = 'done' | 'pending' | 'optional';

export interface OnboardingState {
  readonly steps: ReadonlyArray<{ readonly step: OnboardingStep; readonly state: StepState }>;
  /** The first step that is still to do, or `null` when all that is asked has been given. Derived from the fields, so it cannot disagree with them. */
  readonly next: OnboardingStep | null;
  /** The learner skipped and has not saved anything since. Nothing is withheld because of it. */
  readonly skipped: boolean;
}

export function onboardingState(profile: LearnerProfile): OnboardingState {
  const steps = Object.freeze([
    Object.freeze({ step: 'exam' as const, state: profile.exam === null ? ('pending' as const) : ('done' as const) }),
    Object.freeze({ step: 'class' as const, state: profile.currentClass === null ? ('pending' as const) : ('done' as const) }),
    Object.freeze({ step: 'coverage' as const, state: profile.scope === null ? ('pending' as const) : ('done' as const) }),
    // optional by FR-STU-01 ("optional prior score"): never the next thing, whether or not it is given
    Object.freeze({ step: 'prior_score' as const, state: profile.priorScore === null ? ('optional' as const) : ('done' as const) }),
  ]);
  const next = steps.find((entry) => entry.state === 'pending')?.step ?? null;
  return Object.freeze({ steps, next, skipped: profile.onboardingSkippedAt !== null });
}

export type ScopeStatus = 'none' | 'in_force' | 'needs_review';

/**
 * Whether the scope applies to a taxonomy version. It applies to the one it was declared against and to no other: a scope is not carried across a version bump by guesswork,
 * because the concepts a chapter stands for can change with the version. Against another version it is `needs_review`, and everything that reads scope treats that as no scope.
 */
export function scopeStatus(profile: LearnerProfile, taxonomyVersionId: string | null): ScopeStatus {
  if (profile.scope === null) return 'none';
  return taxonomyVersionId === profile.scope.taxonomyVersionId ? 'in_force' : 'needs_review';
}

/** The concepts in scope for a taxonomy version, or `null` where no scope is in force for it: nothing is filtered. */
export function conceptsInScope(profile: LearnerProfile, taxonomyVersionId: string): ReadonlySet<string> | null {
  return scopeStatus(profile, taxonomyVersionId) === 'in_force' ? new Set(profile.scope!.conceptIdentityIds) : null;
}
