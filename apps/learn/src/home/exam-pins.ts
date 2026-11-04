import type { LearnerProfileDto } from '../api/learning-schemas.js';

/**
 * What a practice run is made under and what "weakest" is asked about: the exam profile version and the taxonomy version, taken from the learner's own profile (M8-29, D88). They used to arrive
 * in the address, which a learner could edit and a screen could be opened without; the profile is the learner's, is read from the server, and says it was chosen. A learner with no exam chosen has
 * none, and the screens say to choose one and do not try.
 */
export interface ExamPins {
  readonly examProfileVersionId: string;
  readonly taxonomyVersionId: string;
}

export const pinsOf = (profile: LearnerProfileDto | null): ExamPins | null =>
  profile?.exam == null ? null : { examProfileVersionId: profile.exam.examProfileVersionId, taxonomyVersionId: profile.exam.taxonomyVersionId };
