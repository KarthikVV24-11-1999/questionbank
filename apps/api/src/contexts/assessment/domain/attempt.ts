import {
  ATTEMPT_STATES as ATTEMPT_STATE_LIST,
  isActiveState,
  transition,
  type AttemptState,
  type AttemptTrigger,
} from './attempt-state.js';
import {
  conflictError,
  ruleViolationError,
  validationError,
  type AssessmentError,
} from './assessment-error.js';
import { freezeJson, isJsonObject } from './json-document.js';
import { err, ok, type Result } from './result.js';
import {
  addMilliseconds,
  isNonBlank,
  isPositiveInteger,
  isSessionRef,
  isSha256Hex,
  isUtcTimestamp,
  isUuid,
} from './uuid.js';

/**
 * `Attempt` — the record of one learner sitting one form.
 *
 * **It reads no clock.** Every moment arrives as a parameter, and the deadline
 * is *server-anchored*: it is fixed when the attempt starts, from the server's
 * `now` and the form's duration, and nothing the device reports can move it
 * (REL-09).
 *
 * **It pins everything needed to reproduce and score it** (INV-04): the exam
 * profile version, the marking rule set's hash, the taxonomy version and — per
 * slot — the exact item version, copied from the form when the attempt is
 * created so a later change to anything cannot reach back.
 *
 * ASSESSMENT-ENGINE §12 puts two things at the attempt level that cannot be
 * reconstructed later: the **session** it was sat in and the **shift** it
 * belongs to, for multi-shift normalization. Both are required here and
 * neither can be blank.
 *
 * **One aggregate, three modes** (DOMAIN-MODEL D2). A mock or diagnostic attempt is sat on a form and carries the form's session, shift and
 * window; a practice attempt has no form, so it carries none of the four, and the rule is stated once as a total one — a form is present
 * exactly when the mode is not practice, and the form's four columns are all present or all absent (M7-25). Nothing is "enforced when mode
 * = mock": a form-bearing attempt is checked by every rule it always was.
 *
 * **A practice attempt's slot list grows** (`appendSlot`), and INV-04 holds unchanged because the pin was always per slot: each slot row
 * records the one item version it was given, a response is tied to that slot by a composite key, and growing the list *adds* a pin and never
 * changes one. The attempt-level list of item versions is a projection of the slot rows, not a second fact.
 */
export const ATTEMPT_MODES = ['mock', 'practice', 'diagnostic'] as const;
export type AttemptMode = (typeof ATTEMPT_MODES)[number];

export const SUBMISSION_REASONS = ['manual', 'expiry', 'recovered'] as const;
export type SubmissionReason = (typeof SUBMISSION_REASONS)[number];

export interface AttemptSlot {
  readonly slotId: string;
  readonly ordinal: number;
  readonly itemId: string;
  /** The version, not the item: INV-04 and §12 — statistics silently mix versions otherwise. */
  readonly itemVersionId: string;
  readonly stimulusVersionId: string | null;
}

export interface Submission {
  readonly reason: SubmissionReason;
  readonly idempotencyKey: string;
  readonly submittedAt: string;
}

export interface Attempt {
  readonly attemptId: string;
  readonly studentId: string;
  readonly mode: AttemptMode;
  /** The form it is sat on. Null exactly when the mode is practice. */
  readonly formId: string | null;
  readonly examProfileVersionId: string;
  readonly markingRuleSetHash: string;
  readonly taxonomyVersionId: string;
  readonly deliveryPolicy: Readonly<Record<string, unknown>>;
  /**
   * §12: the session the attempt was sat in (ADR-0032) — the canonical key of one of the sittings its form
   * was published for, tied to it by a foreign key. Present with the form and absent without it, and not the
   * authentication session, which never ended an attempt.
   */
  readonly sessionRef: string | null;
  /** §12: the shift the attempt belongs to, for multi-shift normalization. Present with the form, never blank. */
  readonly shiftId: string | null;
  readonly slots: readonly AttemptSlot[];
  /** Null for an untimed attempt. `isTimed` is this fact said once more, so a reader never has to infer it. */
  readonly durationMs: number | null;
  readonly isTimed: boolean;
  /**
   * The cap on one visit → leave interval towards time on item (§4), pinned when the attempt is created from the one
   * configured value and told to the device. Fixed for the attempt's life, so the device and the server project one
   * log with one cap whatever is configured later (M6-37).
   */
  readonly intervalCapMs: number;
  /** After this the attempt can no longer be started, and — with no responses — can be abandoned. Null with no form: a practice run has no window. */
  readonly windowClosesAt: string | null;
  readonly createdAt: string;
  readonly state: AttemptState;
  readonly startedAt: string | null;
  /** Server-anchored, fixed at start. */
  readonly deadline: string | null;
  readonly submission: Submission | null;
  readonly abandonedAt: string | null;
}

