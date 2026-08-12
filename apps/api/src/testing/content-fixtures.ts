import type { PrincipalRef } from '@questionbank/domain-types';
import { createContentBody, type Block, type ContentBody } from '../contexts/content/domain/content-body.js';
import type { CreateItemVersionProps, DifficultyBand } from '../contexts/content/domain/item-version.js';
import type { CreateProvenanceProps } from '../contexts/content/domain/provenance.js';
import type { CreateTaxonomyTagProps } from '../contexts/content/domain/taxonomy-tag.js';
import type {
  CreateResponseSpecificationProps,
  ItemOption,
  NumericAnswerSpecData,
} from '../contexts/content/domain/response-specification.js';

/**
 * Content fixtures shared across the M3 specs. Every builder produces a valid
 * value with a single named override point, so a test that means to exercise
 * one failure does not have to restate a whole item to get there.
 */

export const PROVENANCE_CONTEXT = Object.freeze({ latestPlausibleYear: 2026 });

export const AUTHOR: PrincipalRef = Object.freeze({
  kind: 'human',
  id: 'author-1',
  roleContext: Object.freeze(['author']),
});

export const REVIEWER: PrincipalRef = Object.freeze({
  kind: 'human',
  id: 'reviewer-1',
  roleContext: Object.freeze(['reviewer']),
});

export const AI_AGENT: PrincipalRef = Object.freeze({
  kind: 'ai_agent',
  id: 'model-7',
  roleContext: Object.freeze(['generator']),
});

export function textBody(value: string): ContentBody {
  const block: Block = { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value, marks: [] }] };
  const built = createContentBody([block]);
  if (!built.ok) throw new Error(`fixture body is invalid: ${built.error.code}`);
  return built.value;
}

export function mathBody(latex: string, textAlternative: string): ContentBody {
  const built = createContentBody([{ kind: 'MATH_BLOCK', latex, textAlternative }]);
  if (!built.ok) throw new Error(`fixture body is invalid: ${built.error.code}`);
  return built.value;
}

export function itemOption(optionId: string, ordinal: number, value = `option ${optionId}`): ItemOption {
  return { optionId, ordinal, body: textBody(value) };
}

export const FOUR_OPTIONS: readonly ItemOption[] = Object.freeze([
  itemOption('a', 1),
  itemOption('b', 2),
  itemOption('c', 3),
  itemOption('d', 4),
]);

export const NUMERIC_SPEC: NumericAnswerSpecData = Object.freeze({
  expectedValue: '9.81',
  comparisonMode: 'ABSOLUTE_TOLERANCE',
  toleranceValue: '0.01',
  unit: Object.freeze({ canonical: 'm/s^2', acceptedEquivalents: Object.freeze(['m s^-2']), required: true }),
  acceptedForms: Object.freeze(['DECIMAL', 'SCIENTIFIC'] as const),
});

export function singleCorrectSpec(
  overrides: Partial<Extract<CreateResponseSpecificationProps, { itemType: 'SINGLE_CORRECT_MCQ' }>> = {},
): CreateResponseSpecificationProps {
  return { itemType: 'SINGLE_CORRECT_MCQ', options: FOUR_OPTIONS, correctOptionId: 'b', ...overrides };
}

export function numericSpec(
  overrides: Partial<NumericAnswerSpecData> = {},
): CreateResponseSpecificationProps {
  return { itemType: 'NUMERIC', spec: { ...NUMERIC_SPEC, ...overrides } };
}

export function tags(overrides: Partial<CreateTaxonomyTagProps> = {}): readonly CreateTaxonomyTagProps[] {
  return [
    {
      conceptIdentityId: 'concept-kinematics',
      taxonomyVersionId: 'taxonomy-2026',
      weight: 1,
      isPrimary: true,
      ...overrides,
    },
  ];
}

export function originalProvenance(
  overrides: Partial<CreateProvenanceProps> = {},
): CreateProvenanceProps {
  return { sourceType: 'original', authorRef: 'author-1', ...overrides };
}

export function aiProvenance(overrides: Partial<CreateProvenanceProps> = {}): CreateProvenanceProps {
  return {
    sourceType: 'ai_generated',
    modelVersionId: 'model-7',
    promptVersionId: 'prompt-3',
    generationRunId: 'run-99',
    confidence: 0.82,
    ...overrides,
  };
}

export const AUTHORED_AT = '2026-08-09T10:00:00Z';

export function itemVersionProps(
  overrides: Partial<CreateItemVersionProps> = {},
): CreateItemVersionProps {
  return {
    versionId: 'version-1',
    versionNo: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: tags(),
    difficultyEstimate: 'moderate' satisfies DifficultyBand,
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
    authoredBy: AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}
