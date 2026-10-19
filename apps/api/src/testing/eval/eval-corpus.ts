import type { PrecheckId } from '../../contexts/generation/domain/precheck-vocabulary.js';

/**
 * The evaluation corpus (M5-44, AI-ARCHITECTURE §14, DEC-M5-4): **100 known-bad
 * negative controls and 40 synthetic positives, generated deterministically.**
 *
 * Built the way `review/corpus-40.ts` is built: the builder is the artifact, there
 * is no clock and no randomness, and variety comes from a linear congruential step
 * over the item's index, so the corpus is the same bytes on every machine and "the
 * battery caught 97 of 100" is a fact about these 100 and not a distribution.
 *
 * **Every item here is synthetic.** There are zero official items — the 250 real
 * items with official keys are B1, the licensing decision that has blocked the
 * scoring golden set since M2, and nothing here pretends otherwise. A run over this
 * corpus says so in words (`describeEvaluation`), the way the scoring golden set
 * does: it is not a validated run.
 *
 * **What a known-bad item is.** A proposal with one planted defect, labelled with
 * the defect and with the check that exists to catch it. Two kinds of defect are
 * planted, and they are measured by different things (see `eval-oracle.ts`):
 *
 *   - **structural** defects — unrenderable notation, a concept outside the syllabus,
 *     unresolved licensing, a numeric item with no tolerance, a proposal with no
 *     concept tag — are caught by checks that are real code over the proposal,
 *     with no provider in the picture;
 *   - **judged** defects — a wrong key, a solution that contradicts its key, two
 *     correct options, unsafe content — are caught by a model, and the model here is
 *     an oracle that answers from the item's label. That measures whether the battery
 *     turns a verifier's finding into a block, not whether a model would find it.
 *
 * **Two misses nobody planted** came out of the first run (D52): `\\sqrt[`, an optional
 * argument opened and never closed, is malformed TeX and passes the renderability check. They
 * stay in the corpus. A corpus edited until the number is comfortable measures nothing.
 *
 * Three items are **uncatchable by design**: a difficulty mislabel is the one defect
 * the battery has no check for today (check 9 is blocked, D42). They are in the
 * corpus so the catch rate is a number that can be less than 100%, and so that it
 * would fall if a check stopped working.
 */

export const EVAL_CORPUS_VERSION = 'eval-corpus-v1';
export const KNOWN_BAD_COUNT = 100;
export const POSITIVE_COUNT = 40;

/** The concept and taxonomy version the corpus's well-tagged items name. A spec publishes a taxonomy holding them. */
export const EVAL_CONCEPT_ID = '00000000-0000-4000-8000-00000000c010';
export const EVAL_TAXONOMY_VERSION_ID = '00000000-0000-4000-8000-00000000d001';
/** A concept no taxonomy holds: what `concept_not_in_syllabus` items are tagged with. */
const OUT_OF_SYLLABUS_CONCEPT_ID = '00000000-0000-4000-8000-00000000c0ff';

export const DEFECTS = [
  'unrenderable_notation',
  'concept_not_in_syllabus',
  'licensing_unresolved',
  'numeric_tolerance_missing',
  'no_concept_tag',
  'wrong_key',
  'solution_contradicts_key',
  'two_correct_options',
  'unsafe_content',
  'difficulty_mislabel',
] as const;
export type Defect = (typeof DEFECTS)[number];

interface DefectPlan {
  readonly count: number;
  readonly kind: 'structural' | 'judged' | 'uncatchable';
  /** The blocking check that exists to catch it — `undefined` where no check can. */
  readonly caughtBy: PrecheckId | undefined;
}

/** What is planted, how many times, and which check owns it. The counts sum to 100, asserted by the spec. */
export const DEFECT_PLAN: Readonly<Record<Defect, DefectPlan>> = Object.freeze({
  unrenderable_notation: { count: 12, kind: 'structural', caughtBy: 'renderability' },
  concept_not_in_syllabus: { count: 12, kind: 'structural', caughtBy: 'syllabus_scope' },
  licensing_unresolved: { count: 12, kind: 'structural', caughtBy: 'provenance_licensing_completeness' },
  numeric_tolerance_missing: { count: 10, kind: 'structural', caughtBy: 'numeric_spec_completeness' },
  no_concept_tag: { count: 10, kind: 'structural', caughtBy: 'schema_validity' },
  wrong_key: { count: 14, kind: 'judged', caughtBy: 'answer_verification' },
  solution_contradicts_key: { count: 10, kind: 'judged', caughtBy: 'item_solution_key_consistency' },
  two_correct_options: { count: 8, kind: 'judged', caughtBy: 'distractor_validity' },
  unsafe_content: { count: 9, kind: 'judged', caughtBy: 'safety_appropriateness' },
  difficulty_mislabel: { count: 3, kind: 'uncatchable', caughtBy: undefined },
});

