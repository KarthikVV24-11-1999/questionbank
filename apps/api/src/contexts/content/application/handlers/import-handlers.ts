import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { ItemRepository } from '../../domain/repository-ports.js';
import { createItem, type Item } from '../../domain/item.js';
import { createItemVersion } from '../../domain/item-version.js';
import { createContentBody, type ContentBody } from '../../domain/content-body.js';
import { validationError } from '../../domain/content-error.js';
import { checkSpecificationIsScorable } from '../answer-key-projection.js';
import {
  applicationError,
  authorize,
  authorizeSubjectScope,
  policy,
  type ApplicationError,
} from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import {
  IMPORT_DUPLICATE_CHECK_STATE,
  parseImportBatch,
  type ImportBatchHeader,
  type ImportedRecord,
  type ImportItemRecord,
  type ImportReport,
  type RejectedRecord,
} from '../import/import-batch.js';

/**
 * FR-TCH-11 and FR-QM-10 — volume without bypassing governance.
 *
 * **Every record goes through `createItemVersion` and `createItem`, the same
 * constructors the interactive path uses.** Not a parallel validator: two
 * validators for one rule drift, and the drift's shape is import creating
 * drafts the editor considers invalid — an author opening one and being unable
 * to save it.
 *
 * **Every record enters as `draft`.** `createItem` has no other starting state
 * and this handler calls no transition, so "import never bypasses governance"
 * (rule 1) is a property of what is reachable rather than of what is checked.
 *
 * **One bad record never fails the batch.** Each record is saved on its own, so
 * a failure at record 400 leaves 399 drafts standing — which is the difference
 * between a re-runnable import and one that has to be diagnosed from scratch.
 */

/** FR-QM-10's actors: Content Ops and Author, the latter within their subject. */
export const IMPORT_ITEM_BATCH_POLICY = policy('ImportItemBatch', ['author', 'content_ops']);

export interface ImportItemBatch {
  /** The JSON Lines document, header first. */
  readonly contents: string;
}

export interface ImportDependencies {
  readonly items: ItemRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

function bodyFrom(value: unknown, location: string): Result<ContentBody, ContentError> {
  const blocks = (value as { readonly blocks?: unknown } | undefined)?.blocks;
  if (!Array.isArray(blocks)) {
    return err(
      validationError('CONTENT_BODY_INVALID', 'a body is a document with a blocks array', location),
    );
  }
  return createContentBody(blocks as Parameters<typeof createContentBody>[0]);
}

/**
 * The stem and every option body, reconstructed through the domain
 * constructor rather than trusted as parsed.
 */
function revalidateBodies(
  record: ImportItemRecord,
): Result<
  { readonly stem: ContentBody; readonly responseSpec: ImportItemRecord['responseSpec'] },
  ContentError
> {
  const stem = bodyFrom(record.stem, 'version.stem');
  if (!stem.ok) return err(stem.error);

  const spec = record.responseSpec as { readonly options?: readonly { readonly body: unknown }[] };
  if (!Array.isArray(spec.options)) return ok({ stem: stem.value, responseSpec: record.responseSpec });

  const options: unknown[] = [];
  for (const [index, option] of spec.options.entries()) {
    const body = bodyFrom(option.body, `version.responseSpec.options[${index}].body`);
    if (!body.ok) return err(body.error);
    options.push({ ...option, body: body.value });
  }

  return ok({
    stem: stem.value,
    responseSpec: { ...record.responseSpec, options } as ImportItemRecord['responseSpec'],
  });
}

export class ImportItemBatchHandler implements Handler<ImportItemBatch, ImportReport> {
  readonly name = 'ImportItemBatch';
  readonly policy = IMPORT_ITEM_BATCH_POLICY;

  constructor(private readonly deps: ImportDependencies) {}

  async handle(
    command: ImportItemBatch,
    context: ApplicationContext,
  ): Promise<Result<ImportReport, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const parsed = parseImportBatch(command.contents);
    if (!parsed.ok) return err(fromContent(parsed.error));
    const { header, lines, malformed } = parsed.value;

