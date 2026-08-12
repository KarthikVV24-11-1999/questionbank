import { describe, expect, it } from 'vitest';
import { expectValue } from '../../../testing/expect-result.js';
import { itemVersionProps, numericSpec, PROVENANCE_CONTEXT } from '../../../testing/content-fixtures.js';
import { createItemVersion, type ItemVersion } from './item-version.js';
import {
  BLOCKING_CODES,
  describeDuplicateCheck,
  DUPLICATE_CHECK_STATES,
  isBlockingCode,
  isWarningCode,
  validateDraft,
  WARNING_CODES,
  type ValidationFacts,
} from './pre-submission-validation.js';

const NOW = '2026-08-10T09:00:00Z';

function version(overrides: Parameters<typeof itemVersionProps>[0] = {}): ItemVersion {
  return expectValue(createItemVersion(itemVersionProps(overrides), PROVENANCE_CONTEXT));
}

/** A clean draft: everything satisfied, nothing to report. */
function facts(overrides: Partial<ValidationFacts> = {}): ValidationFacts {
  return {
    answerSpecificationAccepted: true,
    solutionExists: true,
    analysedDistractorOptionIds: ['a', 'c', 'd'],
    renderFailures: [],
    outOfScopeConceptIds: [],
    duplicateCheckState: 'not_evaluated',
    asOf: NOW,
    ...overrides,
  };
}

function codes(report: ReturnType<typeof validateDraft>): readonly string[] {
  return report.findings.map((finding) => finding.code);
}

describe('the code sets are disjoint and exhaustive', () => {
  // A code that is neither blocking nor warning is one the submit gate does
  // not know how to treat, and "unknown means blocking" surprises an author
  // with a refusal nobody can explain.
  it('shares no code between blocking and warning', () => {
    for (const code of BLOCKING_CODES) expect(isWarningCode(code)).toBe(false);
    for (const code of WARNING_CODES) expect(isBlockingCode(code)).toBe(false);
  });

  it('classifies every code it emits as exactly one of the two', () => {
    const emitted = codes(
      validateDraft(
        version({ licensing: { status: 'unresolved' }, difficultyEstimate: 'advanced' }),
        facts({
          answerSpecificationAccepted: false,
          solutionExists: false,
          analysedDistractorOptionIds: [],
          renderFailures: ['print: overflows'],
          outOfScopeConceptIds: ['concept-thermo'],
          duplicateCheckState: 'candidates_found',
        }),
      ),
    );
    for (const code of emitted) {
      expect(isBlockingCode(code) !== isWarningCode(code)).toBe(true);
    }
  });

  it('names FR-TCH-07 rule 1’s six blocking cases', () => {
    expect([...BLOCKING_CODES]).toEqual([
      'ANSWER_KEY_MISSING',
      'NUMERIC_TOLERANCE_MISSING',
      'CONCEPT_TAG_MISSING',
      'LICENSING_UNRESOLVED',
      'NOTATION_UNRENDERABLE',
      'SOLUTION_MISSING',
    ]);
  });

  it('names FR-TCH-07 rule 2’s four warnings', () => {
    expect([...WARNING_CODES]).toEqual([
      'PROBABLE_DUPLICATE',
      'CONCEPT_OUT_OF_DECLARED_SCOPE',
      'DIFFICULTY_UNUSUAL',
      'DISTRACTOR_ANALYSIS_MISSING',
    ]);
  });

  it('rejects a code from neither set', () => {
    expect(isBlockingCode('SOMETHING_ELSE')).toBe(false);
    expect(isWarningCode('SOMETHING_ELSE')).toBe(false);
  });
});

describe('a clean draft', () => {
  it('reports nothing and may be submitted', () => {
    const report = validateDraft(version(), facts());
    expect(report.findings).toEqual([]);
    expect(report.maySubmit).toBe(true);
  });

  it('returns frozen collections', () => {
    const report = validateDraft(version(), facts());
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.findings)).toBe(true);
    expect(Object.isFrozen(report.blocking)).toBe(true);
    expect(Object.isFrozen(report.warnings)).toBe(true);
  });
});

