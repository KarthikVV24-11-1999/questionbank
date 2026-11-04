import { ApiProblemError } from '@questionbank/contracts/client';
import type { ProfileApi } from '../api/learning-api.js';
import type { ExamChoicesDto, LearnerProfileDto, ProfileChange, ScopeOptionsDto } from '../api/learning-schemas.js';
import type { DraftStore } from '../onboarding/draft.js';

export const EXAM_CHOICES: ExamChoicesDto = { exams: [{ examCode: 'JEE_MAIN', displayName: 'JEE Main', years: ['2027', '2028'] }] };
export const NODE = { physics: '00000000-0000-4000-8000-0000000000a1', mechanics: '00000000-0000-4000-8000-0000000000a2', optics: '00000000-0000-4000-8000-0000000000a3' };
export const SCOPE_OPTIONS: ScopeOptionsDto = {
  taxonomyVersionId: '00000000-0000-4000-8000-0000000000d1',
  conceptTotal: 4,
  selected: [],
  nodes: [
    { nodeId: NODE.physics, parentNodeId: null, displayName: 'Physics', depth: 0 },
    { nodeId: NODE.mechanics, parentNodeId: NODE.physics, displayName: 'Mechanics', depth: 1 },
    { nodeId: NODE.optics, parentNodeId: NODE.physics, displayName: 'Optics', depth: 1 },
  ],
};

export const emptyProfile = (): LearnerProfileDto => ({
  exam: null,
  currentClass: null,
  priorScore: null,
  scope: null,
  version: 1,
  onboarding: { steps: [], next: 'exam', skipped: false },
});

/** A learner who has chosen an exam: the profile a screen reads the exam profile version and the taxonomy version from. Onboarding has nothing more to ask, so nothing invites them back to it. */
export const chosenProfile = (): LearnerProfileDto => ({
  ...emptyProfile(),
  exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: '00000000-0000-4000-8000-0000000000e1', taxonomyVersionId: '00000000-0000-4000-8000-0000000000d1' },
  currentClass: 'class_12',
  onboarding: { steps: [], next: null, skipped: false },
});

export const refusal = (status: number, detail: string): ApiProblemError =>
  new ApiProblemError({ type: 'https://questionbank.example/problems/validation', title: 'refused', status, detail, code: 'Validation', retryable: false, correlationId: 'c' } as never);

/** The server's profile as a learner sees it: it applies a change the way the real one does, in the order the real one asks, and can be taken offline or made to refuse. */
export class FakeProfileApi implements ProfileApi {
  readonly calls: string[] = [];
  readonly updates: ProfileChange[] = [];
  profile: LearnerProfileDto = emptyProfile();
  choices: ExamChoicesDto = EXAM_CHOICES;
  options: ScopeOptionsDto = SCOPE_OPTIONS;
  /** Every call fails as a dropped connection does. */
  offline = false;
  /** The next update is refused with this problem. */
  refuseNext: ApiProblemError | null = null;

  #check(): void {
    if (this.offline) throw new TypeError('Failed to fetch');
  }
  async getProfile(): Promise<LearnerProfileDto> {
    this.calls.push('getProfile');
    this.#check();
    return this.profile;
  }
  async updateProfile(change: ProfileChange): Promise<LearnerProfileDto> {
    this.calls.push('updateProfile');
    this.#check();
    if (this.refuseNext !== null) {
      const problem = this.refuseNext;
      this.refuseNext = null;
      throw problem;
    }
    this.updates.push(change);
    const was = this.profile;
    const exam = change.examCode !== undefined && change.targetYear !== undefined ? { examCode: change.examCode, targetYear: change.targetYear, examProfileVersionId: 'p1', taxonomyVersionId: SCOPE_OPTIONS.taxonomyVersionId } : was.exam;
    const currentClass = change.currentClass ?? was.currentClass;
    const priorScore = 'priorScore' in change ? (change.priorScore ?? null) : was.priorScore;
    const scope =
      change.scopeNodeIds === undefined
        ? was.scope
        : change.scopeNodeIds === null
          ? null
          : { status: 'in_force' as const, taxonomyVersionId: SCOPE_OPTIONS.taxonomyVersionId, nodeIds: [...change.scopeNodeIds], conceptCount: 2, conceptTotal: 4, coverageFraction: 0.5 };
    const next = exam === null ? 'exam' : currentClass === null ? 'class' : scope === null ? 'coverage' : null;
    this.profile = { exam, currentClass, priorScore, scope, version: was.version + 1, onboarding: { steps: [], next, skipped: false } };
    return this.profile;
  }
  async skipOnboarding(): Promise<LearnerProfileDto> {
    this.calls.push('skipOnboarding');
    this.#check();
    this.profile = { ...this.profile, onboarding: { ...this.profile.onboarding, skipped: true } };
    return this.profile;
  }
  async examChoices(): Promise<ExamChoicesDto> {
    this.calls.push('examChoices');
    this.#check();
    return this.choices;
  }
  async scopeOptions(): Promise<ScopeOptionsDto> {
    this.calls.push('scopeOptions');
    this.#check();
    return this.options;
  }
}

export class MemoryDrafts implements DraftStore {
  draft: ProfileChange | null = null;
  /** Writing fails, as a full or refused disk does. */
  failWrites = false;
  async read(): Promise<ProfileChange | null> {
    return this.draft;
  }
  async write(change: ProfileChange): Promise<void> {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.draft = change;
  }
  async clear(): Promise<void> {
    this.draft = null;
  }
}
