import type { CreateItemDraft, SubmitItemForReview } from '../../content/public/index.js';
import { err, ok, type Result } from '../domain/result.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, ContentAuthoring } from '../application/ports.js';

/**
 * The shape of a content command handler, as far as this adapter needs it: a
 * command and a context in, a result out. Declared here rather than imported
 * because content's barrel exports commands as types and its handlers not at
 * all (ADR-0025) — and because all that is needed of one is that it can be
 * called. Content's own handlers satisfy it structurally.
 */
export interface CommandHandler<TCommand, TValue> {
  handle(command: TCommand, context: ApplicationContext): Promise<Result<TValue, ApplicationError>>;
}

export interface ContentCommandDependencies {
  /** Content's `CreateItemDraft` handler. Its result is an item; this adapter takes only the identifier. */
  readonly createDraft: CommandHandler<CreateItemDraft, { readonly itemId: string }>;
  /** Content's `SubmitItemForReview` handler. */
  readonly submitForReview: CommandHandler<SubmitItemForReview, unknown>;
}

/**
 * The production `ContentAuthoring` (M5-25): content's own command handlers,
 * called under the caller's own context.
 *
 * **Its dependencies are injected.** It does not resolve a handler, build a
 * repository or reach for a container; the composition root hands it the two
 * handlers. That is what makes it testable without the root, and what keeps the
 * wiring where it belongs. Generation holds no capability to write a content
 * aggregate (SEC-20, F27): every write happens inside the handlers it is given,
 * under content's invariants.
 *
 * It adds nothing and decides nothing. Content's failures come back unchanged,
 * so an operator reads content's own error; the aggregate content returns is
 * reduced to the one identifier the link needs, so no content type leaks into
 * generation's results.
 */
export class ContentCommandAuthoring implements ContentAuthoring {
  readonly #deps: ContentCommandDependencies;

  constructor(deps: ContentCommandDependencies) {
    this.#deps = deps;
  }

  async createDraft(
    command: CreateItemDraft,
    context: ApplicationContext,
  ): Promise<Result<{ readonly itemId: string }, ApplicationError>> {
    const created = await this.#deps.createDraft.handle(command, context);
    return created.ok ? ok({ itemId: created.value.itemId }) : err(created.error);
  }

  async submitForReview(command: SubmitItemForReview, context: ApplicationContext): Promise<Result<true, ApplicationError>> {
    const submitted = await this.#deps.submitForReview.handle(command, context);
    return submitted.ok ? ok(true as const) : err(submitted.error);
  }
}
