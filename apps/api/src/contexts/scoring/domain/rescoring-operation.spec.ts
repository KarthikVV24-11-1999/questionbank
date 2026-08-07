import { describe, expect, it } from 'vitest';
import { makeRational } from './numeric/decimal.js';
import { createAnswerKey, type AnswerKey } from './answer-key.js';
import { DEFAULT_AGGREGATION } from './aggregation-data.js';
import { createScoringInput, type ResponseSnapshot, type ScoredSlot, type ScoringInput } from './scoring-input.js';
import { scoreAttempt } from './score-attempt.js';
import { markSuperseded, type ScoreRecord } from './score-record.js';
import { buildDryRunResult, type RescoringPair } from './rescoring-dry-run.js';
import {
  approveRescoring,
  beginExecution,
  completeExecution,
  draftRescoring,
  recordDryRun,
  RESCORING_SCOPES,
  RESCORING_STATES,
  RESCORING_TRIGGERS,
  type RescoringOperation,
  type RescoringState,
} from './rescoring-operation.js';
import { JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const HASH = 'pinned-hash';
const keyB = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const keyA = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'A' }));

function slot(answerKey: AnswerKey, response: ResponseSnapshot): ScoredSlot {
  return {
    slotId: 'a',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: 'iv-a',
    marksAvailable: 4,
    marksAvailableExact: makeRational(4n, 1n),
    answerKey,
    response,
  };
}

function input(attemptId: string, answerKey: AnswerKey, chosen: string): ScoringInput {
  return expectValue(
    createScoringInput({
      attemptId,
      pin: {
        examProfileVersionId: 'epv-1',
        markingRuleSetHash: HASH,
        ruleSchemaVersion: 1,
        taxonomyVersionId: 'tax-1',
        itemVersionIds: ['iv-a'],
      },
      sections: [{ ordinal: 1, slots: [slot(answerKey, { kind: 'OPTION_SELECTION', optionIds: [chosen] })] }],
      overrides: [],
    }),
  );
}

function record(attemptId: string, answerKey: AnswerKey, chosen: string, id: string): ScoreRecord {
  return expectValue(
    scoreAttempt({
      input: input(attemptId, answerKey, chosen),
      ruleSet: JEE_MAIN_RULE_SET,
      ruleSetHash: HASH,
      aggregation: DEFAULT_AGGREGATION,
      computedAt: '2026-08-07T00:00:00.000Z',
      scoreRecordId: id,
    }),
  );
}

const drafted = (): RescoringOperation =>
  expectValue(
    draftRescoring({
      operationId: 'op-1',
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'iv-a',
      reason: 'answer key challenge upheld by the review board',
    }),
  );

const emptyDryRun = buildDryRunResult([]);

describe('drafting', () => {
  it('starts in the drafted state', () => {
    expect(drafted().state).toBe('drafted');
  });

  it('carries the trigger, scope and reason', () => {
    const operation = drafted();
    expect(operation.trigger).toBe('CHALLENGE_UPHELD');
    expect(operation.scope).toBe('ITEM_VERSION');
    expect(operation.reason).toContain('challenge upheld');
  });

  it('refuses a draft with no reason — a change to published results must be accountable', () => {
    const result = draftRescoring({
      operationId: 'op-1',
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'iv-a',
      reason: '   ',
    });
    expect(expectError(result).code).toBe('REASON_REQUIRED');
  });

  it('refuses a draft with no operation id or scope reference', () => {
    const base = {
      operationId: 'op-1',
      trigger: 'CHALLENGE_UPHELD' as const,
      scope: 'ITEM_VERSION' as const,
      scopeRef: 'iv-a',
      reason: 'r',
    };
    expect(expectError(draftRescoring({ ...base, operationId: ' ' })).code).toBe('OPERATION_ID_REQUIRED');
    expect(expectError(draftRescoring({ ...base, scopeRef: '' })).code).toBe('SCOPE_REF_REQUIRED');
  });

  it('refuses an unknown trigger or scope', () => {
    const base = {
      operationId: 'op-1',
      trigger: 'CHALLENGE_UPHELD' as const,
      scope: 'ITEM_VERSION' as const,
      scopeRef: 'iv-a',
      reason: 'r',
    };
    expect(expectError(draftRescoring({ ...base, trigger: 'VIBES' as never })).code).toBe('TRIGGER_UNKNOWN');
    expect(expectError(draftRescoring({ ...base, scope: 'EVERYTHING' as never })).code).toBe('SCOPE_UNKNOWN');
  });

  it('declares the triggers, scopes and states the domain model names', () => {
    expect([...RESCORING_TRIGGERS]).toHaveLength(3);
    expect([...RESCORING_SCOPES]).toEqual(['ITEM_VERSION', 'RULE_CHANGE', 'FORM']);
    expect([...RESCORING_STATES]).toEqual(['drafted', 'previewed', 'approved', 'executing', 'completed']);
  });
});

