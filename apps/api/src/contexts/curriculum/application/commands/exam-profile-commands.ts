import type { ItemTypeAllowance } from '../../domain/exam-profile-version.js';
import type { CreateSectionSpecProps } from '../../domain/section-spec.js';
import type { MarkingRuleSetData } from '../../domain/value-objects/marking-rule-set.js';
import type { CreateNumericAnswerSpecProps } from '../../domain/value-objects/numeric-answer-spec.js';
import type { CreateTimingPolicyProps } from '../../domain/value-objects/timing-policy.js';
import type { CreateNavigationPolicyProps } from '../../domain/value-objects/navigation-policy.js';

/** The exam profile write surface. */

export interface CreateExam {
  readonly code: string;
  readonly displayName: string;
  readonly jurisdiction: string;
  readonly conductingBody: string;
}

export interface ProfileDraftContent {
  readonly sections: readonly CreateSectionSpecProps[];
  readonly totalMarks: number;
  readonly timingPolicy: CreateTimingPolicyProps;
  readonly navigationPolicy: CreateNavigationPolicyProps;
  readonly markingRuleSet: MarkingRuleSetData;
  readonly toleranceDefault?: CreateNumericAnswerSpecProps;
  readonly itemTypeAllowances: readonly ItemTypeAllowance[];
}

export interface CreateProfileDraft extends ProfileDraftContent {
  readonly examId: string;
  readonly academicYear: string;
  readonly taxonomyVersionId: string;
}

export interface UpdateProfileDraft extends ProfileDraftContent {
  readonly profileVersionId: string;
  readonly expectedAggregateVersion: number;
}

export interface PublishProfileVersion {
  readonly profileVersionId: string;
  readonly expectedAggregateVersion: number;
  /** Publication also makes the version the active one for its academic year. */
  readonly activate?: boolean;
}

export interface SupersedeProfileVersion {
  readonly profileVersionId: string;
  readonly expectedAggregateVersion: number;
}
