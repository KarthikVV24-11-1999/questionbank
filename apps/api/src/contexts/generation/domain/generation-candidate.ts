import { err, ok, type Result } from './result.js';
import {
  preconditionFailedError,
  ruleViolationError,
  validationError,
  type GenerationError,
} from './generation-error.js';
import { createModelPin, type ModelPin, type ModelPinError, type ModelPinProps } from './model-pin.js';

/**
 * `GenerationCandidate` — what the pipeline proposes, and nothing it decides.
 *
 * Its lifecycle is **proposed → accepted | rejected** and nothing else.
 * Acceptance is what hands the candidate to content's authoring command;
 * rejection is terminal. There is no `published` state here because
 * publication is content's and only content's (ADR-0025, INV-01): generation
 * proposes, it never writes.
 *
 * `domain/` imports nothing, so the proposed content is held as a plain JSON
 * document and not as content's own types. Mapping it onto content's command
 * is the application layer's job, across `content/public/`.
 */

export const CANDIDATE_STATES = ['proposed', 'accepted', 'rejected'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export const CANDIDATE_TRANSITIONS = ['accept', 'reject'] as const;
export type CandidateTransition = (typeof CANDIDATE_TRANSITIONS)[number];

const TRANSITIONS: Readonly<Record<CandidateState, Partial<Record<CandidateTransition, CandidateState>>>> =
  Object.freeze({
    proposed: { accept: 'accepted', reject: 'rejected' },
    // Both terminal. An accepted candidate has already become a content draft,
    // and taking it back would mean un-submitting someone else's aggregate.
    accepted: {},
    rejected: {},
  });

export type CandidateLifecycleErrorCode = 'STATE_UNKNOWN' | 'TRANSITION_UNKNOWN' | 'TRANSITION_ILLEGAL';

export function isCandidateState(state: string): state is CandidateState {
  return (CANDIDATE_STATES as readonly string[]).includes(state);
}

export function isCandidateTransition(transition: string): transition is CandidateTransition {
  return (CANDIDATE_TRANSITIONS as readonly string[]).includes(transition);
}

export function applyCandidateTransition(
  from: CandidateState,
  transition: CandidateTransition,
  location = 'state',
): Result<CandidateState, GenerationError<CandidateLifecycleErrorCode>> {
  if (!isCandidateState(from)) {
    return err(validationError('STATE_UNKNOWN', `unknown candidate state "${from}"`, location));
  }
  if (!isCandidateTransition(transition)) {
    return err(validationError('TRANSITION_UNKNOWN', `unknown transition "${transition}"`, location));
  }

  const next = TRANSITIONS[from][transition];
  if (next === undefined) {
    return err(ruleViolationError('TRANSITION_ILLEGAL', `cannot ${transition} a candidate that is ${from}`, location));
  }
  return ok(next);
}

export const VERDICT_OUTCOMES = ['pass', 'fail'] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

/** One pre-check's result. `check` is the battery's stable identifier for it, never its prose. */
export interface PrecheckVerdict {
  readonly check: string;
  readonly outcome: VerdictOutcome;
  readonly detail?: string;
}

/** The proposal, as a JSON document. The shape of `body` is the application layer's to interpret. */
export interface ProposedContent {
  readonly itemType: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface GenerationCandidate {
  readonly candidateId: string;
  readonly pin: ModelPin;
  readonly content: ProposedContent;
  readonly verdicts: readonly PrecheckVerdict[];
  readonly state: CandidateState;
}

export type CandidateErrorCode =
  | 'CANDIDATE_ID_REQUIRED'
  | 'CONTENT_ITEM_TYPE_REQUIRED'
  | 'CONTENT_BODY_INVALID'
  | 'VERDICT_CHECK_REQUIRED'
  | 'VERDICT_OUTCOME_UNKNOWN'
  | 'VERDICT_CHECK_DUPLICATED'
  | 'CANDIDATE_PIN_INCOMPLETE'
  | 'CANDIDATE_NOT_PRECHECKED'
  | 'CANDIDATE_PRECHECK_FAILED';

export type CandidateError = GenerationError<CandidateErrorCode | CandidateLifecycleErrorCode> | ModelPinError;

export interface CreateGenerationCandidateProps {
  readonly candidateId: string;
  readonly pin: ModelPinProps;
  readonly content: ProposedContent;
  readonly verdicts: readonly PrecheckVerdict[];
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deep, frozen copy — the caller keeps no handle through which the proposal can change under review. */
function freezeCopy(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, freezeCopy(inner)])));
  }
  return value;
}