describe('blocking findings (FR-TCH-07 rule 1)', () => {
  it('reports a key the executor does not accept', () => {
    expect(codes(validateDraft(version(), facts({ answerSpecificationAccepted: false })))).toContain(
      'ANSWER_KEY_MISSING',
    );
  });

  // FR-TCH-02 rule 3, called out separately from the key check so the author
  // is told which field to fill rather than that the key is bad.
  it.each([
    ['ABSOLUTE_TOLERANCE with no tolerance', { comparisonMode: 'ABSOLUTE_TOLERANCE' } as const],
    ['RELATIVE_TOLERANCE with no tolerance', { comparisonMode: 'RELATIVE_TOLERANCE' } as const],
    ['SIGNIFICANT_FIGURES with no figure count', { comparisonMode: 'SIGNIFICANT_FIGURES' } as const],
    ['RANGE with no bounds', { comparisonMode: 'RANGE' } as const],
    ['RANGE with only a lower bound', { comparisonMode: 'RANGE', rangeMin: '1' } as const],
    ['RANGE with only an upper bound', { comparisonMode: 'RANGE', rangeMax: '9' } as const],
  ])('reports a numeric item using %s', (_label, overrides) => {
    const numeric = version({
      itemType: 'NUMERIC',
      responseSpec: {
        itemType: 'NUMERIC',
        spec: { expectedValue: '1', acceptedForms: ['DECIMAL'], ...overrides },
      },
    });
    expect(codes(validateDraft(numeric, facts()))).toContain('NUMERIC_TOLERANCE_MISSING');
  });

  it('reports a blank tolerance as missing', () => {
    const numeric = version({
      itemType: 'NUMERIC',
      responseSpec: {
        itemType: 'NUMERIC',
        spec: {
          expectedValue: '1',
          comparisonMode: 'ABSOLUTE_TOLERANCE',
          toleranceValue: '  ',
          acceptedForms: ['DECIMAL'],
        },
      },
    });
    expect(codes(validateDraft(numeric, facts()))).toContain('NUMERIC_TOLERANCE_MISSING');
  });

  it('does not report a complete numeric item', () => {
    const numeric = version({ itemType: 'NUMERIC', responseSpec: numericSpec() });
    expect(codes(validateDraft(numeric, facts({ analysedDistractorOptionIds: [] })))).not.toContain(
      'NUMERIC_TOLERANCE_MISSING',
    );
  });

  it('does not report EXACT mode, which needs no parameter', () => {
    const numeric = version({
      itemType: 'NUMERIC',
      responseSpec: {
        itemType: 'NUMERIC',
        spec: { expectedValue: '1', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL'] },
      },
    });
    expect(codes(validateDraft(numeric, facts({ analysedDistractorOptionIds: [] })))).not.toContain(
      'NUMERIC_TOLERANCE_MISSING',
    );
  });

  it('does not report tolerance on a non-numeric item', () => {
    expect(codes(validateDraft(version(), facts()))).not.toContain('NUMERIC_TOLERANCE_MISSING');
  });

  it('reports an untagged item', () => {
    const untagged = { ...version(), taxonomyTags: [] } as ItemVersion;
    expect(codes(validateDraft(untagged, facts()))).toContain('CONCEPT_TAG_MISSING');
  });

  it('reports a tag set with no primary', () => {
    const base = version();
    const noPrimary = {
      ...base,
      taxonomyTags: [{ ...base.taxonomyTags[0]!, isPrimary: false }],
    } as ItemVersion;
    expect(codes(validateDraft(noPrimary, facts()))).toContain('CONCEPT_TAG_MISSING');
  });

  it('reports unresolved licensing', () => {
    expect(codes(validateDraft(version({ licensing: { status: 'unresolved' } }), facts()))).toContain(
      'LICENSING_UNRESOLVED',
    );
  });

  it('reports an expired licence', () => {
    const expired = version({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme',
        expiresAt: '2026-01-01T00:00:00Z',
      },
    });
    expect(codes(validateDraft(expired, facts()))).toContain('LICENSING_UNRESOLVED');
  });

  it('reports each render failure separately, carrying the renderer’s own message', () => {
    const report = validateDraft(
      version(),
      facts({ renderFailures: ['print: blocks[0] overflows', 'mobile: blocks[2] clipped'] }),
    );
    const rendering = report.blocking.filter((finding) => finding.code === 'NOTATION_UNRENDERABLE');
    expect(rendering).toHaveLength(2);
    expect(rendering[0]?.message).toContain('print: blocks[0] overflows');
  });

  it('reports a missing solution', () => {
    expect(codes(validateDraft(version(), facts({ solutionExists: false })))).toContain('SOLUTION_MISSING');
  });

  it('refuses submission while any blocking finding remains (rule 3)', () => {
    expect(validateDraft(version(), facts({ solutionExists: false })).maySubmit).toBe(false);
  });
});

