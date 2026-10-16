import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  acceptCandidate,
  applyCandidateTransition,
  CANDIDATE_STATES,
  CANDIDATE_TRANSITIONS,
  createGenerationCandidate,
  failedBlockingChecks,
  isCandidateState,
  isForReview,
  isCandidateTransition,
  recordVerdict,
  rejectCandidate,
  restoreGenerationCandidate,
  type CandidateState,
  type CandidateTransition,
  type CreateGenerationCandidateProps,
  type GenerationCandidate,
} from './generation-candidate.js';
import { BLOCKING_PRECHECKS, type PrecheckId } from './precheck-vocabulary.js';

const PROPS: CreateGenerationCandidateProps = {
  candidateId: 'cand-1',
  pin: { modelVersionId: '00000000-0000-4000-8000-0000000a0003', promptVersionId: '00000000-0000-4000-8000-0000000b0007', runId: '00000000-0000-4000-8000-0000000c0042' },
  content: { itemType: 'SINGLE_CORRECT_MCQ', body: { stem: 'A block slides down a ramp.', options: ['a', 'b'] } },
  confidence: 0.85,
  verdicts: [
    { check: 'schema_validity', outcome: 'pass' },
    { check: 'duplicate_detection', outcome: 'pass', detail: 'no neighbour above threshold' },
  ],
};

/** A verdict for every blocking check, all passing — the least a candidate needs to be accepted. */
const BLOCKING_ALL_PASS = BLOCKING_PRECHECKS.map((check) => ({ check, outcome: 'pass' as const }));
const fullyChecked = (overrides: Partial<CreateGenerationCandidateProps> = {}): GenerationCandidate =>
  proposed({ verdicts: BLOCKING_ALL_PASS, ...overrides });

const proposed = (overrides: Partial<CreateGenerationCandidateProps> = {}): GenerationCandidate =>
  expectValue(createGenerationCandidate({ ...PROPS, ...overrides }));

describe('the vocabulary', () => {
  it('is three states and two transitions', () => {
    expect([...CANDIDATE_STATES]).toEqual(['proposed', 'accepted', 'rejected']);
    expect([...CANDIDATE_TRANSITIONS]).toEqual(['accept', 'reject']);
  });

  it('has no published state — publication is content’s and only content’s', () => {
    expect(isCandidateState('published')).toBe(false);
    expect(isCandidateTransition('publish')).toBe(false);
  });

  it('recognises each state and transition and rejects anything else', () => {
    for (const state of CANDIDATE_STATES) expect(isCandidateState(state)).toBe(true);
    for (const transition of CANDIDATE_TRANSITIONS) expect(isCandidateTransition(transition)).toBe(true);
    expect(isCandidateState('archived')).toBe(false);
    expect(isCandidateTransition('retire')).toBe(false);
  });
});

/** Written out independently of the implementation; the sweep below says which cell disagrees. */
const LEGAL: readonly (readonly [CandidateState, CandidateTransition, CandidateState])[] = [
  ['proposed', 'accept', 'accepted'],
  ['proposed', 'reject', 'rejected'],
];

