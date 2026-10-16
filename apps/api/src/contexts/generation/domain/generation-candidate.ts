import { err, ok, type Result } from './result.js';
import {
  conflictError,
  preconditionFailedError,
  ruleViolationError,
  validationError,
  type GenerationError,
} from './generation-error.js';
import { freezeJson, isJsonObject } from './json-document.js';
import { BLOCKING_PRECHECKS, isPrecheckId, precheckSeverity, type PrecheckId } from './precheck-vocabulary.js';
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
  readonly check: PrecheckId;
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
  /**
   * How sure the model was, in [0, 1]. Content's AI provenance requires it, so
   * a candidate without one could never become a draft.
   */
  readonly confidence: number;
  readonly state: CandidateState;
}

export type CandidateErrorCode =
  | 'CANDIDATE_ID_REQUIRED'
  | 'CONTENT_ITEM_TYPE_REQUIRED'
  | 'CONTENT_BODY_INVALID'
  | 'CONFIDENCE_REQUIRED'
  | 'CONFIDENCE_OUT_OF_RANGE'
  | 'VERDICT_CHECK_REQUIRED'
  | 'VERDICT_CHECK_UNKNOWN'
  | 'VERDICT_OUTCOME_UNKNOWN'
  | 'VERDICT_CHECK_DUPLICATED'
  | 'VERDICT_CANDIDATE_NOT_PROPOSED'
  | 'VERDICT_ALREADY_RECORDED'
  | 'CANDIDATE_PIN_INCOMPLETE'
  | 'CANDIDATE_NOT_PRECHECKED'
  | 'CANDIDATE_PRECHECK_FAILED';

export type CandidateError = GenerationError<CandidateErrorCode | CandidateLifecycleErrorCode> | ModelPinError;