export type AttemptErrorCode =
  | 'ATTEMPT_ID_INVALID'
  | 'ATTEMPT_STUDENT_INVALID'
  | 'ATTEMPT_MODE_INVALID'
  | 'ATTEMPT_FORM_INVALID'
  | 'ATTEMPT_FORM_MODE_MISMATCH'
  | 'ATTEMPT_FORM_COLUMNS_MISMATCH'
  | 'ATTEMPT_PROFILE_INVALID'
  | 'ATTEMPT_MARKING_HASH_INVALID'
  | 'ATTEMPT_TAXONOMY_INVALID'
  | 'ATTEMPT_DELIVERY_POLICY_INVALID'
  | 'ATTEMPT_SESSION_INVALID'
  | 'ATTEMPT_SHIFT_INVALID'
  | 'ATTEMPT_SLOTS_INVALID'
  | 'ATTEMPT_DURATION_INVALID'
  | 'ATTEMPT_INTERVAL_CAP_INVALID'
  | 'ATTEMPT_WINDOW_INVALID'
  | 'ATTEMPT_CREATED_AT_INVALID'
  | 'ATTEMPT_NOW_INVALID'
  | 'ATTEMPT_SUBMISSION_INVALID'
  | 'ATTEMPT_WINDOW_CLOSED'
  | 'ATTEMPT_WINDOW_STILL_OPEN'
  | 'ATTEMPT_HAS_NO_WINDOW'
  | 'ATTEMPT_NOT_PRACTICE'
  | 'ATTEMPT_NOT_GROWABLE'
  | 'ATTEMPT_SLOT_INVALID'
  | 'ATTEMPT_SLOT_ORDINAL_NOT_NEXT'
  | 'ATTEMPT_SLOT_ITEM_REPEATED'
  | 'ATTEMPT_HAS_RESPONSES'
  | 'ATTEMPT_TRANSITION_PROHIBITED'
  | 'ATTEMPT_SUBMITTED_UNDER_ANOTHER_KEY'
  | 'ACTIVE_MOCK_ATTEMPT_EXISTS'
  | 'ATTEMPT_STORED_STATE_INVALID';

export type AttemptError = AssessmentError<AttemptErrorCode>;

export interface CreateAttemptProps {
  readonly attemptId: string;
  readonly studentId: string;
  readonly mode: AttemptMode;
  readonly formId: string | null;
  readonly examProfileVersionId: string;
  readonly markingRuleSetHash: string;
  readonly taxonomyVersionId: string;
  readonly deliveryPolicy: Readonly<Record<string, unknown>>;
  readonly sessionRef: string | null;
  readonly shiftId: string | null;
  readonly slots: readonly AttemptSlot[];
  /** Null for an untimed attempt; `isTimed` follows from it and is not a second input. */
  readonly durationMs: number | null;
  readonly intervalCapMs: number;
  readonly windowClosesAt: string | null;
  readonly createdAt: string;
}

function invalid(code: AttemptErrorCode, message: string, location: string): AttemptError {
  return validationError(code, message, location);
}

