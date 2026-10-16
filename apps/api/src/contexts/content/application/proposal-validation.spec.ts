import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOUR_OPTIONS, aiProvenance, numericSpec, singleCorrectSpec, tags, textBody } from '../../../testing/content-fixtures.js';
import { sweep } from '../../../testing/mutation-sweep.js';
import { createContentBody } from '../domain/content-body.js';
import { validateProposedContent } from './proposal-validation.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';

const AS_OF = '2026-10-16T09:30:00.000Z';
const FACTS = { asOf: AS_OF, solutionProvided: true, analysedDistractorOptionIds: ['b', 'c', 'd'] };

function content(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec({ correctOptionId: 'a' }),
    taxonomyTags: tags(),
    difficultyEstimate: 'moderate',
    provenance: aiProvenance(),
    licensing: { status: 'owned' },
    ...overrides,
  };
}
const codes = (report: ReturnType<typeof validateProposedContent>): string[] => report.findings.map((finding) => finding.code);
const mathBlock = (latex: string) => createContentBody([{ kind: 'MATH_BLOCK', latex, textAlternative: 'a notation' }]);

describe('validateProposedContent', () => {
  it('reports a sound proposal as submittable, with nothing found', () => {
    const report = validateProposedContent(content(), FACTS);
    expect(report.findings).toEqual([]);
    expect(report.maySubmit).toBe(true);
    expect(report.duplicateCheckState).toBe('not_evaluated');
  });

  it('carries a stimulus reference through, and refuses a blank one as structure', () => {
    expect(validateProposedContent({ ...content(), stimulusVersionRef: 'stimulus-version-1' }, FACTS).findings).toEqual([]);
    const blank = validateProposedContent({ ...content(), stimulusVersionRef: '  ' }, FACTS);
    expect(blank.findings.map((finding) => [finding.code, finding.location])).toEqual([['STRUCTURE_INVALID', 'version.stimulusVersionRef']]);
  });

  it('is judged by validateDraft: a rule it has, the proposal path has', () => {
    expect(codes(validateProposedContent(content({ licensing: { status: 'unresolved' } }), FACTS))).toEqual(['LICENSING_UNRESOLVED']);
    expect(codes(validateProposedContent((() => { const { licensing: _gone, ...rest } = content(); return rest as AuthoredItemContent; })(), FACTS))).toEqual(['LICENSING_UNRESOLVED']);
    expect(codes(validateProposedContent(content({ difficultyEstimate: 'advanced' }), FACTS))).toEqual(['DIFFICULTY_UNUSUAL']);
    expect(codes(validateProposedContent(content(), { ...FACTS, solutionProvided: false }))).toEqual(['SOLUTION_MISSING']);
    expect(codes(validateProposedContent(content(), { asOf: AS_OF, solutionProvided: true }))).toEqual(
      ['DISTRACTOR_ANALYSIS_MISSING', 'DISTRACTOR_ANALYSIS_MISSING', 'DISTRACTOR_ANALYSIS_MISSING'],
    );
  });

  it('defaults to no solution and no analysed distractors, as a stored draft with neither reports', () => {
    expect(codes(validateProposedContent(content(), { asOf: AS_OF }))).toEqual([
      'SOLUTION_MISSING',
      'DISTRACTOR_ANALYSIS_MISSING',
      'DISTRACTOR_ANALYSIS_MISSING',
      'DISTRACTOR_ANALYSIS_MISSING',
    ]);
  });

  it('numeric completeness: a comparison mode without the parameter it needs', () => {
    const report = validateProposedContent(
      content({ responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '9.81', comparisonMode: 'ABSOLUTE_TOLERANCE', acceptedForms: ['DECIMAL'] } } as never }),
      FACTS,
    );
    expect(codes(report)).toContain('NUMERIC_TOLERANCE_MISSING');
    expect(report.maySubmit).toBe(false);
  });

  it('renderability: notation that does not render on a surface blocks, naming where', () => {
    const unrenderable = mathBlock('\\wormhole');
    if (!unrenderable.ok) throw new Error('fixture');
    const report = validateProposedContent(content({ stem: unrenderable.value }), FACTS);
    expect(codes(report)).toEqual(['NOTATION_UNRENDERABLE', 'NOTATION_UNRENDERABLE', 'NOTATION_UNRENDERABLE', 'NOTATION_UNRENDERABLE']);
    expect(report.findings.map((finding) => finding.location)).toEqual(Array(4).fill('version.stem'));
    expect(report.maySubmit).toBe(false);
  });

  it('licensing is judged at the supplied instant, never a clock: a licence that has run out by then blocks', () => {
    const licensed = { status: 'licensed', licenseRef: 'CC-BY', attribution: 'x', expiresAt: '2026-01-01T00:00:00Z' } as const;
    expect(codes(validateProposedContent(content({ licensing: licensed }), { ...FACTS, asOf: '2026-12-01T00:00:00.000Z' }))).toEqual(['LICENSING_UNRESOLVED']);
    expect(validateProposedContent(content({ licensing: licensed }), { ...FACTS, asOf: '2025-12-01T00:00:00.000Z' }).findings).toEqual([]);
  });

  describe('structure: what the constructors refuse is a finding, never a raised error (D41)', () => {
    it('reports an item with no tags, naming where', () => {
      const report = validateProposedContent(content({ taxonomyTags: [] }), FACTS);
      expect(report.findings).toEqual([
        { code: 'STRUCTURE_INVALID', severity: 'blocking', message: expect.stringContaining('TAGS_REQUIRED') as unknown as string, location: 'version.taxonomyTags' },
      ]);
      expect(report.maySubmit).toBe(false);
      expect(report.warnings).toEqual([]);
    });

    it('reports a specification with no options — the very case that raised', () => {
      const report = validateProposedContent(content({ responseSpec: { itemType: 'SINGLE_CORRECT_MCQ' } as never }), FACTS);
      expect(codes(report)).toEqual(['STRUCTURE_INVALID']);
      expect(report.findings[0]?.message).toContain('RESPONSE_SPEC_MALFORMED');
      expect(report.findings[0]?.location).toBe('version.responseSpec.options');
    });

    it('reports a stem that is not a body, and a stem body that is not a valid one, with the failure’s own place', () => {
      expect(validateProposedContent(content({ stem: undefined as never }), FACTS).findings[0]).toMatchObject({ code: 'STRUCTURE_INVALID', location: 'version.stem' });
      const invalid = validateProposedContent(content({ stem: { schemaVersion: 1, blocks: [{ kind: 'PARAGRAPH', inlines: [] }] } as never }), FACTS);
      expect(invalid.findings[0]?.message).toContain('PARAGRAPH_EMPTY');
      expect(invalid.findings[0]?.location).toBe('version.stem.blocks[0]');
      const noBlocks = validateProposedContent(content({ stem: { schemaVersion: 1 } as never }), FACTS);
      expect(noBlocks.findings[0]?.location).toBe('version.stem.blocks');
    });

    it('reports a bad option body, naming the option', () => {
      const spec = singleCorrectSpec({ correctOptionId: 'a', options: FOUR_OPTIONS.map((option) => (option.optionId === 'c' ? { ...option, body: { blocks: 'nope' } as never } : option)) });
      const report = validateProposedContent(content({ responseSpec: spec }), FACTS);
      expect(report.findings.map((finding) => [finding.code, finding.location])).toEqual([['STRUCTURE_INVALID', 'version.responseSpec.options[2].body.blocks']]);
    });

    it('reports an option with no body at all', () => {
      const spec = singleCorrectSpec({ correctOptionId: 'a', options: FOUR_OPTIONS.map((option) => (option.optionId === 'd' ? ({ optionId: 'd', ordinal: 4 } as never) : option)) });
      expect(validateProposedContent(content({ responseSpec: spec }), FACTS).findings[0]?.location).toBe('version.responseSpec.options[3].body');
    });

    it('reports every structural problem at once, not the first', () => {
      const report = validateProposedContent(content({ stem: undefined as never, taxonomyTags: [] }), FACTS);
      expect(report.findings.map((finding) => finding.location)).toEqual(['version.stem', 'version.taxonomyTags']);
    });

    it('reports a proposal that is not an object at all, and a matching item’s member bodies', () => {
      for (const nothing of [null, undefined, 'a proposal', 7, []]) {
        expect(validateProposedContent(nothing as never, FACTS).maySubmit).toBe(false);
      }
      const member = (id: string, n: number, body: unknown) => ({ memberId: id, ordinal: n, body });
      const matching = {
        itemType: 'MATCHING',
        left: [member('l1', 1, textBody('l1')), member('l2', 2, { blocks: 3 })],
        right: [member('r1', 1, textBody('r1')), member('r2', 2, textBody('r2'))],
        pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }],
      };
      expect(validateProposedContent(content({ responseSpec: matching as never }), FACTS).findings[0]?.location).toBe('version.responseSpec.left[1].body.blocks');
    });
  });

  describe('total — it returns a report for any single-point malformation of a sound proposal', () => {
    const document = JSON.parse(JSON.stringify(content()));

    it('and never raises, over every position in every way', () => {
      const result = sweep(document, (mutated) => {
        const report = validateProposedContent(mutated as never, FACTS);
        expect(Array.isArray(report.findings)).toBe(true);
        expect(typeof report.maySubmit).toBe('boolean');
      });
      expect(result.tried).toBeGreaterThan(200);
      expect(result.raised.map((entry) => `${entry.path} (${entry.how}): ${entry.message}`)).toEqual([]);
    });

    it('and a malformed proposal is never reported submittable merely because the malformed part was ignored', () => {
      const submittable: string[] = [];
      sweep(document, (mutated) => {
        const report = validateProposedContent(mutated as never, FACTS);
        const structuralOnly = report.findings.some((finding) => finding.code === 'STRUCTURE_INVALID');
        if (report.maySubmit && structuralOnly) submittable.push('STRUCTURE_INVALID yet submittable');
      });
      expect(submittable).toEqual([]);
    });
  });
});

describe('it is pure', () => {
  const source = readFileSync(fileURLToPath(new URL('./proposal-validation.ts', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bperformance\.now\b|\bcrypto\b/u);
  });

  it('takes no repository, port or infrastructure, and has nothing to save through', () => {
    expect(source).not.toMatch(/repository|\/infrastructure\/|\/ports\.js|\bsave\(|\bawait\b|\basync\b/iu);
  });
});
