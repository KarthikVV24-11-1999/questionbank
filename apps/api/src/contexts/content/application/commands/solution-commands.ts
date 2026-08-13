import type {
  AlternateApproach,
  DistractorAnalysis,
  FinalAnswerAssertion,
  SolutionStep,
} from '../../domain/solution.js';

/**
 * FR-TCH-04. A solution targets an item **version**, because the correctness
 * it explains belongs to a specific key — a solution written for version 1
 * says nothing about version 2 (rule 3).
 */

export interface AuthoredSolutionContent {
  readonly finalAnswerAssertion: FinalAnswerAssertion;
  readonly steps: readonly SolutionStep[];
  readonly distractorAnalyses?: readonly DistractorAnalysis[];
  readonly alternateApproaches?: readonly AlternateApproach[];
}

export interface CreateSolutionDraft {
  readonly itemId: string;
  readonly targetItemVersionId: string;
  readonly subject: string;
  readonly content: AuthoredSolutionContent;
}

export interface UpdateSolutionDraft {
  readonly solutionId: string;
  readonly subject: string;
  readonly content: AuthoredSolutionContent;
  readonly idempotencyKey: string;
}