function slotsError(slots: readonly AttemptSlot[]): string | null {
  if (!Array.isArray(slots) || slots.length === 0) return 'an attempt pins at least one slot';
  const slotIds = new Set<string>();
  const ordinals = new Set<number>();
  for (const slot of slots) {
    const ok =
      isUuid(slot.slotId) &&
      isUuid(slot.itemId) &&
      isUuid(slot.itemVersionId) &&
      (slot.stimulusVersionId === null || isUuid(slot.stimulusVersionId)) &&
      Number.isSafeInteger(slot.ordinal) &&
      slot.ordinal >= 0;
    if (!ok) return 'every slot needs uuid ids, an item version and a whole-number ordinal';
    slotIds.add(slot.slotId);
    ordinals.add(slot.ordinal);
  }
  if (slotIds.size !== slots.length) return 'slot ids must be distinct';
  if (ordinals.size !== slots.length) return 'slot ordinals must be distinct';
  return null;
}

export function createAttempt(props: CreateAttemptProps): Result<Attempt, AttemptError> {
  const fault = firstFault(props);
  if (fault !== null) return err(fault);
  return ok(
    Object.freeze({
      attemptId: props.attemptId,
      studentId: props.studentId,
      mode: props.mode,
      formId: props.formId,
      examProfileVersionId: props.examProfileVersionId,
      markingRuleSetHash: props.markingRuleSetHash,
      taxonomyVersionId: props.taxonomyVersionId,
      deliveryPolicy: freezeJson({ ...props.deliveryPolicy }),
      sessionRef: props.sessionRef,
      shiftId: props.shiftId,
      slots: Object.freeze(
        [...props.slots]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((slot) => Object.freeze({ ...slot })),
      ),
      durationMs: props.durationMs,
      isTimed: props.durationMs !== null,
      intervalCapMs: props.intervalCapMs,
      windowClosesAt: props.windowClosesAt,
      createdAt: props.createdAt,
      state: 'created' as const,
      startedAt: null,
      deadline: null,
      submission: null,
      abandonedAt: null,
    }),
  );
}

function firstFault(props: CreateAttemptProps): AttemptError | null {
  const hasForm = props.formId !== null;
  // The form's columns travel with it: valid when there is a form, null when there is not. Each says its own code when it is wrong.
  const noFormColumns = hasForm || (props.sessionRef === null && props.shiftId === null && props.windowClosesAt === null);
  const checks: readonly (readonly [boolean, AttemptErrorCode, string, string])[] = [
    [isUuid(props.attemptId), 'ATTEMPT_ID_INVALID', 'attemptId must be a uuid', 'attemptId'],
    [isUuid(props.studentId), 'ATTEMPT_STUDENT_INVALID', 'studentId must be a uuid', 'studentId'],
    [(ATTEMPT_MODES as readonly string[]).includes(props.mode), 'ATTEMPT_MODE_INVALID', 'mode is mock, practice or diagnostic', 'mode'],
    [props.formId === null || isUuid(props.formId), 'ATTEMPT_FORM_INVALID', 'formId must be a uuid, or absent for practice', 'formId'],
    [hasForm === (props.mode !== 'practice'), 'ATTEMPT_FORM_MODE_MISMATCH', 'a form is carried exactly when the attempt is not practice', 'formId'],
    [noFormColumns, 'ATTEMPT_FORM_COLUMNS_MISMATCH', 'a practice attempt has no form, so it has no session, shift or window', 'sessionRef'],
    [isUuid(props.examProfileVersionId), 'ATTEMPT_PROFILE_INVALID', 'examProfileVersionId must be a uuid', 'examProfileVersionId'],
    [isSha256Hex(props.markingRuleSetHash), 'ATTEMPT_MARKING_HASH_INVALID', 'markingRuleSetHash must be a SHA-256 hex digest', 'markingRuleSetHash'],
    [isUuid(props.taxonomyVersionId), 'ATTEMPT_TAXONOMY_INVALID', 'taxonomyVersionId must be a uuid', 'taxonomyVersionId'],
    [isJsonObject(props.deliveryPolicy), 'ATTEMPT_DELIVERY_POLICY_INVALID', 'deliveryPolicy must be a JSON object', 'deliveryPolicy'],
    [!hasForm || isSessionRef(props.sessionRef), 'ATTEMPT_SESSION_INVALID', 'an attempt records the session it was sat in, as a canonical key', 'sessionRef'],
    [!hasForm || isNonBlank(props.shiftId), 'ATTEMPT_SHIFT_INVALID', 'an attempt records the shift it belongs to', 'shiftId'],
    [props.durationMs === null || isPositiveInteger(props.durationMs), 'ATTEMPT_DURATION_INVALID', 'durationMs must be a positive whole number, or absent for an untimed attempt', 'durationMs'],
    [isPositiveInteger(props.intervalCapMs), 'ATTEMPT_INTERVAL_CAP_INVALID', 'intervalCapMs must be a positive whole number', 'intervalCapMs'],
    [!hasForm || isUtcTimestamp(props.windowClosesAt), 'ATTEMPT_WINDOW_INVALID', 'windowClosesAt must be a UTC timestamp with milliseconds', 'windowClosesAt'],
    [isUtcTimestamp(props.createdAt), 'ATTEMPT_CREATED_AT_INVALID', 'createdAt must be a UTC timestamp with milliseconds', 'createdAt'],
  ];
  const failed = checks.find(([passes]) => !passes);
  if (failed !== undefined) return invalid(failed[1], failed[2], failed[3]);
  const slotFault = slotsError(props.slots);
  return slotFault === null ? null : invalid('ATTEMPT_SLOTS_INVALID', slotFault, 'slots');
}