describe('the exhaustive 3 × 2 transition matrix', () => {
  for (const from of CANDIDATE_STATES) {
    for (const transition of CANDIDATE_TRANSITIONS) {
      const expected = LEGAL.find(([state, name]) => state === from && name === transition);

      if (expected !== undefined) {
        it(`permits ${transition} from ${from}, reaching ${expected[2]}`, () => {
          expect(expectValue(applyCandidateTransition(from, transition))).toBe(expected[2]);
        });
      } else {
        it(`refuses ${transition} from ${from}`, () => {
          const failure = expectError(applyCandidateTransition(from, transition));
          expect(failure.code).toBe('TRANSITION_ILLEGAL');
          expect(failure.kind).toBe('RuleViolation');
          expect(failure.message).toContain(transition);
          expect(failure.message).toContain(from);
        });
      }
    }
  }

  it('covers every cell exactly once', () => {
    expect(CANDIDATE_STATES.length * CANDIDATE_TRANSITIONS.length).toBe(6);
    expect(LEGAL).toHaveLength(2);
  });

  it('makes accepted and rejected terminal', () => {
    for (const transition of CANDIDATE_TRANSITIONS) {
      expect(expectError(applyCandidateTransition('accepted', transition)).code).toBe('TRANSITION_ILLEGAL');
      expect(expectError(applyCandidateTransition('rejected', transition)).code).toBe('TRANSITION_ILLEGAL');
    }
  });

  it('refuses an unknown state and an unknown transition by name', () => {
    expect(expectError(applyCandidateTransition('archived' as CandidateState, 'accept')).code).toBe('STATE_UNKNOWN');
    expect(expectError(applyCandidateTransition('proposed', 'publish' as CandidateTransition)).code).toBe(
      'TRANSITION_UNKNOWN',
    );
  });

  it('reports the location it was given', () => {
    expect(expectError(applyCandidateTransition('accepted', 'accept', 'candidate.state')).location).toBe(
      'candidate.state',
    );
  });
});

