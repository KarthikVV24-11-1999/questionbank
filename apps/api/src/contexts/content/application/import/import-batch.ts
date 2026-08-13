import { err, ok, type Result } from '../../domain/result.js';
import { validationError, type ContentError } from '../../domain/content-error.js';
import type { ContentBody } from '../../domain/content-body.js';
import type { DifficultyBand } from '../../domain/item-version.js';
import type { CreateLicensingStatusProps } from '../../domain/licensing-status.js';
import type { CreateResponseSpecificationProps, ItemType } from '../../domain/response-specification.js';
import type { CreateTaxonomyTagProps } from '../../domain/taxonomy-tag.js';

/**
 * The batch format (DEC-7): JSON Lines, with a **header record first** carrying
 * the batch identity, the source description and a licensing declaration every
 * record inherits.
 *
 * **The header is not optional and its licensing is not defaultable.** FR-QM-10
 * rule 2 rejects undeclared records, and a format that lets a batch omit the
 * declaration turns "undeclared" into "unresolved and imported anyway" — which
 * is how a corpus ends up holding content nobody can account for, the exact
 * question DECISIONS §D item 2 has open.
 *
 * **The path is for previous-year corpora**, which is what FR-QM-10 exists to
 * bring in: every record's provenance is `previous_year`, so a record that does
 * not name its year is rejected rather than imported with the year missing.
 * Original or licensed material is authored, not migrated.
 *
 * **Parsing is separate from constructing.** This module turns bytes into
 * records and says which lines are malformed; it builds nothing. The domain
 * constructors the interactive path uses are the only thing that decides
 * whether a record is a valid item (M3-30's acceptance), so import cannot
 * create a draft the editor would consider invalid.
 */

export interface ImportBatchHeader {
  readonly kind: 'batch_header';
  readonly batchId: string;
  readonly source: string;
  /** Inherited by every record in the batch (FR-QM-10 rule 2). */
  readonly licensing: CreateLicensingStatusProps;
  /** The subject the batch is authored under, scoped like any other authoring. */
  readonly subject: string;
}

/** One item, optionally with its stimulus reference and its solution. */
export interface ImportItemRecord {
  readonly kind: 'item';
  /** The identifier in the *source*, echoed into the rejection report. */
  readonly recordId: string;
  readonly itemType: ItemType;
  readonly stem: ContentBody;
  readonly responseSpec: CreateResponseSpecificationProps;
  readonly taxonomyTags: readonly CreateTaxonomyTagProps[];
  readonly difficultyEstimate: DifficultyBand;
  readonly stimulusVersionRef?: string;
  /** Overrides the batch declaration where a record's rights differ. */
  readonly licensing?: CreateLicensingStatusProps;
  readonly sourceExam?: string;
  readonly sourceYear?: number;
  readonly sourceSession?: string;
}

export type ImportRecord = ImportItemRecord;

export interface ParsedLine {
  readonly lineNumber: number;
  readonly record: ImportRecord;
}

export interface MalformedLine {
  readonly lineNumber: number;
  readonly recordId: string;
  readonly code: MalformedCode;
  readonly message: string;
}

export const MALFORMED_CODES = [
  'RECORD_NOT_JSON',
  'RECORD_KIND_UNKNOWN',
  'RECORD_ID_MISSING',
  'RECORD_FIELD_MISSING',
] as const;
export type MalformedCode = (typeof MALFORMED_CODES)[number];

export interface ParsedBatch {
  readonly header: ImportBatchHeader;
  readonly lines: readonly ParsedLine[];
  readonly malformed: readonly MalformedLine[];
}

export type BatchHeaderErrorCode =
  | 'BATCH_EMPTY'
  | 'HEADER_NOT_JSON'
  | 'HEADER_MISSING'
  | 'BATCH_ID_MISSING'
  | 'SOURCE_MISSING'
  | 'SUBJECT_MISSING'
  | 'LICENSING_UNDECLARED';

export type BatchHeaderError = ContentError<BatchHeaderErrorCode>;

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // A malformed line is data, not an infrastructure fault: it belongs in the
    // rejection report with its line number, not in a stack trace.
    return undefined;
  }
}

/** The fields an item record cannot be built without. */
const REQUIRED_ITEM_FIELDS = ['itemType', 'stem', 'responseSpec', 'taxonomyTags', 'difficultyEstimate'] as const;

/**
 * Splits a JSON Lines batch into its header, its parsable records, and the
 * lines that are not records at all.
 *
 * **A malformed line never stops the batch** (FR-QM-10, FR-TCH-11 rule 2): it
 * is reported and the next line is read. A malformed *header* does stop it,
 * because every record inherits from it and importing under a declaration
 * nobody made is the one outcome rule 2 forbids.
 */