function prohibited(attempt: Attempt, trigger: AttemptTrigger): AttemptError {
  return ruleViolationError(
    'ATTEMPT_TRANSITION_PROHIBITED',
    `a ${attempt.state} attempt cannot ${trigger}`,
    'state',
  );
}

function badNow(now: unknown): AttemptError | null {
  return isUtcTimestamp(now) ? null : invalid('ATTEMPT_NOW_INVALID', 'now must be a UTC timestamp with milliseconds', 'now');
}

/**
 * Starts the attempt and anchors its deadline: `now` plus the form's duration,
 * fixed here and never recomputed. A window that has closed cannot be started.
 */
export function startAttempt(attempt: Attempt, now: string): Result<Attempt, AttemptError> {
  const bad = badNow(now);
  if (bad !== null) return err(bad);
  if (transition(attempt.state, 'start') === null) return err(prohibited(attempt, 'start'));
  if (attempt.windowClosesAt !== null && now >= attempt.windowClosesAt) {
    return err(ruleViolationError('ATTEMPT_WINDOW_CLOSED', 'the window has closed; the attempt can no longer be started', 'windowClosesAt'));
  }
  return ok(
    Object.freeze({
      ...attempt,
      state: 'in_progress' as const,
      startedAt: now,
      // An untimed attempt has no deadline to anchor: pausing it, and coming back a week later, is what it is for.
      deadline: attempt.durationMs === null ? null : addMilliseconds(now, attempt.durationMs),
    }),
  );
}

/** Whether the server-anchored deadline has passed at `now`. An attempt with no deadline cannot be expired. */
export function isExpired(attempt: Attempt, now: string): boolean {
  return attempt.deadline !== null && now >= attempt.deadline;
}

const SUBMIT_TRIGGER: Readonly<Record<SubmissionReason, AttemptTrigger>> = {
  manual: 'submit_manual',
  expiry: 'submit_expiry',
  recovered: 'submit_recovered',
};

/**
 * Submits the attempt, idempotently on its key: the same key again returns the
 * attempt as it is, a different key on a submitted attempt is a conflict. A
 * retry therefore cannot create a second submission (REL-02).
 */
export function submitAttempt(
  attempt: Attempt,
  request: { readonly reason: SubmissionReason; readonly idempotencyKey: string },
  now: string,
): Result<Attempt, AttemptError> {
  const bad = badNow(now);
  if (bad !== null) return err(bad);
  if (!isNonBlank(request.idempotencyKey) || !(SUBMISSION_REASONS as readonly string[]).includes(request.reason)) {
    return err(invalid('ATTEMPT_SUBMISSION_INVALID', 'a submission needs a reason and a non-blank idempotency key', 'submission'));
  }
  if (attempt.submission !== null) {
    return attempt.submission.idempotencyKey === request.idempotencyKey
      ? ok(attempt)
      : err(conflictError('ATTEMPT_SUBMITTED_UNDER_ANOTHER_KEY', 'the attempt was already submitted under a different key', 'idempotencyKey'));
  }
  const trigger = SUBMIT_TRIGGER[request.reason];
  if (transition(attempt.state, trigger) === null) return err(prohibited(attempt, trigger));
  return ok(
    Object.freeze({
      ...attempt,
      state: 'submitted' as const,
      submission: Object.freeze({ reason: request.reason, idempotencyKey: request.idempotencyKey, submittedAt: now }),
    }),
  );
}

