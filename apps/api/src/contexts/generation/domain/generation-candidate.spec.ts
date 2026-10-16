import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  acceptCandidate,
  applyCandidateTransition,
  CANDIDATE_STATES,
  CANDIDATE_TRANSITIONS,
  createGenerationCandidate,
  isCandidateState,
  isCandidateTransition,
  rejectCandidate,
  type CandidateState,
  type CandidateTransition,
  type CreateGenerationCandidateProps,
  type GenerationCandidate,
} from './generation-candidate.js';

const PROPS: CreateGenerationCandidateProps = {
  candidateId: 'cand-1',
  pin: { modelVersionId: 'model-v3', promptVersionId: 'prompt-v7', runId: 'run-42' },
  content: { itemType: 'SINGLE_CORRECT_MCQ', body: { stem: 'A block slides down a ramp.', options: ['a', 'b'] } },
  verdicts: [
    { check: 'grounding', outcome: 'pass' },
    { check: 'duplicate', outcome: 'pass', detail: 'no neighbour above threshold' },
  ],
};

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
    expect(candidate.pin.modelVersionId).toBe('model-v3');
    expect(candidate.pin.promptVersionId).toBe('prompt-v7');
    expect(candidate.pin.runId).toBe('run-42');
    expect(candidate.content.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(candidate.verdicts.map((verdict) => verdict.check)).toEqual(['grounding', 'duplicate']);
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
      expectError(createGenerationCandidate({ ...PROPS, verdicts: [{ check: ' ', outcome: 'pass' }] })).code,
    ).toBe('VERDICT_CHECK_REQUIRED');
    expect(
      expectError(createGenerationCandidate({ ...PROPS, verdicts: [{ check: 'a', outcome: 'maybe' as never }] }))
        .code,
    ).toBe('VERDICT_OUTCOME_UNKNOWN');
    const repeated = expectError(
      createGenerationCandidate({
        ...PROPS,
        verdicts: [
          { check: 'a', outcome: 'fail' },
          { check: 'a', outcome: 'pass' },
        ],
      }),
    );
    expect(repeated.code).toBe('VERDICT_CHECK_DUPLICATED');
    expect(repeated.location).toBe('verdicts[1].check');
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
    const original = proposed();
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

  it('cannot accept a candidate nothing has checked', () => {
    const failure = expectError(acceptCandidate(proposed({ verdicts: [] })));
    expect(failure.kind).toBe('PreconditionFailed');
    expect(failure.code).toBe('CANDIDATE_NOT_PRECHECKED');
  });

  it('cannot accept a candidate with a failing verdict, naming the checks that failed', () => {
    const failure = expectError(
      acceptCandidate(
        proposed({
          verdicts: [
            { check: 'grounding', outcome: 'pass' },
            { check: 'duplicate', outcome: 'fail' },
            { check: 'difficulty', outcome: 'fail' },
          ],
        }),
      ),
    );
    expect(failure.code).toBe('CANDIDATE_PRECHECK_FAILED');
    expect(failure.message).toContain('duplicate, difficulty');
    expect(failure.message).not.toContain('grounding');
  });

  it('cannot accept twice, or accept what was rejected', () => {
    const accepted = expectValue(acceptCandidate(proposed()));
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
    expect(expectValue(rejectCandidate(proposed({ verdicts: [{ check: 'a', outcome: 'fail' }] }))).state).toBe(
      'rejected',
    );
  });

  it('is terminal', () => {
    const rejected = expectValue(rejectCandidate(proposed()));
    expect(expectError(rejectCandidate(rejected)).code).toBe('TRANSITION_ILLEGAL');
    const accepted = expectValue(acceptCandidate(proposed()));
    expect(expectError(rejectCandidate(accepted)).code).toBe('TRANSITION_ILLEGAL');
  });
});