export function parseImportBatch(contents: string): Result<ParsedBatch, BatchHeaderError> {
  const lines = contents
    .split('\n')
    .map((line, index) => ({ lineNumber: index + 1, text: line.trim() }))
    .filter((line) => line.text.length > 0);

  const first = lines[0];
  if (first === undefined) {
    return err(validationError('BATCH_EMPTY', 'a batch is a header line and its records', 'batch'));
  }

  const parsedHeader = parseJson(first.text);
  if (parsedHeader === undefined) {
    return err(validationError('HEADER_NOT_JSON', 'the first line is not a JSON object', 'batch.header'));
  }
  if (parsedHeader['kind'] !== 'batch_header') {
    return err(
      validationError('HEADER_MISSING', 'the first line must be a batch_header record', 'batch.header'),
    );
  }
  if (isBlank(parsedHeader['batchId'])) {
    return err(validationError('BATCH_ID_MISSING', 'a batch names itself', 'batch.header.batchId'));
  }
  if (isBlank(parsedHeader['source'])) {
    return err(
      validationError('SOURCE_MISSING', 'a batch describes where its content came from', 'batch.header.source'),
    );
  }
  if (isBlank(parsedHeader['subject'])) {
    return err(
      validationError('SUBJECT_MISSING', 'a batch names the subject it is authored under', 'batch.header.subject'),
    );
  }
  const licensing = parsedHeader['licensing'];
  if (!isRecord(licensing) || isBlank(licensing['status'])) {
    return err(
      validationError(
        'LICENSING_UNDECLARED',
        'a batch declares the licensing every record inherits; an undeclared batch is refused (FR-QM-10 rule 2)',
        'batch.header.licensing',
      ),
    );
  }

  const header: ImportBatchHeader = Object.freeze({
    kind: 'batch_header',
    batchId: parsedHeader['batchId'] as string,
    source: parsedHeader['source'] as string,
    subject: parsedHeader['subject'] as string,
    licensing: licensing as unknown as CreateLicensingStatusProps,
  });

  const parsed: ParsedLine[] = [];
  const malformed: MalformedLine[] = [];

  for (const line of lines.slice(1)) {
    const record = parseJson(line.text);
    if (record === undefined) {
      malformed.push({
        lineNumber: line.lineNumber,
        recordId: '',
        code: 'RECORD_NOT_JSON',
        message: 'the line is not a JSON object',
      });
      continue;
    }
    if (record['kind'] !== 'item') {
      malformed.push({
        lineNumber: line.lineNumber,
        recordId: typeof record['recordId'] === 'string' ? record['recordId'] : '',
        code: 'RECORD_KIND_UNKNOWN',
        message: `unknown record kind "${String(record['kind'])}"`,
      });
      continue;
    }
    if (isBlank(record['recordId'])) {
      // Without one the rejection report cannot name what failed, which is
      // half of what makes the report actionable.
      malformed.push({
        lineNumber: line.lineNumber,
        recordId: '',
        code: 'RECORD_ID_MISSING',
        message: 'a record names itself so the report can point at it',
      });
      continue;
    }

    const missing = REQUIRED_ITEM_FIELDS.filter((field) => record[field] === undefined);
    if (missing.length > 0) {
      malformed.push({
        lineNumber: line.lineNumber,
        recordId: record['recordId'] as string,
        code: 'RECORD_FIELD_MISSING',
        message: `the record omits ${missing.join(', ')}`,
      });
      continue;
    }

    parsed.push({ lineNumber: line.lineNumber, record: record as unknown as ImportItemRecord });
  }

  return ok(Object.freeze({ header, lines: Object.freeze(parsed), malformed: Object.freeze(malformed) }));
}

export interface RejectedRecord {
  readonly lineNumber: number;
  readonly recordId: string;
  readonly code: string;
  readonly message: string;
  /**
   * Where inside the record the problem is. Explicitly `undefined` for a line
   * that never parsed — there is no inside to point at, and the line number is
   * the location.
   */
  readonly location: string | undefined;
}

export interface ImportedRecord {
  readonly lineNumber: number;
  readonly recordId: string;
  readonly itemId: string;
}

/**
 * Duplicate detection is M4's (DEC-7). The report **says the check has not
 * run** rather than listing nothing found — a report claiming none were found
 * when nothing ran is a lie a reviewer acts on.
 */
export const IMPORT_DUPLICATE_CHECK_STATE = 'deferred';

export interface ImportReport {
  readonly batchId: string;
  readonly source: string;
  readonly totalRecords: number;
  readonly imported: readonly ImportedRecord[];
  readonly rejected: readonly RejectedRecord[];
  readonly duplicateCheckState: typeof IMPORT_DUPLICATE_CHECK_STATE;
}

export function describeImportDuplicateCheck(): string {
  return 'duplicate detection has not run for this batch (FR-QM-04 arrives with M4)';
}
