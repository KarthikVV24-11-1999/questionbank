/**
 * The queue, driven (M4-27). One command per act, matching the discipline
 * `application/commands/lifecycle-commands.ts` already establishes: no
 * generic "update the assignment" command, so a permission gate exists per
 * act and a reviewer cannot, say, reassign by writing a state name.
 */

/** DEC-M4-9's pull path. `subject` is declared, never inferred — `authorizeSubjectScope` checks it against the reviewer's own scope. */
export interface ClaimNextForReview {
  readonly subject: string;
}

/** A reviewer releasing their own claim, before or after starting it — ownership is checked at the handler. */
export interface ReleaseAssignment {
  readonly assignmentId: string;
}

/**
 * Content Ops' push path (DEC-M4-9) — used when handling an escalation.
 * Names the reviewer directly; there is no candidate selection to authorize
 * against, only the target version and who it is being handed to.
 */
export interface ReassignReview {
  readonly itemVersionId: string;
  readonly subject: string;
  readonly reviewerId: string;
}

/** A reviewer pushing their own lease forward before it expires — ownership is checked at the handler. */
export interface ExtendLease {
  readonly assignmentId: string;
}