describe('warnings never block (FR-TCH-07 rule 2)', () => {
  it('permits submission with only warnings', () => {
    const report = validateDraft(
      version({ difficultyEstimate: 'advanced' }),
      facts({ outOfScopeConceptIds: ['concept-thermo'], duplicateCheckState: 'candidates_found' }),
    );
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.blocking).toEqual([]);
    expect(report.maySubmit).toBe(true);
  });

  // Advisory, never automatically blocking — genuine variants are legitimate
  // and valuable (FR-QM-04 rule 2).
  it('warns about a probable duplicate rather than refusing', () => {
    const report = validateDraft(version(), facts({ duplicateCheckState: 'candidates_found' }));
    expect(codes(report)).toContain('PROBABLE_DUPLICATE');
    expect(report.maySubmit).toBe(true);
  });

  it('warns per out-of-scope concept', () => {
    const report = validateDraft(
      version(),
      facts({ outOfScopeConceptIds: ['concept-thermo', 'concept-optics'] }),
    );
    expect(report.warnings.filter((f) => f.code === 'CONCEPT_OUT_OF_DECLARED_SCOPE')).toHaveLength(2);
  });

  it('warns about an unusual difficulty estimate', () => {
    expect(codes(validateDraft(version({ difficultyEstimate: 'advanced' }), facts()))).toContain(
      'DIFFICULTY_UNUSUAL',
    );
  });

  it('does not warn about an ordinary difficulty estimate', () => {
    expect(codes(validateDraft(version({ difficultyEstimate: 'moderate' }), facts()))).not.toContain(
      'DIFFICULTY_UNUSUAL',
    );
  });

  // Prompted now, while the author still has the item in their head
  // (UX §10.1).
  it('warns per incorrect option with no distractor analysis', () => {
    const report = validateDraft(version(), facts({ analysedDistractorOptionIds: ['a'] }));
    const missing = report.warnings.filter((f) => f.code === 'DISTRACTOR_ANALYSIS_MISSING');
    expect(missing).toHaveLength(2);
    expect(missing.map((f) => f.location)).toEqual([
      'version.responseSpec.options[c]',
      'version.responseSpec.options[d]',
    ]);
  });

  it('does not warn when every distractor is analysed', () => {
    expect(codes(validateDraft(version(), facts()))).not.toContain('DISTRACTOR_ANALYSIS_MISSING');
  });

  it('does not warn about distractors on a numeric item, which has none', () => {
    const numeric = version({ itemType: 'NUMERIC', responseSpec: numericSpec() });
    expect(codes(validateDraft(numeric, facts({ analysedDistractorOptionIds: [] })))).not.toContain(
      'DISTRACTOR_ANALYSIS_MISSING',
    );
  });
});