/**
 * Abandons an attempt whose window has closed and which holds no response. A
 * `created` attempt qualifies by construction (D53, ADR-0030); an in-progress
 * one must be told how many slots were answered, since the responses live in
 * the log and not on the attempt.
 *
 * The window now exists on the form (M6-20) and the repository can find the attempts
 * it has left behind (`findAbandonable`); the scheduler calls this (M6-42, D36). D54 is closed.
 */
export function abandonAttempt(attempt: Attempt, now: string, answeredSlots: number): Result<Attempt, AttemptError> {
  const bad = badNow(now);
  if (bad !== null) return err(bad);
  if (transition(attempt.state, 'abandon') === null) return err(prohibited(attempt, 'abandon'));
  if (attempt.windowClosesAt === null) {
    return err(ruleViolationError('ATTEMPT_HAS_NO_WINDOW', 'an attempt with no window is never abandoned by the clock; its learner finishes it or leaves it', 'windowClosesAt'));
  }
  if (now < attempt.windowClosesAt) {
    return err(ruleViolationError('ATTEMPT_WINDOW_STILL_OPEN', 'an attempt is abandoned only once its window has closed', 'windowClosesAt'));
  }
  if (answeredSlots > 0) {
    return err(ruleViolationError('ATTEMPT_HAS_RESPONSES', 'an attempt with responses is submitted, never abandoned', 'responses'));
  }
  return ok(Object.freeze({ ...attempt, state: 'abandoned' as const, abandonedAt: now }));
}

/**
 * Appends one slot to a practice attempt that is still being sat (M7-27): the next ordinal, its own item version, immutable once written.
 *
 * **How a growing attempt is pinned.** INV-04 asks that an attempt be reproducible, and the pin is per slot: `attempt_slot` records the one
 * item version each slot was given, and a response is tied to that slot and version by a composite key. Growing the list adds a pin and never
 * changes one — every existing slot, and every response already recorded against it, is exactly what it was. This function returns the same
 * slots, in the same order, with one more; it has no way to express "replace" or "re-pin".
 *
 * A mock cannot grow: its list is the form's, fixed when the attempt was created, and the database refuses it as well. (DEC-M7-12)
 */
export function appendSlot(attempt: Attempt, slot: AttemptSlot): Result<Attempt, AttemptError> {
  if (attempt.mode !== 'practice') {
    return err(ruleViolationError('ATTEMPT_NOT_PRACTICE', 'only a practice attempt grows; a mock or diagnostic attempt has the form\'s slots and no others', 'mode'));
  }
  if (attempt.state !== 'created' && attempt.state !== 'in_progress') {
    return err(ruleViolationError('ATTEMPT_NOT_GROWABLE', `a ${attempt.state} attempt takes no further slots`, 'state'));
  }
  const fault = slotsError([slot]);
  if (fault !== null) return err(invalid('ATTEMPT_SLOT_INVALID', fault, 'slot'));
  // An attempt always holds at least one slot (creation refuses none), and slots are kept in ordinal order.
  const next = attempt.slots[attempt.slots.length - 1]!.ordinal + 1;
  if (slot.ordinal !== next) {
    return err(ruleViolationError('ATTEMPT_SLOT_ORDINAL_NOT_NEXT', `the next slot is ordinal ${next}`, 'slot.ordinal'));
  }
  if (attempt.slots.some((held) => held.slotId === slot.slotId)) {
    return err(invalid('ATTEMPT_SLOT_INVALID', 'that slot id is already in the attempt', 'slot.slotId'));
  }
  if (attempt.slots.some((held) => held.itemId === slot.itemId)) {
    return err(ruleViolationError('ATTEMPT_SLOT_ITEM_REPEATED', 'a practice run does not give the same item twice', 'slot.itemId'));
  }
  return ok(Object.freeze({ ...attempt, slots: Object.freeze([...attempt.slots, Object.freeze({ ...slot })]) }));
}

