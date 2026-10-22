import { err, ok, type Result } from '../domain/result.js';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, AttemptPins, AttemptPinSource } from '../application/ports.js';

/**
 * The one curriculum read assessment makes, in the shape assessment needs of it — the pins an attempt copies from an
 * exam profile version. Curriculum's handler arrives through the composition seam; nothing here imports curriculum.
 */
export interface ProfilePinsView {
  readonly state: string;
  readonly taxonomyVersionId: string;
  readonly markingRuleSetHash: string | null;
  readonly totalDurationMinutes: number;
  readonly sectionLocking: boolean;
  readonly autoSubmitOnExpiry: boolean;
  readonly crossSectionNavigation: boolean;
  readonly allowMarkForReview: boolean;
  readonly allowAnswerChange: boolean;
  readonly allowClearResponse: boolean;
}

export type ProfilePinsHandler = {
  handle(query: { readonly profileVersionId: string }, context: ApplicationContext): Promise<Result<ProfilePinsView, ApplicationError>>;
};

const MS_PER_MINUTE = 60_000;

export class CurriculumPinSource implements AttemptPinSource {
  constructor(private readonly profile: ProfilePinsHandler) {}

  async pinsFor(examProfileVersionId: string, context: ApplicationContext): Promise<Result<AttemptPins, ApplicationError>> {
    const view = await this.profile.handle({ profileVersionId: examProfileVersionId }, context);
    if (!view.ok) return view;
    const profile = view.value;

    // An attempt pins what scores it: a profile with no marking rule set hash cannot be scored, so it is not sat.
    if (profile.markingRuleSetHash === null) {
      return err(applicationError('PreconditionFailed', 'PROFILE_NOT_SCORABLE', 'the exam profile version has no marking rule set to score against', 'examProfileVersionId'));
    }
    if (profile.state === 'draft') {
      return err(applicationError('PreconditionFailed', 'PROFILE_NOT_PUBLISHED', 'the exam profile version is still a draft', 'examProfileVersionId'));
    }
    return ok(
      Object.freeze({
        taxonomyVersionId: profile.taxonomyVersionId,
        markingRuleSetHash: profile.markingRuleSetHash,
        durationMs: profile.totalDurationMinutes * MS_PER_MINUTE,
        deliveryPolicy: Object.freeze({
          timing: Object.freeze({
            totalDurationMinutes: profile.totalDurationMinutes,
            sectionLocking: profile.sectionLocking,
            autoSubmitOnExpiry: profile.autoSubmitOnExpiry,
          }),
          navigation: Object.freeze({
            crossSectionNavigation: profile.crossSectionNavigation,
            allowMarkForReview: profile.allowMarkForReview,
            allowAnswerChange: profile.allowAnswerChange,
            allowClearResponse: profile.allowClearResponse,
          }),
        }),
      }),
    );
  }
}
