import type { ImportBatchHeader, ImportItemRecord } from '../../contexts/content/application/import/import-batch.js';

/**
 * The 500-record import corpus (M3-45), **generated deterministically**.
 *
 * A hand-written 500-line JSON Lines file is unreviewable and rots the first
 * time a field is renamed: nobody diffs it, so nobody notices when half of it
 * stops meaning anything. This builder produces the file, the file is
 * committed, and the spec regenerates it and compares — so the artifact and
 * the generator cannot drift, and a reviewer reads sixty lines of intent
 * rather than five hundred lines of data.
 *
 * **No clock and no randomness.** Variety comes from a small linear
 * congruential sequence over the record index, so the corpus is the same
 * bytes on every machine and the rejection set is a fact rather than a
 * distribution.
 */

export const CORPUS_SIZE = 500;

const BATCH_ID = '019fd4bc-9000-7000-8000-000000000001';
const TAXONOMY_VERSION_ID = '019fd4bc-9000-7000-8000-000000000002';
const CONCEPT_IDS = [
  '019fd4bc-9001-7000-8000-000000000001',
  '019fd4bc-9001-7000-8000-000000000002',
  '019fd4bc-9001-7000-8000-000000000003',
  '019fd4bc-9001-7000-8000-000000000004',
];

/**
 * Deterministic variety. A 31-bit linear congruential step over the index —
 * the constants stay inside `Number.MAX_SAFE_INTEGER`, so the sequence is
 * exact arithmetic rather than whatever the float happens to round to.
 */
function shuffleOf(index: number): number {
  return (index * 1103515245 + 12345) % 2147483648;
}

function pick<T>(choices: readonly T[], index: number): T {
  return choices[Math.abs(shuffleOf(index)) % choices.length] as T;
}

export function corpusHeader(): ImportBatchHeader {
  return {
    kind: 'batch_header',
    batchId: BATCH_ID,
    source: 'JEE Main previous-year corpus, 2015–2019',
    subject: 'physics',
    licensing: { status: 'owned' },
  };
}

function textBody(value: string): ImportItemRecord['stem'] {
  return { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value, marks: [] }] }] };
}

interface OptionLine {
  readonly optionId: string;
  readonly ordinal: number;
  readonly body: ImportItemRecord['stem'];
}

function options(count: number, prefix: string): OptionLine[] {
  return Array.from({ length: count }, (_unused, at) => ({
    optionId: `${prefix}${at + 1}`,
    ordinal: at + 1,
    body: textBody(`Option ${at + 1}`),
  }));
}

function mcqRecord(index: number): ImportItemRecord {
  return {
    kind: 'item',
    recordId: `pyq-${String(index).padStart(4, '0')}`,
    itemType: 'SINGLE_CORRECT_MCQ',
    stem: textBody(`A body of mass ${1 + (index % 9)} kg is acted on by a constant force. Question ${index}.`),
    responseSpec: {
      itemType: 'SINGLE_CORRECT_MCQ',
      options: options(4, 'o'),
      correctOptionId: `o${1 + (Math.abs(shuffleOf(index)) % 4)}`,
    } as ImportItemRecord['responseSpec'],
    taxonomyTags: [
      {
        conceptIdentityId: pick(CONCEPT_IDS, index),
        taxonomyVersionId: TAXONOMY_VERSION_ID,
        weight: 1,
        isPrimary: true,
      },
    ],
    difficultyEstimate: pick(['foundational', 'moderate', 'challenging', 'advanced'] as const, index + 1),
    sourceExam: 'JEE Main',
    sourceYear: 2015 + (index % 5),
    sourceSession: `session-${1 + (index % 2)}`,
  };
}

function numericRecord(index: number): ImportItemRecord {
  return {
    ...mcqRecord(index),
    itemType: 'NUMERIC',
    responseSpec: {
      itemType: 'NUMERIC',
      spec: {
        expectedValue: `${9 + (index % 3)}.8${index % 10}`,
        comparisonMode: 'ABSOLUTE_TOLERANCE',
        toleranceValue: '0.01',
        unit: { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true },
        acceptedForms: ['DECIMAL', 'SCIENTIFIC'],
      },
    } as ImportItemRecord['responseSpec'],
  };
}