    const scoped = authorizeSubjectScope(header.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const imported: ImportedRecord[] = [];
    // A line that never parsed is already a rejection; it keeps its line
    // number so the report points at the file rather than at an index.
    const rejected: RejectedRecord[] = malformed.map((line) => ({
      lineNumber: line.lineNumber,
      recordId: line.recordId,
      code: line.code,
      message: line.message,
      location: undefined,
    }));

    for (const line of lines) {
      const outcome = await this.#importRecord(header, line.record, context);
      if (outcome.ok) {
        imported.push({
          lineNumber: line.lineNumber,
          recordId: line.record.recordId,
          itemId: outcome.value.itemId,
        });
      } else {
        rejected.push({
          lineNumber: line.lineNumber,
          recordId: line.record.recordId,
          code: outcome.error.code,
          message: outcome.error.message,
          location: outcome.error.location,
        });
      }
    }

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'ImportBatch',
      targetId: header.batchId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
      justification: `${imported.length} imported, ${rejected.length} rejected from ${header.source}`,
    });

    return ok(
      Object.freeze({
        batchId: header.batchId,
        source: header.source,
        totalRecords: lines.length + malformed.length,
        imported: Object.freeze(imported),
        rejected: Object.freeze(rejected),
        duplicateCheckState: IMPORT_DUPLICATE_CHECK_STATE,
      }),
    );
  }

  async #importRecord(
    header: ImportBatchHeader,
    record: ImportItemRecord,
    context: ApplicationContext,
  ): Promise<Result<Item, ApplicationError>> {
    const at = this.deps.clock.now();

    // **Every authored body goes back through `createContentBody`.** The
    // parser turns bytes into records and asserts nothing about their shape,
    // so without this a JSON document could carry an equation with a blank
    // `textAlternative` — which the editor refuses and ACC-02 forbids — and
    // import would create a draft the interactive path considers invalid,
    // which is the one thing DEC-7 says the import path must not do. Found by
    // M3-45's corpus.
    const bodies = revalidateBodies(record);
    if (!bodies.ok) return err(fromContent(bodies.error));

    const version = createItemVersion(
      {
        versionId: this.deps.identifiers.next(),
        versionNo: 1,
        itemType: record.itemType,
        stem: bodies.value.stem,
        responseSpec: bodies.value.responseSpec,
        taxonomyTags: record.taxonomyTags,
        difficultyEstimate: record.difficultyEstimate,
        // FR-TCH-11 rule 3: every imported record carries provenance naming
        // the batch and the source, so a defect found later can be traced to
        // the corpus it came from rather than to "an import, some time".
        provenance: {
          sourceType: 'previous_year',
          sourceExam: record.sourceExam ?? header.source,
          ...(record.sourceYear === undefined ? {} : { sourceYear: record.sourceYear }),
          ...(record.sourceSession === undefined ? {} : { sourceSession: record.sourceSession }),
          importBatchId: header.batchId,
        },
        // The batch declaration, unless the record states its own.
        licensing: record.licensing ?? header.licensing,
        ...(record.stimulusVersionRef === undefined
          ? {}
          : { stimulusVersionRef: record.stimulusVersionRef }),
        authoredBy: context.principal,
        createdAt: at.toISOString(),
      },
      { latestPlausibleYear: at.getUTCFullYear() },
    );
    if (!version.ok) return err(fromContent(version.error));

    const scorable = checkSpecificationIsScorable(version.value.responseSpec);
    if (!scorable.ok) return err(fromContent(scorable.error));

    const item = createItem({
      itemId: this.deps.identifiers.next(),
      itemType: record.itemType,
      initialVersion: version.value,
    });
    if (!item.ok) return err(fromContent(item.error));

    const saved = await this.deps.items.save(item.value);
    if (!saved.ok) return err(fromContent(saved.error));

    return ok(saved.value);
  }
}
