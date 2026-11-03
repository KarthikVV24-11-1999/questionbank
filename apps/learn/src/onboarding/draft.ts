import { ApiProblemError } from '@questionbank/contracts/client';
import type { LearnerProfileDto, OnboardingStep, ProfileChange } from '../api/learning-schemas.js';
import type { ProfileApi } from '../api/learning-api.js';

/**
 * What a learner has said in onboarding and the server has not yet been told (M8-22).
 *
 * **It lives on the device, in the same IndexedDB database as the response log** (DEC-M8-12 in docs/IMPLEMENTATION-DECISIONS.md; D107 in docs/DEBT.md is why not `localStorage`: Chrome commits that some seconds after a write, and a draft
 * is exactly the thing a learner on a bad connection would lose). The server's profile is the truth; the draft is only what is waiting to reach it. A step is written here first and sent
 * second, so a learner who answers with no connection has answered, and the answer is sent when the connection is back. It is removed when the server has acknowledged it and not before.
 *
 * What is kept is a `ProfileChange`, the body of the request, and nothing else: no step marker. Which step comes next is worked out from the profile the server holds with the draft laid over
 * it (`withDraft`), by the same order the server uses.
 */
export interface DraftStore {
  read(): Promise<ProfileChange | null>;
  write(change: ProfileChange): Promise<void>;
  clear(): Promise<void>;
}

/** A store that keeps nothing, for a browser that gave no IndexedDB: a step is then sent or it is not, and the learner is told which. */
export const NO_DRAFTS: DraftStore = { read: () => Promise.resolve(null), write: () => Promise.reject(new Error('this device cannot keep a draft')), clear: () => Promise.resolve() };

/** `later` wins field by field: answering a step again replaces the answer, and answering another adds to it. */
export const mergeChange = (earlier: ProfileChange | null, later: ProfileChange): ProfileChange => ({ ...earlier, ...later });

/** What the learner has told us, whether or not the server has heard: the profile it holds with the draft over it. */
export interface Standing {
  readonly examCode: string | null;
  readonly targetYear: string | null;
  readonly currentClass: LearnerProfileDto['currentClass'];
  readonly priorScore: { readonly value: number; readonly outOf: number } | null;
  readonly scopeNodeIds: readonly string[] | null;
  readonly next: OnboardingStep | null;
}

export function withDraft(profile: LearnerProfileDto | null, draft: ProfileChange | null): Standing {
  const examCode = draft?.examCode ?? profile?.exam?.examCode ?? null;
  const targetYear = draft?.targetYear ?? profile?.exam?.targetYear ?? null;
  const currentClass = draft?.currentClass ?? profile?.currentClass ?? null;
  const priorScore = draft !== null && 'priorScore' in draft ? (draft.priorScore ?? null) : (profile?.priorScore ?? null);
  const scopeNodeIds = draft !== null && 'scopeNodeIds' in draft ? (draft.scopeNodeIds ?? null) : (profile?.scope?.nodeIds ?? null);
  // the server's order: exam, class, coverage; the prior score is optional and never next
  const next: OnboardingStep | null = examCode === null || targetYear === null ? 'exam' : currentClass === null ? 'class' : scopeNodeIds === null ? 'coverage' : null;
  return { examCode, targetYear, currentClass, priorScore, scopeNodeIds, next };
}

export type SendOutcome = { readonly outcome: 'nothing_waiting' | 'sent' | 'kept' } | { readonly outcome: 'refused'; readonly message: string };

/**
 * Sends what is waiting. A refusal or a connection that is down leaves the draft where it is; it is removed only if it is still what was sent, so a step answered while the request
 * was in flight is not thrown away with the one before it. A draft the server will never accept (an exam it does not offer) would otherwise be sent for ever; a 4xx other than a
 * rate limit is the server saying so, and drops it.
 */
export async function sendDraft(ports: { readonly drafts: DraftStore; readonly profiles: Pick<ProfileApi, 'updateProfile'> }, onSent?: (sent: ProfileChange, profile: LearnerProfileDto) => void): Promise<SendOutcome> {
  const waiting = await ports.drafts.read().catch(() => null);
  if (waiting === null || Object.keys(waiting).length === 0) return { outcome: 'nothing_waiting' };
  let profile: LearnerProfileDto;
  try {
    profile = await ports.profiles.updateProfile(waiting);
  } catch (error) {
    if (!isRefusal(error)) return { outcome: 'kept' };
    await ports.drafts.clear().catch(() => undefined);
    return { outcome: 'refused', message: error instanceof Error ? error.message : 'That could not be saved.' };
  }
  const now = await ports.drafts.read().catch(() => null);
  if (JSON.stringify(now) === JSON.stringify(waiting)) await ports.drafts.clear().catch(() => undefined);
  onSent?.(waiting, profile);
  return { outcome: 'sent' };
}

/** A 400-class answer that is not "slow down": the request itself is what the server will not take. */
const isRefusal = (error: unknown): boolean => error instanceof ApiProblemError && error.problem.status >= 400 && error.problem.status < 500 && error.problem.status !== 429 && error.problem.status !== 408;