/** Whether an attempt counts against "one active mock per student". A function of the attempt's state alone. */
export function isActive(attempt: Pick<Attempt, 'state'>): boolean {
  return isActiveState(attempt.state);
}

/**
 * ASSESSMENT-ENGINE §5: one active mock attempt per student. Given the
 * student's existing attempts, may they begin another mock?
 *
 * Diagnostic attempts are not mocks and never count. This is the domain's
 * statement of the rule; the database holds the same rule as a partial unique
 * index so that two attempts created at once cannot both pass it.
 */
export function admitNewAttempt(
  mode: AttemptMode,
  existing: readonly Pick<Attempt, 'attemptId' | 'mode' | 'state'>[],
): Result<null, AttemptError> {
  if (mode !== 'mock') return ok(null);
  const blocking = existing.find((attempt) => attempt.mode === 'mock' && isActive(attempt));
  return blocking === undefined
    ? ok(null)
    : err(conflictError('ACTIVE_MOCK_ATTEMPT_EXISTS', `mock attempt ${blocking.attemptId} is still active`, 'attemptId'));
}

/** Everything an attempt holds, as storage returns it: the creation props plus the lifecycle columns. */
export interface AttemptSnapshot extends CreateAttemptProps {
  readonly state: AttemptState;
  readonly startedAt: string | null;
  readonly deadline: string | null;
  readonly submission: Submission | null;
  readonly abandonedAt: string | null;
}

/** What each state must and must not carry, as the database's state-shape check says. Held to the same answer by a spec. */
const SHAPE: Readonly<Record<AttemptState, { readonly started: boolean | 'either'; readonly submitted: boolean; readonly abandoned: boolean }>> = {
  created: { started: false, submitted: false, abandoned: false },
  in_progress: { started: true, submitted: false, abandoned: false },
  submitted: { started: true, submitted: true, abandoned: false },
  // Abandoned from created never started; abandoned from in_progress did.
  abandoned: { started: 'either', submitted: false, abandoned: true },
};

/**
 * Rebuilds an attempt from storage. It runs the same validation creation does
 * and then checks that the lifecycle columns are the ones its state allows —
 * a stored row that no longer satisfies the domain is reported, never loaded.
 * It does not re-run the transition rules: those governed how the row got
 * here, and a row from an earlier rule is still history.
 */
export function restoreAttempt(snapshot: AttemptSnapshot): Result<Attempt, AttemptError> {
  const created = createAttempt(snapshot);
  if (!created.ok) return created;
  const shape = (ATTEMPT_STATE_LIST as readonly string[]).includes(snapshot.state) ? SHAPE[snapshot.state] : undefined;
  const timestamps = [snapshot.startedAt, snapshot.deadline, snapshot.abandonedAt, snapshot.submission?.submittedAt ?? null];
  const lifecycleOk =
    shape !== undefined &&
    timestamps.every((value) => value === null || isUtcTimestamp(value)) &&
    (snapshot.deadline !== null) === (created.value.isTimed && snapshot.startedAt !== null) &&
    (shape.started === 'either' || (snapshot.startedAt !== null) === shape.started) &&
    (snapshot.submission !== null) === shape.submitted &&
    (snapshot.abandonedAt !== null) === shape.abandoned &&
    (snapshot.submission === null ||
      ((SUBMISSION_REASONS as readonly string[]).includes(snapshot.submission.reason) && isNonBlank(snapshot.submission.idempotencyKey)));
  if (!lifecycleOk) {
    return err(invalid('ATTEMPT_STORED_STATE_INVALID', `the stored lifecycle columns do not fit a ${String(snapshot.state)} attempt`, 'state'));
  }
  return ok(
    Object.freeze({
      ...created.value,
      state: snapshot.state,
      startedAt: snapshot.startedAt,
      deadline: snapshot.deadline,
      submission: snapshot.submission === null ? null : Object.freeze({ ...snapshot.submission }),
      abandonedAt: snapshot.abandonedAt,
    }),
  );
}
