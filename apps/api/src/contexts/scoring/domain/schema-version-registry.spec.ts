import { describe, expect, it } from 'vitest';
import { makeRational } from './numeric/decimal.js';
import { createAnswerKey } from './answer-key.js';
import { DEFAULT_AGGREGATION } from './aggregation-data.js';
import { createScoringInput, type ResponseSnapshot, type ScoredSlot, type ScoringInput } from './scoring-input.js';
import {
  executorFor,
  registeredVersions,
  scoreAttemptAtPinnedVersion,
  SHIPPED_SCHEMA_VERSIONS,
  type ScoringExecutor,
} from './schema-version-registry.js';
import { scoreAttempt, type ScoreAttemptProps } from './score-attempt.js';
import { rationalToDecimalString } from './numeric/decimal.js';
import { JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const HASH = 'pinned-hash';
const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));

function slot(response: ResponseSnapshot | undefined): ScoredSlot {
  return {
    slotId: 'a',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: 'iv-a',
    marksAvailable: 4,
    marksAvailableExact: makeRational(4n, 1n),
    answerKey: key,
    ...(response !== undefined ? { response } : {}),
  };
}

function input(ruleSchemaVersion: number): ScoringInput {
  return expectValue(
    createScoringInput({
      attemptId: 'attempt-1',
      pin: {
        examProfileVersionId: 'epv-1',
        markingRuleSetHash: HASH,
        ruleSchemaVersion,
        taxonomyVersionId: 'tax-1',
        itemVersionIds: ['iv-a'],
      },
      sections: [{ ordinal: 1, slots: [slot({ kind: 'OPTION_SELECTION', optionIds: ['B'] })] }],
      overrides: [],
    }),
  );
}

function props(ruleSchemaVersion: number): ScoreAttemptProps {
  return {
    input: input(ruleSchemaVersion),
    ruleSet: JEE_MAIN_RULE_SET,
    ruleSetHash: HASH,
    aggregation: DEFAULT_AGGREGATION,
    computedAt: '2026-08-07T00:00:00.000Z',
    scoreRecordId: 'sr-1',
  };
}

describe('every version ever shipped stays supported (F48)', () => {
  it('registers an executor for each shipped version', () => {
    for (const version of SHIPPED_SCHEMA_VERSIONS) {
      expect(executorFor(version).ok, `version ${version}`).toBe(true);
    }
  });

  it('registers exactly the shipped versions and nothing else', () => {
    expect(registeredVersions()).toEqual([...SHIPPED_SCHEMA_VERSIONS].sort((a, b) => a - b));
  });

  it('fails when a shipped version loses its executor', () => {
    // The planted violation: a registry with version 1 deleted. If someone
    // removes an executor for real, the check above fails exactly like this.
    const stripped = new Map<number, ScoringExecutor>();
    for (const version of SHIPPED_SCHEMA_VERSIONS) {
      expect(executorFor(version, stripped).ok, `version ${version}`).toBe(false);
    }
  });
});

describe('dispatch', () => {
  it('routes version 1 to the M2-15 executor', () => {
    const record = expectValue(scoreAttemptAtPinnedVersion(props(1)));
    expect(rationalToDecimalString(record.totalScore.raw)).toBe('4');
  });

  it('produces the same record as calling the executor directly', () => {
    expect(expectValue(scoreAttemptAtPinnedVersion(props(1)))).toEqual(expectValue(scoreAttempt(props(1))));
  });

  it('records the pinned version on the score record', () => {
    expect(expectValue(scoreAttemptAtPinnedVersion(props(1))).ruleSchemaVersion).toBe(1);
  });

  it('refuses an unregistered version rather than scoring a best effort', () => {
    const error = expectError(scoreAttemptAtPinnedVersion(props(99)));
    expect(error.code).toBe('RULE_SCHEMA_VERSION_UNSUPPORTED');
    expect(error.kind).toBe('PreconditionFailed');
  });

  it('names the version it could not serve', () => {
    expect(expectError(scoreAttemptAtPinnedVersion(props(99))).message).toContain('99');
  });

  it('returns the executor itself for a registered version', () => {
    expect(typeof expectValue(executorFor(1))).toBe('function');
  });
});
