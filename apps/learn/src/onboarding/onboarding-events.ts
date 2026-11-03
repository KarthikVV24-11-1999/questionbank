import type { ScreenAnalytics } from '../analytics/emitter.js';
import type { LearnerProfileDto, OnboardingStep, ProfileChange } from '../api/learning-schemas.js';

/**
 * What onboarding says happened (M8-22). The names and payloads are the catalog's (`onboarding.step_completed`, `onboarding.scope_declared`, owned by M8 in EVENT-TAXONOMY.md); this
 * module only calls the emitter.
 *
 * `onboarding.abandoned` is in the catalog and is not emitted: a page that is closed sends nothing, and an event inferred from a profile that stopped advancing would report a guess as a
 * fact (D108 in docs/DEBT.md).
 *
 * A step is completed when the learner has answered it, whether or not the server has heard yet: the answer is on the device and the learner has moved on. The scope is declared when the
 * server has accepted it, because the count and the fraction are the server's to give.
 */
export function stepCompleted(analytics: ScreenAnalytics, step: OnboardingStep, openedAtMs: number): void {
  analytics.emit('onboarding.step_completed', { step, seconds_on_step: Math.max(0, Math.round((analytics.nowMs() - openedAtMs) / 1000)) });
}

/** For a draft the server has accepted: the scope, when the draft carried one. */
export function sentDraft(analytics: ScreenAnalytics): (sent: ProfileChange, profile: LearnerProfileDto) => void {
  return (sent, profile) => {
    if (sent.scopeNodeIds != null && profile.scope !== null) analytics.emit('onboarding.scope_declared', { concept_count: profile.scope.conceptCount, coverage_fraction: profile.scope.coverageFraction });
  };
}
