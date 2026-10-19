import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_FLOORS,
  evaluate,
  versionsNotEvaluated,
  type EvaluateProps,
  type EvaluationRun,
} from './evaluation-run.js';

const ID = (n: number) => `00000000-0000-4000-8000-00000e${String(n).padStart(6, '0')}`;
const MODEL = '00000000-0000-4000-8000-0000000a0003';
const PROMPT = '00000000-0000-4000-8000-0000000b0007';

const props = (over: Partial<EvaluateProps> = {}): EvaluateProps => ({
  evaluationRunId: ID(1),
  subject: { kind: 'prompt', versionId: PROMPT },
  corpus: 'golden-v1',
  scores: { generation_acceptance: 0.7, verification_catch_rate: 0.97 },
  evaluatedAt: '2026-10-16T09:30:00.000Z',
  ...over,
});

const passing = (over: Partial<EvaluateProps> = {}): EvaluationRun => expectValue(evaluate(props(over)));

describe('the outcome is derived from the scores, never supplied', () => {
  it('passes a first evaluation whose scores meet every floor, with no regressions', () => {
    const run = passing();
    expect(run.outcome).toBe('pass');
    expect(run.regressions).toEqual([]);
    expect(run.baselineRunId).toBeUndefined();
    expect(run.scores).toEqual({ generation_acceptance: 0.7, verification_catch_rate: 0.97 });
  });

  it('holds verification catch rate to the floor F34 sets: 95% passes and one hair under fails', () => {
    expect(EVALUATION_FLOORS.verification_catch_rate).toBe(0.95);
    expect(passing({ scores: { verification_catch_rate: 0.95 } }).outcome).toBe('pass');
    const missed = passing({ scores: { verification_catch_rate: 0.9499 } });
    expect(missed.outcome).toBe('fail');
    expect(missed.regressions).toEqual(['verification_catch_rate']);
  });

  it('applies a floor only to a dimension that was measured: a run that reports no catch rate is not failed for lacking one', () => {
    expect(passing({ scores: { generation_acceptance: 0.1 } }).outcome).toBe('pass');
  });

  it('refuses a run that measured nothing, and a score outside [0, 1] or not a number, naming the field', () => {
    expect(expectError(evaluate(props({ scores: {} }))).code).toBe('EVALUATION_SCORES_EMPTY');
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.9', null]) {
      const failure = expectError(evaluate(props({ scores: { generation_acceptance: bad } })));
      expect(failure.code, String(bad)).toBe('EVALUATION_SCORE_INVALID');
      expect(failure.location).toBe('scores.generation_acceptance');
    }
    const unknown = expectError(evaluate(props({ scores: { vibes: 1 } })));
    expect(unknown.code).toBe('EVALUATION_DIMENSION_UNKNOWN');
    expect(unknown.message).toContain(EVALUATION_DIMENSIONS.join(', '));
  });

  it('refuses a malformed id, subject, corpus or timestamp, naming the field', () => {
    expect(expectError(evaluate(props({ evaluationRunId: 'nope' }))).location).toBe('evaluationRunId');
    expect(expectError(evaluate(props({ subject: { kind: 'tutor', versionId: PROMPT } }))).location).toBe('subject');
    expect(expectError(evaluate(props({ subject: { kind: 'model', versionId: 'nope' } }))).location).toBe('subject');
    expect(expectError(evaluate(props({ corpus: ' ' }))).location).toBe('corpus');
    expect(expectError(evaluate(props({ evaluatedAt: 'yesterday' }))).location).toBe('evaluatedAt');
  });
});

describe('regression blocks promotion — and a regression is a fail, not a warning beside a pass', () => {
  const baseline = passing({ scores: { generation_acceptance: 0.7, verification_catch_rate: 0.97, explanation_quality: 0.8 } });
  const against = (scores: Record<string, number>) => expectValue(evaluate(props({ evaluationRunId: ID(2), scores, baseline })));

  it('passes a version that matches or beats the baseline on everything it reported', () => {
    const run = against({ generation_acceptance: 0.7, verification_catch_rate: 0.98, explanation_quality: 0.9 });
    expect(run.outcome).toBe('pass');
    expect(run.baselineRunId).toBe(baseline.evaluationRunId);
  });

  it('fails on a single dimension that dropped, however much the others rose, and names it', () => {
    const run = against({ generation_acceptance: 0.99, verification_catch_rate: 0.97, explanation_quality: 0.79 });
    expect(run.outcome).toBe('fail');
    expect(run.regressions).toEqual(['explanation_quality']);
  });

  it('fails a dimension the baseline reported and this run did not: an evaluation that stopped measuring something has not shown it held', () => {
    const run = against({ generation_acceptance: 0.9, verification_catch_rate: 0.99 });
    expect(run.outcome).toBe('fail');
    expect(run.regressions).toEqual(['explanation_quality']);
  });

  it('lets a run report a dimension the baseline did not', () => {
    expect(against({ generation_acceptance: 0.7, verification_catch_rate: 0.97, explanation_quality: 0.8, difficulty_correlation: 0.1 }).outcome).toBe('pass');
  });

  it('reports every regression, in the vocabulary’s order, when a floor and a baseline are both missed', () => {
    const run = against({ generation_acceptance: 0.5, verification_catch_rate: 0.9, explanation_quality: 0.1 });
    expect(run.regressions).toEqual(['generation_acceptance', 'verification_catch_rate', 'explanation_quality']);
  });

  it('refuses to compare against a baseline that is not a passing run, or against another corpus, or another kind of version', () => {
    const failed = passing({ scores: { verification_catch_rate: 0.5 } });
    expect(expectError(evaluate(props({ baseline: failed }))).code).toBe('EVALUATION_BASELINE_NOT_PASSING');
    expect(expectError(evaluate(props({ corpus: 'golden-v2', baseline }))).code).toBe('EVALUATION_BASELINE_OTHER_CORPUS');
    expect(expectError(evaluate(props({ subject: { kind: 'model', versionId: MODEL }, baseline }))).code).toBe('EVALUATION_BASELINE_OTHER_SUBJECT_KIND');
  });
});

describe('the refusal to activate names every version that lacks a passing evaluation', () => {
  it('names one version', () => {
    const failure = versionsNotEvaluated([{ kind: 'prompt', versionId: PROMPT }]);
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('VERSION_NOT_EVALUATED');
    expect(failure.message).toContain(`prompt version ${PROMPT} has no passing evaluation run`);
    expect(failure.location).toBe('promptVersionId');
  });

  it('names both, model first', () => {
    const failure = versionsNotEvaluated([{ kind: 'model', versionId: MODEL }, { kind: 'prompt', versionId: PROMPT }]);
    expect(failure.message).toContain(`model version ${MODEL} and prompt version ${PROMPT} have no passing evaluation run`);
    expect(failure.location).toBe('modelVersionId');
  });
});