describe('construction', () => {
  it('builds a proposed candidate carrying its pin, content and verdicts', () => {
    const candidate = proposed();
    expect(candidate.state).toBe('proposed');
    expect(candidate.candidateId).toBe('cand-1');
    expect(candidate.pin.modelVersionId).toBe('00000000-0000-4000-8000-0000000a0003');
    expect(candidate.pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    expect(candidate.pin.runId).toBe('00000000-0000-4000-8000-0000000c0042');
    expect(candidate.content.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(candidate.verdicts.map((verdict) => verdict.check)).toEqual(['schema_validity', 'duplicate_detection']);
  });

  it('keeps a verdict’s detail when given and omits the key when not', () => {
    const [first, second] = proposed().verdicts;
    expect(Object.hasOwn(first!, 'detail')).toBe(false);
    expect(second?.detail).toBe('no neighbour above threshold');
  });

  it('refuses a blank candidate id', () => {
    const failure = expectError(createGenerationCandidate({ ...PROPS, candidateId: ' ' }));
    expect(failure.code).toBe('CANDIDATE_ID_REQUIRED');
    expect(failure.location).toBe('candidateId');
  });

  it('is unconstructible without a complete pin, naming the missing member', () => {
    for (const field of ['modelVersionId', 'promptVersionId', 'runId'] as const) {
      const failure = expectError(createGenerationCandidate({ ...PROPS, pin: { ...PROPS.pin, [field]: '' } }));
      expect(failure.kind).toBe('Validation');
      expect(failure.location).toBe(field);
    }
  });

  it('refuses a proposal with no item type', () => {
    const failure = expectError(createGenerationCandidate({ ...PROPS, content: { ...PROPS.content, itemType: '' } }));
    expect(failure.code).toBe('CONTENT_ITEM_TYPE_REQUIRED');
  });

  it('refuses a proposal body that is not a JSON object', () => {
    for (const body of [null, [], 'text', 3]) {
      const failure = expectError(
        createGenerationCandidate({ ...PROPS, content: { itemType: 'X', body: body as never } }),
      );
      expect(failure.code).toBe('CONTENT_BODY_INVALID');
    }
  });

  it('refuses a verdict with no check, an unknown outcome, or a repeated check', () => {
    expect(
      expectError(createGenerationCandidate({ ...PROPS, verdicts: [{ check: ' ' as never, outcome: 'pass' }] })).code,
    ).toBe('VERDICT_CHECK_REQUIRED');
    expect(
      expectError(
        createGenerationCandidate({ ...PROPS, verdicts: [{ check: 'schema_validity', outcome: 'maybe' as never }] }),
      ).code,
    ).toBe('VERDICT_OUTCOME_UNKNOWN');
    const unknownCheck = expectError(
      createGenerationCandidate({ ...PROPS, verdicts: [{ check: 'grounding' as never, outcome: 'pass' }] }),
    );
    expect(unknownCheck.code).toBe('VERDICT_CHECK_UNKNOWN');
    expect(unknownCheck.location).toBe('verdicts[0].check');
    const repeated = expectError(
      createGenerationCandidate({
        ...PROPS,
        verdicts: [
          { check: 'schema_validity', outcome: 'fail' },
          { check: 'schema_validity', outcome: 'pass' },
        ],
      }),
    );
    expect(repeated.code).toBe('VERDICT_CHECK_DUPLICATED');
    expect(repeated.location).toBe('verdicts[1].check');
  });

  it('carries its confidence, and keeps the boundary values', () => {
    expect(proposed().confidence).toBe(0.85);
    expect(proposed({ confidence: 0 }).confidence).toBe(0);
    expect(proposed({ confidence: 1 }).confidence).toBe(1);
  });

  it('refuses an absent confidence as a different failure from an out-of-range one', () => {
    for (const confidence of [undefined, null, '0.5']) {
      const failure = expectError(createGenerationCandidate({ ...PROPS, confidence: confidence as never }));
      expect(failure.kind).toBe('Validation');
      expect(failure.code).toBe('CONFIDENCE_REQUIRED');
      expect(failure.location).toBe('confidence');
    }
  });

  it('refuses a confidence that cannot be a probability: below 0, above 1, NaN, infinite', () => {
    for (const confidence of [-0.0001, 1.0001, 2, -1, Number.NaN, Infinity, -Infinity]) {
      const failure = expectError(createGenerationCandidate({ ...PROPS, confidence }));
      expect(failure.code, String(confidence)).toBe('CONFIDENCE_OUT_OF_RANGE');
      expect(failure.location).toBe('confidence');
    }
  });

  it('accepts a candidate with no verdicts yet — it is proposed, not accepted', () => {
    expect(proposed({ verdicts: [] }).verdicts).toEqual([]);
  });
});

describe('immutability — the proposal cannot change under review', () => {
  it('freezes the candidate, its pin, its content and every nested level', () => {
    const candidate = proposed({
      content: { itemType: 'X', body: { list: [{ inner: 1 }], nested: { deep: { value: 'v' } }, plain: 'p' } },
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.pin)).toBe(true);
    expect(Object.isFrozen(candidate.content)).toBe(true);
    expect(Object.isFrozen(candidate.content.body)).toBe(true);
    expect(Object.isFrozen(candidate.verdicts)).toBe(true);
    expect(Object.isFrozen(candidate.verdicts[0])).toBe(true);
    const body = candidate.content.body as { list: object[]; nested: { deep: object } };
    expect(Object.isFrozen(body.list)).toBe(true);
    expect(Object.isFrozen(body.list[0])).toBe(true);
    expect(Object.isFrozen(body.nested.deep)).toBe(true);
  });

  it('holds a copy, so mutating the caller’s object afterwards changes nothing', () => {
    const body: Record<string, unknown> = { stem: 'original' };
    const candidate = proposed({ content: { itemType: 'X', body } });
    body['stem'] = 'tampered';
    expect(candidate.content.body['stem']).toBe('original');
  });
});

describe('accepting', () => {
  it('moves a fully pre-checked candidate to accepted, leaving the original untouched', () => {
    const original = fullyChecked();
    const accepted = expectValue(acceptCandidate(original));
    expect(accepted.state).toBe('accepted');
    expect(original.state).toBe('proposed');
    expect(accepted.pin).toBe(original.pin);
    expect(Object.isFrozen(accepted)).toBe(true);
  });

  it('cannot accept without a complete pin — even one that never went through construction', () => {
    for (const field of ['modelVersionId', 'promptVersionId', 'runId'] as const) {
      const forged = { ...proposed(), pin: { ...PROPS.pin, [field]: '' } } as GenerationCandidate;
      const failure = expectError(acceptCandidate(forged));
      expect(failure.kind).toBe('PreconditionFailed');
      expect(failure.code).toBe('CANDIDATE_PIN_INCOMPLETE');
      expect(failure.location).toBe(field);
    }
  });

  it('cannot accept a candidate nothing has checked, naming every blocking check it lacks', () => {
    const failure = expectError(acceptCandidate(proposed({ verdicts: [] })));
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
    for (const check of BLOCKING_PRECHECKS) expect(failure.message).toContain(check);
    expect(failure.message).not.toContain('duplicate_detection');
  });

  it('cannot accept a candidate missing even one blocking verdict', () => {
    for (const omitted of BLOCKING_PRECHECKS) {
      const failure = expectError(
        acceptCandidate(proposed({ verdicts: BLOCKING_ALL_PASS.filter((verdict) => verdict.check !== omitted) })),
      );
      expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
      expect(failure.message).toContain(omitted);
    }
  });

  it('cannot accept a candidate with a failing blocking verdict, naming the checks that failed', () => {
    const failure = expectError(
      acceptCandidate(
        proposed({
          verdicts: BLOCKING_ALL_PASS.map((verdict) =>
            verdict.check === 'answer_verification' || verdict.check === 'distractor_validity'
              ? { ...verdict, outcome: 'fail' as const }
              : verdict,
          ),
        }),
      ),
    );
    expect(failure.code).toBe('CANDIDATE_PRECHECK_FAILED');
    expect(failure.message).toContain('answer_verification, distractor_validity');
    expect(failure.message).not.toContain('schema_validity');
  });

  it('accepts a candidate whose only failures are advisory — they inform the reviewer, they do not block', () => {
    const accepted = expectValue(
      acceptCandidate(
        proposed({
          verdicts: [
            ...BLOCKING_ALL_PASS,
            { check: 'duplicate_detection', outcome: 'fail', detail: 'near neighbour' },
            { check: 'difficulty_plausibility', outcome: 'fail' },
            { check: 'ambiguity_clarity', outcome: 'fail' },
          ],
        }),
      ),
    );
    expect(accepted.state).toBe('accepted');
    expect(accepted.verdicts.filter((verdict) => verdict.outcome === 'fail')).toHaveLength(3);
  });

  it('reports a failed blocking check before a missing one', () => {
    const failure = expectError(acceptCandidate(proposed({ verdicts: [{ check: 'renderability', outcome: 'fail' }] })));
    expect(failure.code).toBe('CANDIDATE_PRECHECK_FAILED');
  });

  it('cannot accept twice, or accept what was rejected', () => {
    const accepted = expectValue(acceptCandidate(fullyChecked()));
    expect(expectError(acceptCandidate(accepted)).code).toBe('TRANSITION_ILLEGAL');
    const rejected = expectValue(rejectCandidate(proposed()));
    expect(expectError(acceptCandidate(rejected)).code).toBe('TRANSITION_ILLEGAL');
  });

  it('checks the lifecycle before the preconditions', () => {
    const rejectedAndUnchecked = expectValue(rejectCandidate(proposed({ verdicts: [] })));
    expect(expectError(acceptCandidate(rejectedAndUnchecked)).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('rejecting', () => {
  it('moves a proposed candidate to rejected, whatever its verdicts', () => {
    expect(expectValue(rejectCandidate(proposed())).state).toBe('rejected');
    expect(expectValue(rejectCandidate(proposed({ verdicts: [{ check: 'schema_validity', outcome: 'fail' }] }))).state).toBe(
      'rejected',
    );
  });

  it('is terminal', () => {
    const rejected = expectValue(rejectCandidate(proposed()));
    expect(expectError(rejectCandidate(rejected)).code).toBe('TRANSITION_ILLEGAL');
    const accepted = expectValue(acceptCandidate(fullyChecked()));
    expect(expectError(rejectCandidate(accepted)).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('recording a verdict', () => {
  const VERDICT = { check: 'answer_verification', outcome: 'pass', detail: 'two independent solves agree' } as const;

  it('returns a new candidate carrying the verdict, mutating nothing', () => {
    const original = proposed({ verdicts: [] });
    const recorded = expectValue(recordVerdict(original, VERDICT));
    expect(recorded.verdicts).toEqual([VERDICT]);
    expect(original.verdicts).toEqual([]);
    expect(recorded).not.toBe(original);
    expect(recorded.candidateId).toBe(original.candidateId);
    expect(recorded.pin).toBe(original.pin);
    expect(recorded.content).toBe(original.content);
    expect(recorded.state).toBe('proposed');
  });

  it('appends in order and freezes what it returns', () => {
    const once = expectValue(recordVerdict(proposed({ verdicts: [] }), { check: 'schema_validity', outcome: 'pass' }));
    const twice = expectValue(recordVerdict(once, VERDICT));
    expect(twice.verdicts.map((verdict) => verdict.check)).toEqual(['schema_validity', 'answer_verification']);
    expect(Object.isFrozen(twice)).toBe(true);
    expect(Object.isFrozen(twice.verdicts)).toBe(true);
    expect(Object.isFrozen(twice.verdicts[1])).toBe(true);
    expect(once.verdicts).toHaveLength(1);
  });

  it('refuses on an accepted or a rejected candidate, naming the state', () => {
    const accepted = expectValue(acceptCandidate(fullyChecked()));
    const rejected = expectValue(rejectCandidate(proposed({ verdicts: [] })));
    for (const [candidate, state] of [
      [accepted, 'accepted'],
      [rejected, 'rejected'],
    ] as const) {
      const failure = expectError(recordVerdict(candidate, { check: 'duplicate_detection', outcome: 'pass' }));
      expect(failure.kind).toBe('RuleViolation');
      expect(failure.code).toBe('VERDICT_CANDIDATE_NOT_PROPOSED');
      expect(failure.message).toContain(state);
    }
  });

  it('refuses the same check twice as a Conflict, leaving the first verdict standing', () => {
    const once = expectValue(recordVerdict(proposed({ verdicts: [] }), { check: 'renderability', outcome: 'fail' }));
    const failure = expectError(recordVerdict(once, { check: 'renderability', outcome: 'pass' }));
    expect(failure.kind).toBe('Conflict');
    expect(failure.code).toBe('VERDICT_ALREADY_RECORDED');
    expect(failure.location).toBe('verdict.check');
    expect(once.verdicts).toEqual([{ check: 'renderability', outcome: 'fail' }]);
  });

  it('refuses a malformed verdict the way construction does', () => {
    const candidate = proposed({ verdicts: [] });
    expect(expectError(recordVerdict(candidate, { check: ' ' as never, outcome: 'pass' })).code).toBe(
      'VERDICT_CHECK_REQUIRED',
    );
    expect(expectError(recordVerdict(candidate, { check: 'grounding' as never, outcome: 'pass' })).code).toBe(
      'VERDICT_CHECK_UNKNOWN',
    );
    expect(expectError(recordVerdict(candidate, { check: 'renderability', outcome: 'maybe' as never })).code).toBe(
      'VERDICT_OUTCOME_UNKNOWN',
    );
  });

  it('reaches acceptance end to end: twelve recorded verdicts, then accepted', () => {
    const checks: readonly PrecheckId[] = [...BLOCKING_PRECHECKS, 'duplicate_detection', 'difficulty_plausibility', 'ambiguity_clarity'];
    let candidate = proposed({ verdicts: [] });
    for (const check of checks) candidate = expectValue(recordVerdict(candidate, { check, outcome: 'pass' }));
    expect(candidate.verdicts).toHaveLength(12);
    expect(expectValue(acceptCandidate(candidate)).state).toBe('accepted');
  });
});

describe('restoring a candidate from storage', () => {
  const RESTORE = { ...PROPS, state: 'proposed' as CandidateState };

  it('rebuilds a candidate in every state it can be left in, field by field', () => {
    for (const state of CANDIDATE_STATES) {
      const candidate = expectValue(restoreGenerationCandidate({ ...RESTORE, state }));
      expect(candidate.state).toBe(state);
      expect(candidate.candidateId).toBe(PROPS.candidateId);
      expect(candidate.pin.modelVersionId).toBe('00000000-0000-4000-8000-0000000a0003');
      expect(candidate.pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
      expect(candidate.pin.runId).toBe('00000000-0000-4000-8000-0000000c0042');
      expect(candidate.content.itemType).toBe('SINGLE_CORRECT_MCQ');
      expect(candidate.verdicts).toHaveLength(2);
      expect(candidate.confidence).toBe(0.85);
      expect(Object.isFrozen(candidate)).toBe(true);
    }
  });

  it('refuses a state outside the closed three', () => {
    const failure = expectError(restoreGenerationCandidate({ ...RESTORE, state: 'published' as never }));
    expect(failure.code).toBe('STATE_UNKNOWN');
    expect(failure.location).toBe('state');
  });

  it('validates what it rebuilds exactly as construction does', () => {
    expect(
      expectError(restoreGenerationCandidate({ ...RESTORE, pin: { ...PROPS.pin, runId: '' }, state: 'accepted' })).code,
    ).toBe('RUN_ID_REQUIRED');
    expect(
      expectError(restoreGenerationCandidate({ ...RESTORE, verdicts: [{ check: 'x' as never, outcome: 'pass' }] })).code,
    ).toBe('VERDICT_CHECK_UNKNOWN');
  });
});

describe('which candidates a person has something to decide about (M5-39)', () => {
  const failing = (check: PrecheckId, outcome: 'pass' | 'fail' = 'fail') => ({ check, outcome });

  it('names the blocking checks a candidate failed, in the order they were recorded, and nothing else', () => {
    const candidate = proposed({ verdicts: [failing('renderability'), failing('schema_validity', 'pass'), failing('answer_verification')] });
    expect(failedBlockingChecks(candidate)).toEqual(['renderability', 'answer_verification']);
  });

  it('does not count an advisory check that failed: it informs a reviewer and blocks nothing', () => {
    const candidate = proposed({ verdicts: [failing('duplicate_detection'), failing('ambiguity_clarity')] });
    expect(failedBlockingChecks(candidate)).toEqual([]);
    expect(isForReview(candidate)).toBe(true);
  });

  it('does not count a blocking check that has no verdict: not having run is not having failed', () => {
    expect(failedBlockingChecks(proposed({ verdicts: [] }))).toEqual([]);
    expect(isForReview(proposed({ verdicts: [] }))).toBe(true);
  });

  it('is for review when every verdict passed, and not when any blocking verdict failed', () => {
    expect(isForReview(fullyChecked())).toBe(true);
    for (const check of BLOCKING_PRECHECKS) {
      const verdicts = BLOCKING_PRECHECKS.map((id) => failing(id, id === check ? 'fail' : 'pass'));
      expect(isForReview(proposed({ verdicts })), check).toBe(false);
    }
  });

  it('agrees with acceptance exactly: a candidate acceptance refuses for a failed check is a candidate not for review', () => {
    for (const check of BLOCKING_PRECHECKS) {
      const verdicts = BLOCKING_PRECHECKS.map((id) => failing(id, id === check ? 'fail' : 'pass'));
      const candidate = proposed({ verdicts });
      expect(expectError(acceptCandidate(candidate)).code, check).toBe('CANDIDATE_PRECHECK_FAILED');
      expect(isForReview(candidate), check).toBe(false);
    }
    expect(expectValue(acceptCandidate(fullyChecked())).state).toBe('accepted');
    expect(isForReview(fullyChecked())).toBe(true);
  });
});