function checkVerdicts(verdicts: readonly PrecheckVerdict[]): Result<readonly PrecheckVerdict[], CandidateError> {
  const seen = new Set<string>();
  const frozen: PrecheckVerdict[] = [];

  for (const [index, verdict] of verdicts.entries()) {
    const location = `verdicts[${index}]`;
    if (isBlank(verdict.check)) {
      return err(validationError('VERDICT_CHECK_REQUIRED', 'a verdict must name its check', `${location}.check`));
    }
    if (!(VERDICT_OUTCOMES as readonly string[]).includes(verdict.outcome)) {
      return err(
        validationError('VERDICT_OUTCOME_UNKNOWN', `unknown verdict outcome "${verdict.outcome}"`, `${location}.outcome`),
      );
    }
    // Two verdicts for one check would let a later pass hide an earlier fail.
    if (seen.has(verdict.check)) {
      return err(
        validationError('VERDICT_CHECK_DUPLICATED', `check "${verdict.check}" has more than one verdict`, `${location}.check`),
      );
    }
    seen.add(verdict.check);
    frozen.push(
      Object.freeze(
        verdict.detail === undefined
          ? { check: verdict.check, outcome: verdict.outcome }
          : { check: verdict.check, outcome: verdict.outcome, detail: verdict.detail },
      ),
    );
  }
  return ok(Object.freeze(frozen));
}

export function createGenerationCandidate(
  props: CreateGenerationCandidateProps,
): Result<GenerationCandidate, CandidateError> {
  if (isBlank(props.candidateId)) {
    return err(validationError('CANDIDATE_ID_REQUIRED', 'candidateId is required', 'candidateId'));
  }

  const pin = createModelPin(props.pin);
  if (!pin.ok) return err(pin.error);

  if (isBlank(props.content.itemType)) {
    return err(validationError('CONTENT_ITEM_TYPE_REQUIRED', 'the proposal must name an item type', 'content.itemType'));
  }
  if (!isPlainObject(props.content.body)) {
    return err(validationError('CONTENT_BODY_INVALID', 'the proposal body must be a JSON object', 'content.body'));
  }

  const verdicts = checkVerdicts(props.verdicts);
  if (!verdicts.ok) return err(verdicts.error);

  return ok(
    Object.freeze({
      candidateId: props.candidateId,
      pin: pin.value,
      content: Object.freeze({
        itemType: props.content.itemType,
        body: freezeCopy(props.content.body) as Readonly<Record<string, unknown>>,
      }),
      verdicts: verdicts.value,
      state: 'proposed' as const,
    }),
  );
}

/**
 * Acceptance hands the candidate to content, so it is the one transition with
 * preconditions beyond the lifecycle.
 *
 * - **The pin is re-checked here, not trusted.** Construction already refuses
 *   an incomplete pin, but a candidate rehydrated from storage never went
 *   through construction, and an accepted artifact without a pin is the one
 *   thing F28 exists to make impossible.
 * - **Nothing unchecked is accepted.** Pre-checks are blocking for AI content,
 *   so a candidate with no verdicts has not been checked, and one with any
 *   failing verdict has been checked and found wanting.
 */
export function acceptCandidate(candidate: GenerationCandidate): Result<GenerationCandidate, CandidateError> {
  const next = applyCandidateTransition(candidate.state, 'accept');
  if (!next.ok) return err(next.error);

  const pin = createModelPin(candidate.pin);
  if (!pin.ok) {
    return err(
      preconditionFailedError(
        'CANDIDATE_PIN_INCOMPLETE',
        `a candidate cannot be accepted without a complete pin: ${pin.error.message}`,
        pin.error.location,
      ),
    );
  }

  if (candidate.verdicts.length === 0) {
    return err(
      preconditionFailedError('CANDIDATE_NOT_PRECHECKED', 'a candidate with no pre-check verdicts cannot be accepted', 'verdicts'),
    );
  }

  const failed = candidate.verdicts.filter((verdict) => verdict.outcome === 'fail').map((verdict) => verdict.check);
  if (failed.length > 0) {
    return err(
      preconditionFailedError(
        'CANDIDATE_PRECHECK_FAILED',
        `a candidate that failed pre-checks cannot be accepted: ${failed.join(', ')}`,
        'verdicts',
      ),
    );
  }

  return ok(Object.freeze({ ...candidate, state: next.value }));
}

/** Terminal. Rejection needs no precondition beyond the lifecycle's. */
export function rejectCandidate(candidate: GenerationCandidate): Result<GenerationCandidate, CandidateError> {
  const next = applyCandidateTransition(candidate.state, 'reject');
  if (!next.ok) return err(next.error);
  return ok(Object.freeze({ ...candidate, state: next.value }));
}
