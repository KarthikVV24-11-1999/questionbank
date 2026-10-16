import type { PrincipalRef } from '@questionbank/domain-types';
import type { CreateItemDraft, SubmitItemForReview } from '../../content/public/index.js';
import type { ModelPin } from '../domain/model-pin.js';
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

/**
 * One piece of the grounding block: a source the model is shown, and where it
 * came from. The block is assembled identically for every candidate in a batch
 * (AI-ARCHITECTURE §3), so the same excerpts in the same order are a request's
 * stable prefix.
 */
export interface GroundingExcerpt {
  readonly sourceId: string;
  readonly text: string;
}

/**
 * What the pipeline asks a provider for — in generation's own terms.
 *
 * The request is composed in the order the architecture fixes (system →
 * grounding → task → output schema, §243), but the *system* and *output schema*
 * parts are the adapter's own business: they belong to the prompt version the
 * pin names, which the adapter resolves. What crosses this port is the part the
 * domain decides — the pin, what to ground on, and what to produce.
 *
 * Nothing here is a provider's wire shape. There is no model name, because the
 * model is `pin.modelVersionId`, a registry row; no HTTP concept; no credential.
 */
export interface ProposalRequest {
  readonly pin: ModelPin;
  readonly grounding: readonly GroundingExcerpt[];
  /** What to produce: the item type, subject and band the run asked for. A JSON object whose shape is the pipeline's. */
  readonly task: Readonly<Record<string, unknown>>;
}

/**
 * What comes back: a proposal and how sure the model was. Exactly the two things
 * a candidate needs that the pipeline does not already have — the body, and the
 * confidence M5-13 made mandatory.
 */
export interface ProposalResponse {
  readonly itemType: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly confidence: number;
}

/**
 * **The provider port** (EXT-05): substituting a provider is a change to one
 * adapter, never to the domain. A provider that is unavailable or rate-limited
 * is an application error of that kind — "queue and retry; no student path
 * depends on live AI" (AI-12) — and every other failure is the adapter's to
 * describe, in the same taxonomy.
 *
 * Adapters live in `infrastructure/provider/` and nowhere else; the fitness rule
 * `checkProviderIsolation` holds that line.
 */
export interface ProposalProvider {
  propose(request: ProposalRequest): Promise<Result<ProposalResponse, ApplicationError>>;
}

/**
 * A structured question put to a model, and the structured answer: the shape
 * every pre-check that needs a second opinion takes (AI-ARCHITECTURE §11).
 *
 * It is the same discipline as `ProposalRequest` — generation's own terms, a
 * registry reference for the model and prompt, no wire shape and no model name —
 * with one difference that matters: the *input* is the check's to build, and a
 * check that must not see the answer key simply never puts it there. What a
 * checker was shown is therefore exactly this object, and a test can read it.
 */
export interface JudgementRequest {
  readonly modelVersionId: string;
  readonly promptVersionId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface JudgementResponse {
  readonly output: Readonly<Record<string, unknown>>;
}

/** The second port (EXT-05): the same isolation rule governs it, and the same adapter directory holds its adapters. */
export interface JudgementProvider {
  judge(request: JudgementRequest): Promise<Result<JudgementResponse, ApplicationError>>;
}

/**
 * A taxonomy version as the syllabus check needs it: whether it is in force, and
 * which concepts it contains. Curriculum's own view, reduced to the two facts
 * that matter, in generation's terms.
 */
export interface SyllabusVersion {
  readonly taxonomyVersionId: string;
  /** Curriculum's lifecycle state; only `published` is a syllabus anything may be tagged against. */
  readonly state: string;
  readonly concepts: readonly { readonly conceptIdentityId: string; readonly displayName: string }[];
}

/**
 * Concept membership, read from curriculum (check 5). The implementation runs
 * curriculum's own query under the caller's context — curriculum decides who may
 * read — so generation holds no copy of the syllabus and no tag list of its own.
 */
export interface SyllabusReader {
  read(taxonomyVersionId: string, context: ApplicationContext): Promise<Result<SyllabusVersion, ApplicationError>>;
}
