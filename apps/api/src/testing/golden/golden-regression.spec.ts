import { describe, expect, it } from 'vitest';
import { rationalToDecimalString } from '../../contexts/scoring/domain/numeric/decimal.js';
import {
  GoldenPaperError,
  loadGoldenPapers,
  provenanceCounts,
  validateGoldenPaper,
  type GoldenPaper,
} from './format.js';
import { canonicalise, scoreGoldenPaper, totalOf } from './score-golden-paper.js';

/**
 * The blocking golden-set regression (F9, handbook §5). Runs in the default
 * test command — not behind a flag, not a separate script.
 *
 * Read `README.md` for what this proves and what it does not. In short:
 * self-consistency and freedom from regression, yes; agreement with a real
 * answer key, only once official papers exist (DEC-2).
 */
const papers = loadGoldenPapers();
const counts = provenanceCounts(papers);

describe('golden-set corpus', () => {
  it('reports what it ran, so a synthetic-only run cannot pass for a validated one', () => {
    // Printed rather than merely asserted: the count is the honest headline.
    // eslint-disable-next-line no-console
    console.log(`golden set: ${counts.official} official paper(s), ${counts.synthetic} synthetic`);
    expect(counts.official + counts.synthetic).toBe(papers.length);
  });

  it('has fixtures to run at all', () => {
    expect(papers.length).toBeGreaterThan(0);
  });

  it('states plainly that the real-paper gate is not yet met (DEC-2)', () => {
    // This is the milestone's failed-blocked item, asserted rather than
    // remembered. When three official papers land it flips, and the DoD with it.
    expect(counts.official).toBeLessThan(3);
  });
});

