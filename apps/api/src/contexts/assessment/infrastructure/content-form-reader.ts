import type { JsonValue } from '../domain/form-package.js';
import { err, ok, type Result } from '../domain/result.js';
import type { ApplicationError } from '../application/authorization.js';
import type { ApplicationContext, FormContentReader } from '../application/ports.js';

/**
 * Reads the versions a form pinned from content, by version id, through the two
 * handlers the composition root passes (`contentForAssessment`). The view each
 * returns is content's own delivery view, built field by field with no key in
 * it; this adapter hands it on as opaque JSON and interprets none of it.
 *
 * Handlers are declared by the shape assessment needs of them, as
 * `ContentCorpus` does: nothing in assessment names a content handler class.
 */
interface VersionHandler<TQuery> {
  handle(query: TQuery, context: ApplicationContext): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: ApplicationError }>;
}

export class ContentFormReader implements FormContentReader {
  readonly #itemVersion: VersionHandler<{ readonly itemVersionId: string }>;
  readonly #stimulusVersion: VersionHandler<{ readonly stimulusVersionId: string }>;

  constructor(deps: {
    readonly itemVersion: VersionHandler<{ readonly itemVersionId: string }>;
    readonly stimulusVersion: VersionHandler<{ readonly stimulusVersionId: string }>;
  }) {
    this.#itemVersion = deps.itemVersion;
    this.#stimulusVersion = deps.stimulusVersion;
  }

  async itemVersion(itemVersionId: string, context: ApplicationContext): Promise<Result<JsonValue, ApplicationError>> {
    const found = await this.#itemVersion.handle({ itemVersionId }, context);
    return found.ok ? ok(found.value as JsonValue) : err(found.error);
  }

  async stimulusVersion(stimulusVersionId: string, context: ApplicationContext): Promise<Result<JsonValue, ApplicationError>> {
    const found = await this.#stimulusVersion.handle({ stimulusVersionId }, context);
    return found.ok ? ok(found.value as JsonValue) : err(found.error);
  }
}
