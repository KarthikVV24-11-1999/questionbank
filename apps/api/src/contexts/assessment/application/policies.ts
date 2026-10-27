import { ROLES } from '../../../platform/auth/roles.js';
import { policy, type AuthorizationPolicy } from './authorization.js';

/**
 * Who may do what in the assessment context.
 *
 *   - **`content_ops`** is the human who builds, publishes and schedules forms.
 *   - **`system`** is the machine. It may *assemble a draft* and read a form, and
 *     it may run the sweep that applies the clock to stored state — and it may do
 *     **nothing that changes what students are offered**: publication and
 *     scheduling are a person's. Its reach into content is the one Track C gave
 *     it (the published catalogue and the duplicate candidates), and assembly
 *     adds nothing to it: assembling reads through exactly those two handlers.
 *
 * Publication needs step-up. It is the act that freezes a form and counts its
 * exposure, and content's own publish is held to the same standard.
 */
export const ASSEMBLE_DRAFT_FORM_POLICY: AuthorizationPolicy = policy('AssembleDraftForm', [ROLES.contentOps, ROLES.system]);

export const PUBLISH_FORM_POLICY: AuthorizationPolicy = policy('PublishForm', [ROLES.contentOps], true);

export const SCHEDULE_FORM_POLICY: AuthorizationPolicy = policy('ScheduleForm', [ROLES.contentOps]);

export const GET_FORM_POLICY: AuthorizationPolicy = policy('GetForm', [ROLES.contentOps, ROLES.system]);

/** The scheduler's: applying the clock to stored state is a machine's act (D36), and has no route. */
/** Submitting an attempt whose deadline passed with no one to submit it: the scheduler's, a machine's act, with no route (D36). */
export const SUBMIT_EXPIRED_ATTEMPTS_POLICY: AuthorizationPolicy = policy('SubmitExpiredAttempts', [ROLES.system]);

export const SWEEP_WINDOWS_POLICY: AuthorizationPolicy = policy('SweepWindows', [ROLES.system]);

/**
 * The package is the one thing here a student fetches, so it is the one policy
 * that names `learner`. It is key-free by construction and by scan (M6-25); the
 * policy says who may ask, and the form's state and window say when.
 */
export const GET_FORM_PACKAGE_POLICY: AuthorizationPolicy = policy('GetFormPackage', [ROLES.learner, ROLES.contentOps, ROLES.system]);

/** The public half of the package signing key. Public by nature; the policy only keeps it behind sign-in like every other route. */
export const GET_PACKAGE_SIGNING_KEY_POLICY: AuthorizationPolicy = policy('GetPackageSigningKey', [ROLES.learner, ROLES.contentOps, ROLES.system]);

/**
 * A student's own attempt: creating it, starting it, reading it, sending events to it and submitting it. Each names
 * `learner` and no one else — an operator does not sit a student's attempt and the system has nothing to do to one
 * here — and each handler then checks the attempt is **the caller's own**, answering NotFound for anyone else's so
 * its existence is not disclosed.
 */
export const CREATE_ATTEMPT_POLICY: AuthorizationPolicy = policy('CreateAttempt', [ROLES.learner]);
export const START_ATTEMPT_POLICY: AuthorizationPolicy = policy('StartAttempt', [ROLES.learner]);
export const GET_ATTEMPT_POLICY: AuthorizationPolicy = policy('GetAttempt', [ROLES.learner]);
export const INGEST_RESPONSE_EVENTS_POLICY: AuthorizationPolicy = policy('IngestResponseEvents', [ROLES.learner]);
export const GET_ATTEMPT_RESULT_POLICY: AuthorizationPolicy = policy('GetAttemptResult', [ROLES.learner]);
export const SUBMIT_ATTEMPT_POLICY: AuthorizationPolicy = policy('SubmitAttempt', [ROLES.learner]);

/** A learner's own practice: starting a run and growing it. Each names `learner` alone, and growing checks the run is the caller's own. */
export const CREATE_PRACTICE_ATTEMPT_POLICY: AuthorizationPolicy = policy('CreatePracticeAttempt', [ROLES.learner]);
export const GROW_PRACTICE_ATTEMPT_POLICY: AuthorizationPolicy = policy('GrowPracticeAttempt', [ROLES.learner]);
export const GET_PRACTICE_FEEDBACK_POLICY: AuthorizationPolicy = policy('GetPracticeFeedback', [ROLES.learner]);