describe.each(papers)('$paper.paperId', ({ paper, filename }) => {
  const record = scoreGoldenPaper(paper);

  it(`is labelled ${paper.provenance}`, () => {
    if (paper.provenance === 'synthetic') {
      expect(filename).toContain('synthetic');
      expect(paper.paperId).toContain('synthetic');
    } else {
      expect(paper.source?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('scores to the expected total', () => {
    expect(totalOf(record)).toBe(paper.expectedTotal);
  });

  it('scores every section to its expected raw', () => {
    for (const section of paper.sections) {
      const scored = record.sectionScores.find((entry) => entry.sectionOrdinal === section.ordinal);
      expect(rationalToDecimalString(scored?.raw ?? { num: 0n, den: 1n }), `section ${section.ordinal}`).toBe(
        section.expectedRaw,
      );
    }
  });

  it('scores every item to its expected marks', () => {
    for (const section of paper.sections) {
      for (const slot of section.slots) {
        // A discarded slot has no surviving outcome; bestOf is asserted by the
        // section total instead.
        if (slot.expectedCorrectness === 'discarded') continue;
        const outcome = record.itemOutcomes.find((entry) => entry.slotId === slot.slotId);
        expect(outcome, `${paper.paperId} slot ${slot.slotId}`).toBeDefined();
        expect(
          rationalToDecimalString(outcome?.marksAwarded ?? { num: 0n, den: 1n }),
          `${paper.paperId} slot ${slot.slotId}`,
        ).toBe(slot.expectedMarks);
      }
    }
  });

  it('records the expected correctness for every item', () => {
    for (const section of paper.sections) {
      for (const slot of section.slots) {
        if (slot.expectedCorrectness === 'discarded') continue;
        const outcome = record.itemOutcomes.find((entry) => entry.slotId === slot.slotId);
        expect(outcome?.correctness, `${paper.paperId} slot ${slot.slotId}`).toBe(slot.expectedCorrectness);
      }
    }
  });

  it('attributes every outcome to a rule (F47)', () => {
    for (const outcome of record.itemOutcomes) {
      expect(outcome.ruleApplied.ruleId.length, outcome.slotId).toBeGreaterThan(0);
    }
  });
});

describe('the suite fails on a planted regression', () => {
  it('catches a single altered mark', () => {
    const original = papers[0]?.paper as GoldenPaper;
    const altered: GoldenPaper = {
      ...original,
      expectedTotal: String(Number(original.expectedTotal) + 1),
    };
    // Exactly the assertion the per-paper suite makes above.
    expect(totalOf(scoreGoldenPaper(altered))).not.toBe(altered.expectedTotal);
  });
});

describe('the loader refuses a fixture it cannot trust', () => {
  const base = papers[0]?.paper as GoldenPaper;

  const cases: readonly [string, GoldenPaper, string][] = [
    ['a blank paperId', { ...base, paperId: '  ' }, 'PAPER_ID_REQUIRED'],
    ['an unknown provenance', { ...base, provenance: 'vibes' as never }, 'PROVENANCE_UNKNOWN'],
    [
      'a synthetic fixture not labelled as one',
      { ...base, paperId: 'jee-main-2026-session-1' },
      'SYNTHETIC_NOT_LABELLED',
    ],
    ['an official paper with no source', { ...base, provenance: 'official' }, 'OFFICIAL_WITHOUT_SOURCE'],
    ['no sections', { ...base, sections: [] }, 'SECTIONS_REQUIRED'],
    [
      'a section with no slots',
      { ...base, sections: [{ ordinal: 1, slots: [], expectedRaw: '0' }] },
      'SLOTS_REQUIRED',
    ],
    [
      'a total that disagrees with its sections',
      { ...base, expectedTotal: '999' },
      'PAPER_TOTAL_INCONSISTENT',
    ],
  ];

  for (const [label, paper, code] of cases) {
    it(`rejects ${label}`, () => {
      try {
        validateGoldenPaper(paper, 'synthetic-probe.json');
        expect.unreachable(`${label} should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(GoldenPaperError);
        expect((error as GoldenPaperError).code).toBe(code);
      }
    });
  }

  it('rejects a section whose slots do not sum to its stated raw', () => {
    const inconsistent: GoldenPaper = {
      ...base,
      sections: base.sections.map((section, index) =>
        index === 0 ? { ...section, expectedRaw: '999' } : section,
      ),
      expectedTotal: base.expectedTotal,
    };
    try {
      validateGoldenPaper(inconsistent, 'synthetic-probe.json');
      expect.unreachable('an inconsistent section should have been rejected');
    } catch (error) {
      expect((error as GoldenPaperError).code).toBe('SECTION_TOTAL_INCONSISTENT');
    }
  });

  it('rejects a slot that states no expected marks', () => {
    const firstSection = base.sections[0] as GoldenPaper['sections'][number];
    const firstSlot = firstSection.slots[0] as GoldenPaper['sections'][number]['slots'][number];
    const missing: GoldenPaper = {
      ...base,
      sections: [{ ...firstSection, slots: [{ ...firstSlot, expectedMarks: '  ' }] }],
    };
    try {
      validateGoldenPaper(missing, 'synthetic-probe.json');
      expect.unreachable('a slot with no expected marks should have been rejected');
    } catch (error) {
      expect((error as GoldenPaperError).code).toBe('EXPECTED_MARKS_MISSING');
    }
  });
});

describe('determinism (REL-03)', () => {
  it('produces byte-identical records across 1,000 runs', () => {
    const paper = papers[0]?.paper as GoldenPaper;
    const reference = canonicalise(scoreGoldenPaper(paper));
    for (let run = 0; run < 1000; run += 1) {
      expect(canonicalise(scoreGoldenPaper(paper)), `run ${run}`).toBe(reference);
    }
  });

  it('is byte-identical for every paper in the corpus', () => {
    for (const { paper } of papers) {
      const first = canonicalise(scoreGoldenPaper(paper));
      const second = canonicalise(scoreGoldenPaper(paper));
      expect(second, paper.paperId).toBe(first);
    }
  });

  it('does not depend on the order slots arrive in', () => {
    const paper = papers[0]?.paper as GoldenPaper;
    const reference = scoreGoldenPaper(paper);
    const reversed: GoldenPaper = {
      ...paper,
      sections: paper.sections.map((section) => ({ ...section, slots: [...section.slots].reverse() })),
    };
    // Slot ordinals must stay contiguous, so re-number after reversing.
    const renumbered: GoldenPaper = {
      ...reversed,
      sections: reversed.sections.map((section) => ({
        ...section,
        slots: section.slots.map((slot, index) => ({ ...slot, ordinal: index + 1 })),
      })),
    };
    expect(totalOf(scoreGoldenPaper(renumbered))).toBe(totalOf(reference));
  });
});