/**
 * The rejection classes the corpus deliberately contains, and the record that
 * produces each.
 *
 * **Three of the nine classes M3-45 names are not import rejections, and the
 * corpus says so rather than the check being narrowed until they are.** They
 * are carried here as *accepted* records, and the spec asserts they land as
 * drafts with a named test explaining why:
 *
 *  - **unresolved licensing** — `unresolved` is the *default* for a new draft
 *    (M3-06). Rejecting it at import would mean an item could never be
 *    imported before its rights were settled, which inverts FR-QM-05 rule 4:
 *    that rule blocks *publication*, and publication is where M3-11 enforces it.
 *  - **missing solution** — a solution is a publication precondition, not a
 *    draft one. An import that required one could not carry a previous-year
 *    paper at all, which is the corpus this path exists for (FR-QM-10).
 *  - **unrenderable notation** — the render verdict is produced by
 *    `validateRender` (M3-38) and consumed at publication. Import consults no
 *    renderer, and inventing a second, weaker notion of "unrenderable" here is
 *    exactly the parallel validator DEC-7 forbids. What import *does* refuse is
 *    a body the `ContentBody` constructor rejects, which the corpus carries.
 */
export const PLANNED_REJECTIONS = [
  'MISSING_TAG',
  'MALFORMED_RECORD',
  'UNKNOWN_ITEM_TYPE',
  'DUPLICATE_OPTION_ID',
  'CORRECT_OPTION_UNKNOWN',
  'NUMERIC_MODE_PARAMETER_MISSING',
  'LICENSE_REF_REQUIRED',
  'SOURCE_YEAR_MISSING',
  'NOTATION_WITHOUT_ALTERNATIVE',
  'OPTIONS_TOO_FEW',
  'ORDINAL_GAP',
  'DIFFICULTY_BAND_UNKNOWN',
] as const;
export type PlannedRejection = (typeof PLANNED_REJECTIONS)[number];

/**
 * The code the corpus expects each defect to be reported under — **the
 * domain's own**, not a vocabulary invented here (DEC-7). If import ever grew
 * a parallel validator, these would stop matching, which is the point.
 */
export const EXPECTED_CODE: Readonly<Record<PlannedRejection, string>> = Object.freeze({
  MISSING_TAG: 'TAGS_REQUIRED',
  MALFORMED_RECORD: 'RECORD_NOT_JSON',
  UNKNOWN_ITEM_TYPE: 'ITEM_TYPE_MISMATCH',
  DUPLICATE_OPTION_ID: 'OPTION_ID_DUPLICATE',
  CORRECT_OPTION_UNKNOWN: 'CORRECT_OPTION_UNKNOWN',
  NUMERIC_MODE_PARAMETER_MISSING: 'ANSWER_KEY_REJECTED_BY_EXECUTOR',
  LICENSE_REF_REQUIRED: 'LICENSE_REF_REQUIRED',
  SOURCE_YEAR_MISSING: 'SOURCE_YEAR_REQUIRED',
  NOTATION_WITHOUT_ALTERNATIVE: 'TEXT_ALTERNATIVE_REQUIRED',
  OPTIONS_TOO_FEW: 'OPTIONS_TOO_FEW',
  ORDINAL_GAP: 'OPTION_ORDINAL_GAP',
  DIFFICULTY_BAND_UNKNOWN: 'DIFFICULTY_BAND_UNKNOWN',
});

export interface CorpusLine {
  /** 1-based, counting the header as line 1 — the number the report uses. */
  readonly lineNumber: number;
  readonly recordId: string;
  /** Absent on a record the corpus expects to be imported. */
  readonly plannedRejection?: PlannedRejection;
  /** The serialized line. A malformed record is not valid JSON at all. */
  readonly text: string;
}

function line(index: number, record: unknown, plannedRejection?: PlannedRejection): CorpusLine {
  const recordId =
    typeof record === 'object' && record !== null && 'recordId' in record
      ? String((record as { recordId: unknown }).recordId)
      : `pyq-${String(index).padStart(4, '0')}`;
  return {
    lineNumber: index + 1,
    recordId,
    ...(plannedRejection === undefined ? {} : { plannedRejection }),
    text: JSON.stringify(record),
  };
}