describe('every finding names where the problem is', () => {
  // "Invalid item" is a message an author cannot act on.
  it('carries a non-empty code, message and location on every finding', () => {
    const report = validateDraft(
      version({ licensing: { status: 'unresolved' }, difficultyEstimate: 'advanced' }),
      facts({
        answerSpecificationAccepted: false,
        solutionExists: false,
        analysedDistractorOptionIds: [],
        renderFailures: ['print: overflows'],
        outOfScopeConceptIds: ['concept-thermo'],
        duplicateCheckState: 'candidates_found',
      }),
    );
    expect(report.findings.length).toBeGreaterThan(5);
    for (const finding of report.findings) {
      expect(finding.location.length).toBeGreaterThan(0);
      expect(finding.message.length).toBeGreaterThan(0);
      expect(finding.severity === 'blocking' || finding.severity === 'warning').toBe(true);
    }
  });

  it('reports everything at once rather than stopping at the first', () => {
    const report = validateDraft(
      version({ licensing: { status: 'unresolved' } }),
      facts({ answerSpecificationAccepted: false, solutionExists: false }),
    );
    expect([...codes(report)].sort()).toEqual(
      ['ANSWER_KEY_MISSING', 'LICENSING_UNRESOLVED', 'SOLUTION_MISSING'].sort(),
    );
  });
});

describe('duplicate detection is M4’s, and the report says so', () => {
  it('names all three states', () => {
    expect([...DUPLICATE_CHECK_STATES]).toEqual(['not_evaluated', 'none_found', 'candidates_found']);
  });

  it('carries the state through to the report', () => {
    for (const duplicateCheckState of DUPLICATE_CHECK_STATES) {
      expect(validateDraft(version(), facts({ duplicateCheckState })).duplicateCheckState).toBe(
        duplicateCheckState,
      );
    }
  });

  // A report claiming no duplicates when the check never ran is a lie a
  // reviewer will act on.
  it('says the check has not run rather than that none were found', () => {
    const described = describeDuplicateCheck('not_evaluated');
    expect(described).toContain('has not run');
    expect(described).not.toMatch(/no probable duplicates/u);
  });

  it('distinguishes none-found from not-evaluated', () => {
    expect(describeDuplicateCheck('none_found')).toContain('no probable duplicates');
  });

  it('describes candidates found', () => {
    expect(describeDuplicateCheck('candidates_found')).toContain('review before submitting');
  });

  it('emits no duplicate warning while the check has not run', () => {
    expect(codes(validateDraft(version(), facts({ duplicateCheckState: 'not_evaluated' })))).not.toContain(
      'PROBABLE_DUPLICATE',
    );
  });

  it('emits no duplicate warning when none were found', () => {
    expect(codes(validateDraft(version(), facts({ duplicateCheckState: 'none_found' })))).not.toContain(
      'PROBABLE_DUPLICATE',
    );
  });
});

describe('the check is pure and continuous', () => {
  // It runs on every edit, so it has to be cheap, repeatable and free of
  // side effects.
  it('yields identical findings on repeated runs', () => {
    const draft = version({ licensing: { status: 'unresolved' } });
    const first = JSON.stringify(validateDraft(draft, facts()));
    for (let run = 0; run < 50; run += 1) {
      expect(JSON.stringify(validateDraft(draft, facts()))).toBe(first);
    }
  });

  it('mutates neither the draft nor the facts', () => {
    const draft = version();
    const supplied = facts();
    const draftBefore = JSON.stringify(draft);
    const factsBefore = JSON.stringify(supplied);
    validateDraft(draft, supplied);
    expect(JSON.stringify(draft)).toBe(draftBefore);
    expect(JSON.stringify(supplied)).toBe(factsBefore);
  });

  it('reads the instant from the supplied facts, never a clock', () => {
    const expiring = version({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme',
        expiresAt: '2026-08-10T09:00:00Z',
      },
    });
    expect(validateDraft(expiring, facts({ asOf: '2026-08-10T08:59:59Z' })).maySubmit).toBe(true);
    expect(validateDraft(expiring, facts({ asOf: NOW })).maySubmit).toBe(false);
  });
});
