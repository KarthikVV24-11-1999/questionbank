import type { PrincipalRef } from '@questionbank/domain-types';
import type { CreateItemDraft, SubmitItemForReview } from '../../content/public/index.js';
import type { Result } from '../domain/result.js';
import type { ApplicationError, AuthorizationContext } from './authorization.js';

export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/**
 * One row per consequential command (DATA-ARCHITECTURE P3). It names the
 * principal, the action and the target, and never the proposal itself (§7).
 */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'generation';
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

/** The clock lives here, not in the domain: every instant the domain reasons about is supplied. */
export interface Clock {
  now(): Date;
}

export interface IdentifierFactory {
  next(): string;
}

/**
 * What generation needs from content, and nothing more: put a draft in, put it
 * in front of reviewers. Content's barrel exposes these as commands and not as
 * callable handlers, so the composition root supplies the implementation that
 * runs content's own handlers — generation holds no capability to write a
 * content aggregate itself (SEC-20, F27).
 *
 * Both calls run under the caller's own context. The draft's author is the
 * human who accepted the candidate, and content authorizes that human exactly
 * as it would for any draft.
 */
export interface ContentAuthoring {
  createDraft(
    command: CreateItemDraft,
    context: ApplicationContext,
  ): Promise<Result<{ readonly itemId: string }, ApplicationError>>;
  submitForReview(command: SubmitItemForReview, context: ApplicationContext): Promise<Result<true, ApplicationError>>;
}