/** One defective record per rejection class, in a fixed order. */
function defectiveLine(index: number, rejection: PlannedRejection): CorpusLine {
  const base = mcqRecord(index);

  switch (rejection) {
    case 'MISSING_TAG':
      return line(index, { ...base, taxonomyTags: [] }, rejection);
    case 'MALFORMED_RECORD':
      return {
        lineNumber: index + 1,
        recordId: '',
        plannedRejection: rejection,
        text: `{"kind":"item","recordId":"pyq-${String(index).padStart(4, '0')}",`,
      };
    case 'UNKNOWN_ITEM_TYPE':
      return line(index, { ...base, itemType: 'ESSAY' }, rejection);
    case 'DUPLICATE_OPTION_ID':
      return line(
        index,
        {
          ...base,
          responseSpec: {
            itemType: 'SINGLE_CORRECT_MCQ',
            options: [
              { optionId: 'o1', ordinal: 1, body: textBody('Option 1') },
              { optionId: 'o1', ordinal: 2, body: textBody('Option 2') },
            ],
            correctOptionId: 'o1',
          },
        },
        rejection,
      );
    case 'CORRECT_OPTION_UNKNOWN':
      return line(
        index,
        {
          ...base,
          responseSpec: {
            itemType: 'SINGLE_CORRECT_MCQ',
            options: options(4, 'o'),
            correctOptionId: 'o9',
          },
        },
        rejection,
      );
    case 'NUMERIC_MODE_PARAMETER_MISSING': {
      const numeric = numericRecord(index);
      const spec = numeric.responseSpec as unknown as { spec: Record<string, unknown> };
      const { toleranceValue: _dropped, ...withoutTolerance } = spec.spec;
      return line(
        index,
        { ...numeric, responseSpec: { itemType: 'NUMERIC', spec: withoutTolerance } },
        rejection,
      );
    }
    case 'LICENSE_REF_REQUIRED':
      return line(index, { ...base, licensing: { status: 'licensed' } }, rejection);
    case 'SOURCE_YEAR_MISSING': {
      const { sourceYear: _dropped, ...withoutYear } = base;
      return line(index, withoutYear, rejection);
    }
    case 'NOTATION_WITHOUT_ALTERNATIVE':
      return line(
        index,
        {
          ...base,
          stem: {
            schemaVersion: 1,
            blocks: [{ kind: 'MATH_BLOCK', latex: 'F = ma', textAlternative: '' }],
          },
        },
        rejection,
      );
    case 'OPTIONS_TOO_FEW':
      return line(
        index,
        {
          ...base,
          responseSpec: {
            itemType: 'SINGLE_CORRECT_MCQ',
            options: options(1, 'o'),
            correctOptionId: 'o1',
          },
        },
        rejection,
      );
    case 'ORDINAL_GAP':
      return line(
        index,
        {
          ...base,
          responseSpec: {
            itemType: 'SINGLE_CORRECT_MCQ',
            options: [
              { optionId: 'o1', ordinal: 1, body: textBody('Option 1') },
              { optionId: 'o2', ordinal: 3, body: textBody('Option 2') },
            ],
            correctOptionId: 'o1',
          },
        },
        rejection,
      );
    default:
      return line(index, { ...base, difficultyEstimate: 'impossible' }, rejection);
  }
}

/**
 * The records that exercise a *policy* boundary rather than a defect: they are
 * expected to import, and the spec asserts they do.
 */
const ACCEPTED_EDGE_CASES = ['UNRESOLVED_LICENSING', 'NO_SOLUTION', 'NUMERIC'] as const;

function acceptedEdgeCase(index: number, kind: (typeof ACCEPTED_EDGE_CASES)[number]): CorpusLine {
  if (kind === 'UNRESOLVED_LICENSING') {
    return line(index, { ...mcqRecord(index), licensing: { status: 'unresolved' } });
  }
  if (kind === 'NUMERIC') return line(index, numericRecord(index));
  return line(index, mcqRecord(index));
}

/** The corpus as structured lines, so the spec can state its expectations. */
export function corpusLines(): readonly CorpusLine[] {
  const lines: CorpusLine[] = [];

  // Line 1 is the header, so record indices start at 1.
  let index = 1;

  for (const rejection of PLANNED_REJECTIONS) {
    lines.push(defectiveLine(index, rejection));
    index += 1;
  }

  for (const kind of ACCEPTED_EDGE_CASES) {
    lines.push(acceptedEdgeCase(index, kind));
    index += 1;
  }

  while (lines.length < CORPUS_SIZE) {
    lines.push(line(index, index % 7 === 0 ? numericRecord(index) : mcqRecord(index)));
    index += 1;
  }

  return lines;
}

/** The JSON Lines document: the header, then every record, newline-terminated. */
export function buildCorpus(): string {
  return [JSON.stringify(corpusHeader()), ...corpusLines().map((entry) => entry.text)].join('\n');
}
