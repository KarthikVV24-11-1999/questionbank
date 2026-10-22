/**
 * The assessment context's failure surface (ENGINEERING-HANDBOOK §8): the
 * platform's fixed taxonomy of ten, of which this domain produces five. A kind
 * joins the list the day something constructs it, never earlier.
 */
export const ERROR_KINDS = [
  'Validation',
  'Authentication',
  'Authorization',
  'Entitlement',
  'NotFound',
  'Conflict',
  'PreconditionFailed',
  'RuleViolation',
  'RateLimited',
  'Unavailable',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export const ASSESSMENT_ERROR_KINDS = [
  /** Input that is malformed or self-contradictory — a blank shift, a non-uuid, a missing answer. */
  'Validation',
  /** The aggregate asked for does not exist — a repository's finding. */
  'NotFound',
  /** A second claim on something that takes only one — a second active mock, a replayed id with other content. */
  'Conflict',
  /** A state the aggregate is not in yet — starting a form that is not published. */
  'PreconditionFailed',
  /** The lifecycle itself forbids it — a transition the table does not allow, editing a published form. */
  'RuleViolation',
  /** The store could not be reached. Retryable, and never the caller's fault — a device holds its events and tries again. */
  'Unavailable',
] as const satisfies readonly ErrorKind[];

export type AssessmentErrorKind = (typeof ASSESSMENT_ERROR_KINDS)[number];

/**
 * `code` is what a caller branches on; `message` is for a person. `location`
 * names the field or place inside the aggregate. Neither ever carries a stack
 * trace, SQL or an internal identifier (§8).
 */
export interface AssessmentError<Code extends string = string> {
  readonly kind: AssessmentErrorKind;
  readonly code: Code;
  readonly message: string;
  readonly location?: string;
}

function assessmentError<Code extends string>(
  kind: AssessmentErrorKind,
  code: Code,
  message: string,
  location?: string,
): AssessmentError<Code> {
  return Object.freeze(location === undefined ? { kind, code, message } : { kind, code, message, location });
}

export const validationError = <Code extends string>(code: Code, message: string, location?: string) =>
  assessmentError('Validation', code, message, location);
export const notFoundError = <Code extends string>(code: Code, message: string, location?: string) =>
  assessmentError('NotFound', code, message, location);
export const conflictError = <Code extends string>(code: Code, message: string, location?: string) =>
  assessmentError('Conflict', code, message, location);
export const preconditionFailedError = <Code extends string>(code: Code, message: string, location?: string) =>
  assessmentError('PreconditionFailed', code, message, location);
export const ruleViolationError = <Code extends string>(code: Code, message: string, location?: string) =>
  assessmentError('RuleViolation', code, message, location);
export const unavailableError = <Code extends string>(code: Code, message: string, location?: string) =>
  assessmentError('Unavailable', code, message, location);
