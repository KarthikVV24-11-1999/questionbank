import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  AI_SOURCE_TYPES,
  createProvenance,
  EARLIEST_SOURCE_YEAR,
  isAiSourceType,
  isMachineProposed,
  SOURCE_TYPES,
  type CreateProvenanceProps,
} from './provenance.js';

const CONTEXT = { latestPlausibleYear: 2026 } as const;

const AI_FIELDS = {
  modelVersionId: 'model-7',
  promptVersionId: 'prompt-3',
  generationRunId: 'run-99',
  confidence: 0.82,
} as const;

function build(overrides: Partial<CreateProvenanceProps> = {}): CreateProvenanceProps {
  return { sourceType: 'original', ...overrides };
}

describe('the source-type vocabulary', () => {
  it('is the closed set FR-QM-05 rule 2 names', () => {
    expect([...SOURCE_TYPES]).toEqual([
      'original',
      'previous_year',
      'licensed',
      'ai_generated',
      'ai_assisted',
    ]);
  });

  it('names both machine-proposed types', () => {
    expect([...AI_SOURCE_TYPES]).toEqual(['ai_generated', 'ai_assisted']);
  });

  it('recognises each machine-proposed type and no other', () => {
    for (const type of AI_SOURCE_TYPES) expect(isAiSourceType(type)).toBe(true);
    for (const type of ['original', 'previous_year', 'licensed']) expect(isAiSourceType(type)).toBe(false);
  });

  // Guessing `original` for an unknown label would launder a third party's
  // paper into the corpus as our own work.
  it('rejects an unknown source type rather than defaulting it', () => {
    const failure = expectError(
      createProvenance(build({ sourceType: 'scraped' as never }), CONTEXT),
    );
    expect(failure.code).toBe('SOURCE_TYPE_UNKNOWN');
  });
});

describe('original', () => {
  it('constructs with nothing else required', () => {
    expect(expectValue(createProvenance(build(), CONTEXT)).sourceType).toBe('original');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(expectValue(createProvenance(build(), CONTEXT)))).toBe(true);
  });

  it('is not machine-proposed', () => {
    expect(isMachineProposed(expectValue(createProvenance(build(), CONTEXT)))).toBe(false);
  });
});

describe('previous_year', () => {
  function pyq(overrides: Partial<CreateProvenanceProps> = {}): CreateProvenanceProps {
    return build({ sourceType: 'previous_year', sourceExam: 'JEE_MAIN', sourceYear: 2024, ...overrides });
  }

  it('constructs with its exam and year', () => {
    const provenance = expectValue(createProvenance(pyq({ sourceSession: 'January Shift 1' }), CONTEXT));
    expect(provenance).toMatchObject({ sourceExam: 'JEE_MAIN', sourceYear: 2024 });
  });

  it('rejects a missing source exam', () => {
    const props: CreateProvenanceProps = { sourceType: 'previous_year', sourceYear: 2024 };
    expect(expectError(createProvenance(props, CONTEXT)).code).toBe('SOURCE_EXAM_REQUIRED');
  });

  it('rejects a blank source exam', () => {
    expect(expectError(createProvenance(pyq({ sourceExam: '   ' }), CONTEXT)).code).toBe(
      'SOURCE_EXAM_REQUIRED',
    );
  });

  it('rejects a missing source year', () => {
    const props: CreateProvenanceProps = { sourceType: 'previous_year', sourceExam: 'JEE_MAIN' };
    expect(expectError(createProvenance(props, CONTEXT)).code).toBe('SOURCE_YEAR_REQUIRED');
  });

  it.each([
    ['before the earliest modelled year', EARLIEST_SOURCE_YEAR - 1],
    ['after the current year', 2027],
    ['not an integer', 2024.5],
  ])('rejects a year %s', (_label, sourceYear) => {
    expect(expectError(createProvenance(pyq({ sourceYear }), CONTEXT)).code).toBe('SOURCE_YEAR_IMPLAUSIBLE');
  });

  it.each([
    ['exactly the earliest modelled year', EARLIEST_SOURCE_YEAR],
    ['exactly the current year', 2026],
  ])('accepts a year %s', (_label, sourceYear) => {
    expect(expectValue(createProvenance(pyq({ sourceYear }), CONTEXT)).sourceYear).toBe(sourceYear);
  });

  // The bound is supplied, not read from a clock — same discipline as F45.
  it('takes the upper bound from the supplied context, not from a clock', () => {
    expect(expectValue(createProvenance(pyq({ sourceYear: 2030 }), { latestPlausibleYear: 2030 })).sourceYear).toBe(
      2030,
    );
  });
});

