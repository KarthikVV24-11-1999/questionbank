import { err, ok, type Result } from './result.js';
import { ruleViolationError, validationError, type ContentError } from './content-error.js';

/**
 * The content lifecycle state machine (FR-QM-01).
 *
 * **Why this lives in M3 and not M4** — see
 * [ADR-0010](../../../../../docs/adr/ADR-0010-content-owns-the-lifecycle-state-machine.md).
 * The short form: M3's own acceptance is "publication blocked without tags,
 * provenance, resolved licensing, or a solution", and you cannot block a
 * transition you do not own. M4 owns the *workspace* that drives these
 * transitions — assignment, queueing, ageing, the reviewer's screen.
 *
 * **Every transition the table does not name is refused.** Not "unknown
 * transitions are ignored" and not "the caller checks first": an unnamed
 * transition returns `RuleViolation` naming what was attempted, so a caller
 * that gets the machine wrong finds out immediately rather than leaving an
 * item in a state nothing can move it out of.
 *
 * **Nothing is hard-deleted after `draft`** (FR-QM-01 rule 5). A draft may be
 * discarded because nobody has reviewed it and no attempt can reference it;
 * everything past that is withdrawn, suspended or retired, all of which keep
 * the history an attempt or a statistic may still point at.
 */

export const LIFECYCLE_STATES = [
  'draft',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
  'published',
  'suspended',
  'retired',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_TRANSITIONS = [
  'submit_for_review',
  'withdraw',
  'request_changes',
  'approve',
  'reject',
  'publish',
  'suspend',
  'reinstate',
  'retire',
] as const;
export type LifecycleTransition = (typeof LIFECYCLE_TRANSITIONS)[number];

/**
 * The whole machine, as data.
 *
 * Written as one table rather than a switch so that "every transition the
 * machine does not name is refused" is a property of the table, and the
 * exhaustive 8 × 9 test in the spec reads against the same structure a
 * reviewer reads.
 */
const TRANSITIONS: Readonly<Record<LifecycleState, Partial<Record<LifecycleTransition, LifecycleState>>>> =
  Object.freeze({
    draft: { submit_for_review: 'in_review' },

    // FR-TCH-08 rule 2: withdrawal is permitted before review begins and
    // refused after. "Begins" is the reviewer picking it up, which M4 models;
    // at this layer the state is still `in_review`, so the handler supplies
    // whether review has started (M3-28).
    in_review: {
      withdraw: 'draft',
      request_changes: 'changes_requested',
      approve: 'approved',
      reject: 'rejected',
    },

    changes_requested: { submit_for_review: 'in_review' },

    approved: { publish: 'published', request_changes: 'changes_requested' },

    // A rejected item is not dead — the author may rework it. What it may not
    // do is reach `published` without going back through review.
    rejected: { submit_for_review: 'in_review' },

    published: { suspend: 'suspended', retire: 'retired' },

    // FR-QM-01 rule 4: suspension removes student visibility while preserving
    // history, and it is reversible — a defect report that turns out to be
    // wrong must not cost the item permanently.
    suspended: { reinstate: 'published', retire: 'retired' },

    // Terminal. FR-QM-07 rule 2 keeps history, statistics and bookmarks
    // pointing at it, so there is nothing to gain by allowing a way back and a
    // great deal to lose.
    retired: {},
  });

export type LifecycleErrorCode = 'TRANSITION_UNKNOWN' | 'TRANSITION_ILLEGAL' | 'STATE_UNKNOWN';

export type LifecycleError = ContentError<LifecycleErrorCode>;

export function isLifecycleState(state: string): state is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(state);
}

export function isLifecycleTransition(transition: string): transition is LifecycleTransition {
  return (LIFECYCLE_TRANSITIONS as readonly string[]).includes(transition);
}

/** The state a transition leads to, or a `RuleViolation` naming what was refused. */
export function applyTransition(
  from: LifecycleState,
  transition: LifecycleTransition,
  location = 'lifecycleState',
): Result<LifecycleState, LifecycleError> {
  if (!isLifecycleState(from)) {
    return err(validationError('STATE_UNKNOWN', `unknown lifecycle state "${from}"`, location));
  }
  if (!isLifecycleTransition(transition)) {
    return err(validationError('TRANSITION_UNKNOWN', `unknown transition "${transition}"`, location));
  }

  const next = TRANSITIONS[from][transition];
  if (next === undefined) {
    return err(
      ruleViolationError(
        'TRANSITION_ILLEGAL',
        `cannot ${transition} an item that is ${from}`,
        location,
      ),
    );
  }

  return ok(next);
}

/** Every transition legal from a state — what the Studio surface offers. */
export function transitionsFrom(state: LifecycleState): readonly LifecycleTransition[] {
  return Object.keys(TRANSITIONS[state]) as LifecycleTransition[];
}

/** Only `published` content is student-visible (FR-QM-01 rule 3). */
export function isStudentVisible(state: LifecycleState): boolean {
  return state === 'published';
}

/**
 * Whether the record may be discarded outright.
 *
 * Only a draft. Nothing has reviewed it and no attempt can reference it, so
 * there is no history to destroy; past that, deleting would destroy exactly
 * the history FR-QM-01 rule 5 and FR-QM-07 rule 2 exist to keep.
 */
export function isDeletable(state: LifecycleState): boolean {
  return state === 'draft';
}

/** A state from which nothing further is possible. */
export function isTerminal(state: LifecycleState): boolean {
  return transitionsFrom(state).length === 0;
}

/** The transition that publishes, isolated so M3-11's preconditions attach to one place. */
export const PUBLISHING_TRANSITION: LifecycleTransition = 'publish';