export interface CreateGenerationCandidateProps {
  readonly candidateId: string;
  readonly pin: ModelPinProps;
  readonly content: ProposedContent;
  readonly verdicts: readonly PrecheckVerdict[];
  readonly confidence: number;
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/** One verdict, validated and frozen. `location` is where it sits, so the error can say where. */
function checkVerdict(verdict: PrecheckVerdict, location: string): Result<PrecheckVerdict, CandidateError> {
  if (isBlank(verdict.check)) {
    return err(validationError('VERDICT_CHECK_REQUIRED', 'a verdict must name its check', `${location}.check`));
  }
  // The vocabulary is closed (§11): a verdict for a check the battery does not
  // have is a typo or a stale producer, and stored it would never be read.
  if (!isPrecheckId(verdict.check)) {
    return err(
      validationError('VERDICT_CHECK_UNKNOWN', `"${verdict.check}" is not one of the pre-checks`, `${location}.check`),
    );
  }
  if (!(VERDICT_OUTCOMES as readonly string[]).includes(verdict.outcome)) {
    return err(
      validationError('VERDICT_OUTCOME_UNKNOWN', `unknown verdict outcome "${verdict.outcome}"`, `${location}.outcome`),
    );
  }
  return ok(
    Object.freeze(
      verdict.detail === undefined
        ? { check: verdict.check, outcome: verdict.outcome }
        : { check: verdict.check, outcome: verdict.outcome, detail: verdict.detail },
    ),
  );
}

function checkVerdicts(verdicts: readonly PrecheckVerdict[]): Result<readonly PrecheckVerdict[], CandidateError> {
  const seen = new Set<string>();
  const frozen: PrecheckVerdict[] = [];

  for (const [index, verdict] of verdicts.entries()) {
    const location = `verdicts[${index}]`;
    const checked = checkVerdict(verdict, location);
    if (!checked.ok) return err(checked.error);
    // Two verdicts for one check would let a later pass hide an earlier fail.
    if (seen.has(verdict.check)) {
      return err(
        validationError('VERDICT_CHECK_DUPLICATED', `check "${verdict.check}" has more than one verdict`, `${location}.check`),
      );
    }
    seen.add(verdict.check);
    frozen.push(checked.value);
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
  if (!isJsonObject(props.content.body)) {
    return err(validationError('CONTENT_BODY_INVALID', 'the proposal body must be a JSON object', 'content.body'));
  }

  // Absence and range are different failures: the first is a producer that
  // never supplied one, the second a number that cannot be a probability. NaN
  // is a number, and falls to the second.
  if (typeof props.confidence !== 'number') {
    return err(validationError('CONFIDENCE_REQUIRED', 'a candidate must carry a confidence', 'confidence'));
  }
  if (!Number.isFinite(props.confidence) || props.confidence < 0 || props.confidence > 1) {
    return err(
      validationError('CONFIDENCE_OUT_OF_RANGE', `confidence must lie in [0, 1], got ${props.confidence}`, 'confidence'),
    );
  }

  const verdicts = checkVerdicts(props.verdicts);
  if (!verdicts.ok) return err(verdicts.error);

  return ok(
    Object.freeze({
      candidateId: props.candidateId,
      pin: pin.value,
      content: Object.freeze({
        itemType: props.content.itemType,
        body: freezeJson(props.content.body) as Readonly<Record<string, unknown>>,
      }),
      verdicts: verdicts.value,
      confidence: props.confidence,
      state: 'proposed' as const,
    }),
  );
}

export interface RestoreGenerationCandidateProps extends CreateGenerationCandidateProps {
  readonly state: CandidateState;
}

/**
 * Rebuilds a candidate a repository read back, in whatever state it was left.
 *
 * Construction always yields a proposed candidate, so storage needs its own
 * way in. It is not a way around anything: the pin, the proposal and every
 * verdict are validated exactly as at construction, and the state must be one
 * of the closed three. What it does not re-litigate is the lifecycle — an
 * accepted candidate is read back accepted, because that is what happened.
 * `acceptCandidate` still re-checks the pin of whatever it is handed.
 */
export function restoreGenerationCandidate(
  props: RestoreGenerationCandidateProps,
): Result<GenerationCandidate, CandidateError> {
  if (!isCandidateState(props.state)) {
    return err(validationError('STATE_UNKNOWN', `unknown candidate state "${props.state}"`, 'state'));
  }

  const candidate = createGenerationCandidate(props);
  if (!candidate.ok) return candidate;
  return ok(Object.freeze({ ...candidate.value, state: props.state }));
}

/**
 * Records one pre-check's verdict on a candidate, returning a new candidate and
 * mutating nothing.
 *
 * - Only a **proposed** candidate takes a verdict. An accepted candidate has
 *   already gone to content and a rejected one is closed; a verdict written
 *   afterwards would rewrite the record the decision was made on.
 * - A check is recorded **once**. A second verdict for it is a `Conflict`, not
 *   an overwrite: the battery's results are an audit trail, and a re-run is a
 *   new run with a new candidate.
 */
export function recordVerdict(
  candidate: GenerationCandidate,
  verdict: PrecheckVerdict,
): Result<GenerationCandidate, CandidateError> {
  if (candidate.state !== 'proposed') {
    return err(
      ruleViolationError(
        'VERDICT_CANDIDATE_NOT_PROPOSED',
        `a verdict can only be recorded on a proposed candidate, and this one is ${candidate.state}`,
        'state',
      ),
    );
  }

  const checked = checkVerdict(verdict, 'verdict');
  if (!checked.ok) return err(checked.error);

  if (candidate.verdicts.some((recorded) => recorded.check === verdict.check)) {
    return err(
      conflictError('VERDICT_ALREADY_RECORDED', `check "${verdict.check}" already has a verdict`, 'verdict.check'),
    );
  }

  return ok(Object.freeze({ ...candidate, verdicts: Object.freeze([...candidate.verdicts, checked.value]) }));
}

/**
 * Acceptance hands the candidate to content, so it is the one transition with
 * preconditions beyond the lifecycle.
 *
 * - **The pin is re-checked here, not trusted.** Construction already refuses
 *   an incomplete pin, but a candidate rehydrated from storage never went
 *   through construction, and an accepted artifact without a pin is the one
 *   thing F28 exists to make impossible.
 * - **Nothing unchecked is accepted.** Blocking pre-checks are mandatory for
 *   AI content, so every blocking check must have a verdict and every one of
 *   those must be a pass. An advisory check informs the reviewer and blocks
 *   nothing: a failing duplicate signal is recorded, not a bar to acceptance.
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

  const failed = candidate.verdicts
    .filter((verdict) => verdict.outcome === 'fail' && precheckSeverity(verdict.check) === 'blocking')
    .map((verdict) => verdict.check);
  if (failed.length > 0) {
    return err(
      preconditionFailedError(
        'CANDIDATE_PRECHECK_FAILED',
        `a candidate that failed blocking pre-checks cannot be accepted: ${failed.join(', ')}`,
        'verdicts',
      ),
    );
  }

  const recorded = new Set<string>(candidate.verdicts.map((verdict) => verdict.check));
  const missing = BLOCKING_PRECHECKS.filter((check) => !recorded.has(check));
  if (missing.length > 0) {
    return err(
      preconditionFailedError(
        'CANDIDATE_NOT_PRECHECKED',
        `a candidate without a verdict for every blocking pre-check cannot be accepted: ${missing.join(', ')}`,
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