describe('licensed', () => {
  it('constructs with an author reference to attribute', () => {
    const provenance = expectValue(
      createProvenance(build({ sourceType: 'licensed', authorRef: 'Acme Publishing' }), CONTEXT),
    );
    expect(provenance.authorRef).toBe('Acme Publishing');
  });

  it('rejects a licensed item with nobody to attribute', () => {
    expect(expectError(createProvenance(build({ sourceType: 'licensed' }), CONTEXT)).code).toBe(
      'ATTRIBUTION_AUTHOR_REQUIRED',
    );
  });

  it('rejects a blank author reference', () => {
    expect(
      expectError(createProvenance(build({ sourceType: 'licensed', authorRef: ' ' }), CONTEXT)).code,
    ).toBe('ATTRIBUTION_AUTHOR_REQUIRED');
  });
});

describe('AI provenance — half of what makes INV-01 auditable', () => {
  for (const sourceType of AI_SOURCE_TYPES) {
    it(`constructs ${sourceType} with all four generation fields`, () => {
      const provenance = expectValue(createProvenance(build({ sourceType, ...AI_FIELDS }), CONTEXT));
      expect(provenance).toMatchObject(AI_FIELDS);
      expect(isMachineProposed(provenance)).toBe(true);
    });

    it.each([
      ['modelVersionId', 'MODEL_VERSION_REQUIRED'],
      ['promptVersionId', 'PROMPT_VERSION_REQUIRED'],
      ['generationRunId', 'GENERATION_RUN_REQUIRED'],
      ['confidence', 'CONFIDENCE_REQUIRED'],
    ])(`rejects ${sourceType} missing %s`, (field, code) => {
      const props = build({ sourceType, ...AI_FIELDS, [field]: undefined });
      expect(expectError(createProvenance(props, CONTEXT)).code).toBe(code);
    });
  }

  it.each([
    ['below zero', -0.1],
    ['above one', 1.1],
    ['not a number', Number.NaN],
  ])('rejects a confidence %s', (_label, confidence) => {
    const props = build({ sourceType: 'ai_generated', ...AI_FIELDS, confidence });
    expect(expectError(createProvenance(props, CONTEXT)).code).toBe('CONFIDENCE_OUT_OF_RANGE');
  });

  it.each([
    ['exactly zero', 0],
    ['exactly one', 1],
  ])('accepts a confidence %s', (_label, confidence) => {
    const props = build({ sourceType: 'ai_generated', ...AI_FIELDS, confidence });
    expect(expectValue(createProvenance(props, CONTEXT)).confidence).toBe(confidence);
  });

  // A human-sourced item carrying model fields is either mislabelled AI
  // content or a copy-paste; both defeat the audit INV-01 rests on.
  it.each([
    ['a model version', { modelVersionId: 'model-7' }],
    ['a prompt version', { promptVersionId: 'prompt-3' }],
    ['a generation run', { generationRunId: 'run-99' }],
    ['a confidence', { confidence: 0.5 }],
  ])('rejects a human-sourced item carrying %s', (_label, extra) => {
    expect(expectError(createProvenance(build(extra), CONTEXT)).code).toBe('AI_FIELDS_ON_HUMAN_SOURCE');
  });

  it('permits a human-sourced item that carries none of them', () => {
    expect(expectValue(createProvenance(build({ authorRef: 'a teacher' }), CONTEXT)).authorRef).toBe(
      'a teacher',
    );
  });
});

describe('import provenance', () => {
  it('carries the batch that created it (FR-TCH-11 rule 3)', () => {
    const provenance = expectValue(createProvenance(build({ importBatchId: 'batch-2026-01' }), CONTEXT));
    expect(provenance.importBatchId).toBe('batch-2026-01');
  });
});

describe('failure locations', () => {
  it('names where the problem is', () => {
    const failure = expectError(
      createProvenance(build({ sourceType: 'licensed' }), CONTEXT, 'versions[2].provenance'),
    );
    expect(failure.location).toBe('versions[2].provenance');
  });
});
