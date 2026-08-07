import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarkingRuleSetData } from '../../contexts/scoring/domain/marking-rule-data.js';
import type { AggregationSpecData } from '../../contexts/scoring/domain/aggregation-data.js';
import type { CreateAnswerKeyProps } from '../../contexts/scoring/domain/answer-key.js';
import type { ResponseSnapshot } from '../../contexts/scoring/domain/scoring-input.js';

/**
 * A golden paper is data. Adding one requires no code change — see README.md,
 * which also states plainly what passing the suite does and does not prove.
 */

export const PAPERS_DIR = fileURLToPath(new URL('./papers/', import.meta.url));

export type Provenance = 'official' | 'synthetic';

export interface GoldenSlot {
  readonly slotId: string;
  readonly ordinal: number;
  readonly itemType: string;
  readonly marksAvailable: number;
  readonly answerKey: CreateAnswerKeyProps;
  readonly response?: ResponseSnapshot;
  /** The key's verdict for this slot, written down independently of the code. */
  readonly expectedMarks: string;
  readonly expectedCorrectness: string;
}

export interface GoldenSection {
  readonly ordinal: number;
  readonly slots: readonly GoldenSlot[];
  readonly expectedRaw: string;
}

export interface GoldenPaper {
  readonly paperId: string;
  readonly provenance: Provenance;
  /** Required for an official paper: where the key came from. */
  readonly source?: string;
  readonly description: string;
  readonly ruleSet: MarkingRuleSetData;
  readonly aggregation?: AggregationSpecData;
  readonly sections: readonly GoldenSection[];
  readonly expectedTotal: string;
}

export type GoldenPaperErrorCode =
  | 'PAPER_ID_REQUIRED'
  | 'PROVENANCE_UNKNOWN'
  | 'SYNTHETIC_NOT_LABELLED'
  | 'OFFICIAL_WITHOUT_SOURCE'
  | 'SECTIONS_REQUIRED'
  | 'SLOTS_REQUIRED'
  | 'EXPECTED_MARKS_MISSING'
  | 'SECTION_TOTAL_INCONSISTENT'
  | 'PAPER_TOTAL_INCONSISTENT';

export class GoldenPaperError extends Error {
  constructor(
    readonly code: GoldenPaperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoldenPaperError';
  }
}

function sum(values: readonly string[]): number {
  // Fixture arithmetic only — never scoring arithmetic. The executor's own
  // totals are exact rationals; this is a consistency check on the data.
  return values.reduce((total, value) => total + Number(value), 0);
}

/** Rejects a fixture that is malformed, mislabelled, or inconsistent with itself. */
export function validateGoldenPaper(paper: GoldenPaper, filename: string): GoldenPaper {
  if (paper.paperId.trim().length === 0) {
    throw new GoldenPaperError('PAPER_ID_REQUIRED', `${filename}: paperId is required`);
  }
  if (paper.provenance !== 'official' && paper.provenance !== 'synthetic') {
    throw new GoldenPaperError('PROVENANCE_UNKNOWN', `${filename}: provenance must be official or synthetic`);
  }
  // A synthetic fixture must be unmistakable as one, in the filename and in
  // the identifier that appears in test output (DEC-2 condition 1).
  if (paper.provenance === 'synthetic') {
    if (!filename.includes('synthetic') || !paper.paperId.includes('synthetic')) {
      throw new GoldenPaperError(
        'SYNTHETIC_NOT_LABELLED',
        `${filename}: a synthetic fixture must carry "synthetic" in its filename and paperId`,
      );
    }
  } else if (paper.source === undefined || paper.source.trim().length === 0) {
    throw new GoldenPaperError(
      'OFFICIAL_WITHOUT_SOURCE',
      `${filename}: an official paper must cite the source of its answer key`,
    );
  }

  if (paper.sections.length === 0) {
    throw new GoldenPaperError('SECTIONS_REQUIRED', `${filename}: at least one section is required`);
  }

  for (const section of paper.sections) {
    if (section.slots.length === 0) {
      throw new GoldenPaperError('SLOTS_REQUIRED', `${filename}: section ${section.ordinal} has no slots`);
    }
    for (const slot of section.slots) {
      if (slot.expectedMarks.trim().length === 0) {
        throw new GoldenPaperError(
          'EXPECTED_MARKS_MISSING',
          `${filename}: slot ${slot.slotId} states no expected marks`,
        );
      }
    }
    const slotSum = sum(section.slots.map((slot) => slot.expectedMarks));
    if (Math.abs(slotSum - Number(section.expectedRaw)) > 1e-9) {
      throw new GoldenPaperError(
        'SECTION_TOTAL_INCONSISTENT',
        `${filename}: section ${section.ordinal} slots sum to ${slotSum}, not ${section.expectedRaw}`,
      );
    }
  }

  const sectionSum = sum(paper.sections.map((section) => section.expectedRaw));
  if (Math.abs(sectionSum - Number(paper.expectedTotal)) > 1e-9) {
    throw new GoldenPaperError(
      'PAPER_TOTAL_INCONSISTENT',
      `${filename}: sections sum to ${sectionSum}, not ${paper.expectedTotal}`,
    );
  }

  return paper;
}

export interface LoadedGoldenPaper {
  readonly filename: string;
  readonly paper: GoldenPaper;
}

export function loadGoldenPapers(directory = PAPERS_DIR): readonly LoadedGoldenPaper[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((filename) => {
      const paper = JSON.parse(readFileSync(join(directory, filename), 'utf8')) as GoldenPaper;
      return { filename, paper: validateGoldenPaper(paper, filename) };
    });
}

export function provenanceCounts(papers: readonly LoadedGoldenPaper[]): {
  readonly official: number;
  readonly synthetic: number;
} {
  return {
    official: papers.filter((entry) => entry.paper.provenance === 'official').length,
    synthetic: papers.filter((entry) => entry.paper.provenance === 'synthetic').length,
  };
}