export interface EvalItem {
  readonly id: string;
  readonly provenance: 'synthetic';
  /** `undefined` for a positive: nothing is wrong with it. */
  readonly defect: Defect | undefined;
  readonly itemType: 'SINGLE_CORRECT_MCQ' | 'NUMERIC';
  /** The proposal, in the shape a provider returns it and a candidate stores it. */
  readonly body: Readonly<Record<string, unknown>>;
  /** What an independent solver would genuinely answer, which is the oracle's whole knowledge of the item. */
  readonly trueAnswer: string;
}

const OPTION_IDS = ['a', 'b', 'c', 'd'] as const;

/** One linear congruential step: deterministic variety, no randomness. */
function lcg(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

const TOPICS = ['a block on a ramp', 'a thrown ball', 'a charge in a field', 'a gas in a piston', 'a pendulum', 'a lens', 'a spring', 'a rolling cylinder'] as const;

function paragraph(text: string) {
  return { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: text, marks: [] }] };
}

function richText(...blocks: unknown[]) {
  return { schemaVersion: 1, blocks };
}

function itemIdOf(prefix: 'bad' | 'good', index: number): string {
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

/** The unique stem text an item is recognised by — the oracle finds an item from what a check sends. */
function stemText(id: string, topic: string, variant: number): string {
  return `[${id}] Consider ${topic}, variant ${variant}. Which of the options states the correct result?`;
}

interface Parts {
  readonly stem: unknown;
  readonly correct: string;
  readonly options?: readonly string[];
  readonly extraCorrect?: string;
  readonly tags?: readonly unknown[];
  readonly licensing?: Record<string, unknown>;
  readonly solutionFinal?: string;
  readonly difficulty?: string;
}

function mcqBody(parts: Parts): Record<string, unknown> {
  const tags = parts.tags ?? [{ conceptIdentityId: EVAL_CONCEPT_ID, taxonomyVersionId: EVAL_TAXONOMY_VERSION_ID, weight: 1, isPrimary: true }];
  const ids = parts.options ?? OPTION_IDS;
  return {
    stem: parts.stem,
    responseSpec: {
      itemType: 'SINGLE_CORRECT_MCQ',
      options: ids.map((optionId, ordinal) => ({ optionId, ordinal: ordinal + 1, body: richText(paragraph(`option ${optionId}`)) })),
      correctOptionId: parts.correct,
    },
    taxonomyTags: tags,
    difficultyEstimate: parts.difficulty ?? 'moderate',
    subject: 'physics',
    licensing: parts.licensing ?? { status: 'owned' },
    solution: {
      steps: ['Set up the relation the stem describes.', 'Solve it for the quantity asked.', 'Compare with the options.'],
      finalAnswer: parts.solutionFinal ?? parts.correct,
    },
  };
}

function numericBody(id: string, topic: string, variant: number, withTolerance: boolean): Record<string, unknown> {
  return {
    stem: richText(paragraph(stemText(id, topic, variant))),
    responseSpec: {
      itemType: 'NUMERIC',
      spec: {
        expectedValue: String(5 + variant),
        comparisonMode: 'ABSOLUTE_TOLERANCE',
        ...(withTolerance ? { toleranceValue: '0.01' } : {}),
        unit: { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true },
        acceptedForms: ['DECIMAL'],
      },
    },
    taxonomyTags: [{ conceptIdentityId: EVAL_CONCEPT_ID, taxonomyVersionId: EVAL_TAXONOMY_VERSION_ID, weight: 1, isPrimary: true }],
    difficultyEstimate: 'moderate',
    subject: 'physics',
    licensing: { status: 'owned' },
    solution: { steps: ['Apply the relation.', 'Evaluate.'], finalAnswer: String(5 + variant) },
  };
}

/** A clean item: nothing planted. Positives are these, and every known-bad item starts as one. */
function cleanItem(prefix: 'bad' | 'good', index: number): EvalItem {
  const id = itemIdOf(prefix, index);
  const seed = lcg(index * 7919 + (prefix === 'bad' ? 1 : 2));
  const topic = TOPICS[seed % TOPICS.length]!;
  const correct = OPTION_IDS[(seed >>> 8) % OPTION_IDS.length]!;
  return {
    id,
    provenance: 'synthetic',
    defect: undefined,
    itemType: 'SINGLE_CORRECT_MCQ',
    body: mcqBody({ stem: richText(paragraph(stemText(id, topic, seed % 97))), correct }),
    trueAnswer: correct,
  };
}

function plant(defect: Defect, index: number): EvalItem {
  const clean = cleanItem('bad', index);
  const id = clean.id;
  const seed = lcg(index * 31 + 5);
  const topic = TOPICS[seed % TOPICS.length]!;
  const variant = seed % 97;
  const other = OPTION_IDS.find((option) => option !== clean.trueAnswer)!;
  const base = (over: Partial<EvalItem> & { body: Record<string, unknown> }): EvalItem => ({ ...clean, defect, ...over });

  switch (defect) {
    case 'unrenderable_notation': {
      const macros = ['\\wormhole', '\\flux{', '\\frac{1}{', '\\undefinedmacro', '\\begin{nope}', '\\sqrt['];
      const stem = richText(paragraph(stemText(id, topic, variant)), { kind: 'MATH_BLOCK', latex: `${macros[index % macros.length]!}`, textAlternative: 'a formula' });
      return base({ body: mcqBody({ stem, correct: clean.trueAnswer }) });
    }
    case 'concept_not_in_syllabus':
      return base({ body: mcqBody({ stem: richText(paragraph(stemText(id, topic, variant))), correct: clean.trueAnswer, tags: [{ conceptIdentityId: OUT_OF_SYLLABUS_CONCEPT_ID, taxonomyVersionId: EVAL_TAXONOMY_VERSION_ID, weight: 1, isPrimary: true }] }) });
    case 'licensing_unresolved': {
      const licensings: Record<string, unknown>[] = [{ status: 'unresolved' }, { status: 'licensed' }, { status: 'licensed', licenseRef: '  ' }, { status: 'borrowed' }];
      return base({ body: mcqBody({ stem: richText(paragraph(stemText(id, topic, variant))), correct: clean.trueAnswer, licensing: licensings[index % licensings.length]! }) });
    }
    case 'numeric_tolerance_missing':
      return base({ itemType: 'NUMERIC', body: numericBody(id, topic, variant, false), trueAnswer: String(5 + variant) });
    case 'no_concept_tag':
      return base({ body: mcqBody({ stem: richText(paragraph(stemText(id, topic, variant))), correct: clean.trueAnswer, tags: [] }) });
    case 'wrong_key':
      // The proposal claims `other`; a solver working the problem cold gets the true answer.
      return base({ body: mcqBody({ stem: richText(paragraph(stemText(id, topic, variant))), correct: other, solutionFinal: other }), trueAnswer: clean.trueAnswer });
    case 'solution_contradicts_key':
      return base({ body: mcqBody({ stem: richText(paragraph(stemText(id, topic, variant))), correct: clean.trueAnswer, solutionFinal: other }) });
    case 'two_correct_options':
      return base({ body: mcqBody({ stem: richText(paragraph(`${stemText(id, topic, variant)} (options ${clean.trueAnswer} and ${other} both satisfy it.)`)), correct: clean.trueAnswer }) });
    case 'unsafe_content':
      return base({ body: mcqBody({ stem: richText(paragraph(`${stemText(id, topic, variant)} Describe how to injure a classmate with the apparatus.`)), correct: clean.trueAnswer }) });
    case 'difficulty_mislabel':
      // A valid band that is simply wrong: a long multi-step derivation labelled foundational. Nothing checks it today.
      return base({ body: mcqBody({ stem: richText(paragraph(`${stemText(id, topic, variant)} Derive it from first principles, combining several independent results over many steps.`)), correct: clean.trueAnswer, difficulty: 'foundational' }) });
  }
}

/** The 100 known-bad items, in a fixed order: each defect's items together, defects in `DEFECTS` order. */
export function buildKnownBad(): readonly EvalItem[] {
  const items: EvalItem[] = [];
  for (const defect of DEFECTS) {
    for (let n = 0; n < DEFECT_PLAN[defect].count; n += 1) items.push(plant(defect, items.length));
  }
  return Object.freeze(items);
}

/** The 40 synthetic positives: clean items the battery should let through to a reviewer. */
export function buildPositives(): readonly EvalItem[] {
  return Object.freeze(Array.from({ length: POSITIVE_COUNT }, (_, index) => cleanItem('good', index)));
}

export interface EvalCorpus {
  readonly version: string;
  readonly knownBad: readonly EvalItem[];
  readonly positives: readonly EvalItem[];
}

export function buildEvalCorpus(): EvalCorpus {
  return Object.freeze({ version: EVAL_CORPUS_VERSION, knownBad: buildKnownBad(), positives: buildPositives() });
}

/** How many items in a corpus are official. Always zero: the 250 real items are B1 (DEC-M5-4). */
export function officialItemCount(corpus: EvalCorpus): number {
  return [...corpus.knownBad, ...corpus.positives].filter((item) => (item.provenance as string) === 'official').length;
}