describe('the dry run is the gate, not a courtesy', () => {
  it('cannot approve a draft that has not been previewed', () => {
    expect(expectError(approveRescoring(drafted(), 'principal-1')).code).toBe('ILLEGAL_TRANSITION');
  });

  it('cannot execute a draft that has not been approved', () => {
    expect(expectError(beginExecution(drafted())).code).toBe('ILLEGAL_TRANSITION');
  });

  it('cannot execute a previewed operation that has not been approved', () => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    expect(expectError(beginExecution(previewed)).code).toBe('ILLEGAL_TRANSITION');
  });

  it('records the preview and moves to previewed', () => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    expect(previewed.state).toBe('previewed');
    expect(previewed.dryRunResult).toBe(emptyDryRun);
  });

  it('permits previewing again — an operator may look twice', () => {
    const once = expectValue(recordDryRun(drafted(), emptyDryRun));
    expect(expectValue(recordDryRun(once, emptyDryRun)).state).toBe('previewed');
  });

  it('requires a principal on approval', () => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    expect(expectError(approveRescoring(previewed, '  ')).code).toBe('APPROVAL_REQUIRES_PRINCIPAL');
  });

  it('records who approved it', () => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    expect(expectValue(approveRescoring(previewed, 'principal-1')).authorizedBy).toBe('principal-1');
  });

  it('refuses approval when the preview is somehow absent', () => {
    // Reaching `previewed` without a result should be impossible through the
    // API; the check makes the reason explicit rather than implied.
    const forged = { ...drafted(), state: 'previewed' as RescoringState };
    expect(expectError(approveRescoring(forged, 'principal-1')).code).toBe('APPROVAL_REQUIRES_DRY_RUN');
  });
});

describe('the state machine refuses every move it does not name', () => {
  const complete = (): RescoringOperation => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    const approved = expectValue(approveRescoring(previewed, 'principal-1'));
    const executing = expectValue(beginExecution(approved));
    return expectValue(completeExecution(executing, '2026-08-07T01:00:00.000Z'));
  };

  it('walks the whole legal path', () => {
    expect(complete().state).toBe('completed');
  });

  it('stamps when execution finished', () => {
    expect(complete().executedAt).toBe('2026-08-07T01:00:00.000Z');
  });

  it('requires an execution timestamp', () => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    const approved = expectValue(approveRescoring(previewed, 'principal-1'));
    const executing = expectValue(beginExecution(approved));
    expect(expectError(completeExecution(executing, ' ')).code).toBe('EXECUTED_AT_REQUIRED');
  });

  it('refuses to reopen a completed operation', () => {
    const completed = complete();
    expect(expectError(recordDryRun(completed, emptyDryRun)).code).toBe('ILLEGAL_TRANSITION');
    expect(expectError(approveRescoring(completed, 'p')).code).toBe('ILLEGAL_TRANSITION');
    expect(expectError(beginExecution(completed)).code).toBe('ILLEGAL_TRANSITION');
    expect(expectError(completeExecution(completed, 'now')).code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses to complete an operation that never began', () => {
    const previewed = expectValue(recordDryRun(drafted(), emptyDryRun));
    expect(expectError(completeExecution(previewed, 'now')).code).toBe('ILLEGAL_TRANSITION');
  });

  it('leaves the earlier operation untouched at every step', () => {
    const draft = drafted();
    const previewed = expectValue(recordDryRun(draft, emptyDryRun));
    expect(draft.state).toBe('drafted');
    expect(draft.dryRunResult).toBeUndefined();
    expect(previewed.state).toBe('previewed');
  });
});

describe('the dry-run preview', () => {
  const before = [record('att-1', keyB, 'A', 'sr-1'), record('att-2', keyB, 'B', 'sr-2')];
  const after = [record('att-1', keyA, 'A', 'sr-3'), record('att-2', keyA, 'B', 'sr-4')];
  const pairs: RescoringPair[] = [
    { before: before[0] as ScoreRecord, after: after[0] as ScoreRecord },
    { before: before[1] as ScoreRecord, after: after[1] as ScoreRecord },
  ];

  it('counts every affected attempt', () => {
    expect(buildDryRunResult(pairs).affectedAttemptCount).toBe(2);
  });

  it('reports who gained and who lost under the corrected key', () => {
    const result = buildDryRunResult(pairs);
    expect(result.scoreDeltaDistribution.improved).toBe(1);
    expect(result.scoreDeltaDistribution.worsened).toBe(1);
    expect(result.scoreDeltaDistribution.unchanged).toBe(0);
  });

  it('reports the largest gain and the largest loss', () => {
    const result = buildDryRunResult(pairs);
    expect(result.scoreDeltaDistribution.largestGain).toBe('5');
    expect(result.scoreDeltaDistribution.largestLoss).toBe('-5');
  });

  it('lists the per-attempt deltas so an operator sees who, not only how many', () => {
    const result = buildDryRunResult(pairs);
    expect(result.deltas).toEqual([
      { attemptId: 'att-1', before: '-1', after: '4', delta: '5' },
      { attemptId: 'att-2', before: '4', after: '-1', delta: '-5' },
    ]);
  });

  it('reports rank movement in both directions', () => {
    const result = buildDryRunResult(pairs);
    expect(result.rankMovement.movedUp).toBe(1);
    expect(result.rankMovement.movedDown).toBe(1);
    expect(result.rankMovement.unchanged).toBe(0);
  });

  it('reports no movement when nothing changes', () => {
    const unchanged: RescoringPair[] = [
      { before: before[0] as ScoreRecord, after: before[0] as ScoreRecord },
      { before: before[1] as ScoreRecord, after: before[1] as ScoreRecord },
    ];
    const result = buildDryRunResult(unchanged);
    expect(result.scoreDeltaDistribution.unchanged).toBe(2);
    expect(result.rankMovement).toEqual({ movedUp: 0, movedDown: 0, unchanged: 2 });
  });

  it('gives tied attempts the same rank, so a tie is not counted as movement', () => {
    const tied: RescoringPair[] = [
      { before: before[1] as ScoreRecord, after: after[1] as ScoreRecord },
      { before: before[1] as ScoreRecord, after: after[1] as ScoreRecord },
    ];
    expect(buildDryRunResult(tied).rankMovement.unchanged).toBe(2);
  });

  it('handles an empty scope', () => {
    const result = buildDryRunResult([]);
    expect(result.affectedAttemptCount).toBe(0);
    expect(result.scoreDeltaDistribution.largestGain).toBe('0');
    expect(result.deltas).toEqual([]);
  });

  it('is frozen', () => {
    const result = buildDryRunResult(pairs);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scoreDeltaDistribution)).toBe(true);
    expect(Object.isFrozen(result.deltas)).toBe(true);
  });
});

describe('execution retains both generations (INV-11)', () => {
  it('supersedes without touching the original record', () => {
    const original = record('att-1', keyB, 'A', 'sr-1');
    const superseded = markSuperseded(original);
    const successor = expectValue(
      scoreAttempt({
        input: input('att-1', keyA, 'A'),
        ruleSet: JEE_MAIN_RULE_SET,
        ruleSetHash: HASH,
        aggregation: DEFAULT_AGGREGATION,
        computedAt: '2026-08-07T01:00:00.000Z',
        scoreRecordId: 'sr-2',
        generation: 2,
        supersedesScoreRecordId: 'sr-1',
        reasonForRescore: 'answer key challenge upheld',
      }),
    );

    expect(original.isCurrent).toBe(true);
    expect(superseded.isCurrent).toBe(false);
    expect(successor.generation).toBe(2);
    expect(successor.supersedesScoreRecordId).toBe('sr-1');
    expect(successor.isCurrent).toBe(true);
  });
});
