import { describe, expect, it } from 'vitest';
import {
  BLOCKING_PRECHECKS,
  PRECHECKS,
  PRECHECK_COUNT,
  PRECHECK_IDS,
  PRECHECK_SEVERITIES,
  isPrecheckId,
  precheckSeverity,
  type PrecheckId,
} from './precheck-vocabulary.js';

/**
 * The document's table, transcribed once, by name. Asserting the vocabulary
 * equals this — rather than looping the vocabulary and checking each entry
 * against itself — is what notices the list getting shorter, longer or
 * reclassified.
 */
const SECTION_11: Readonly<Record<string, 'blocking' | 'advisory'>> = {
  schema_validity: 'blocking', // 1
  renderability: 'blocking', // 2
  answer_verification: 'blocking', // 3
  numeric_spec_completeness: 'blocking', // 4
  syllabus_scope: 'blocking', // 5
  item_solution_key_consistency: 'blocking', // 6
  distractor_validity: 'blocking', // 7
  duplicate_detection: 'advisory', // 8
  difficulty_plausibility: 'advisory', // 9
  ambiguity_clarity: 'advisory', // 10
  safety_appropriateness: 'blocking', // 11
  provenance_licensing_completeness: 'blocking', // 12
};

describe('the pre-check vocabulary', () => {
  it('is exactly the twelve checks of the document, split blocking/advisory check by check', () => {
    expect(Object.fromEntries(PRECHECKS.map((check) => [check.id, check.severity]))).toEqual(SECTION_11);
    expect(PRECHECKS).toHaveLength(12);
    expect(PRECHECK_COUNT).toBe(12);
  });

  it('numbers its checks one to twelve in the document’s order', () => {
    expect(PRECHECKS.map((check) => check.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('marks exactly checks 8, 9 and 10 as advisory', () => {
    expect(PRECHECKS.filter((check) => check.severity === 'advisory').map((check) => check.number)).toEqual([
      8, 9, 10,
    ]);
    expect([...PRECHECK_SEVERITIES]).toEqual(['blocking', 'advisory']);
  });

  it('keeps identifiers unique', () => {
    expect(new Set(PRECHECK_IDS).size).toBe(PRECHECK_IDS.length);
  });

  it('lists the nine blocking checks, and only those', () => {
    expect([...BLOCKING_PRECHECKS].sort()).toEqual(
      Object.entries(SECTION_11)
        .filter(([, severity]) => severity === 'blocking')
        .map(([id]) => id)
        .sort(),
    );
    expect(BLOCKING_PRECHECKS).toHaveLength(9);
  });

  it('recognises a check by its identifier and nothing else', () => {
    expect(isPrecheckId('answer_verification')).toBe(true);
    expect(isPrecheckId('Answer verification')).toBe(false);
    expect(isPrecheckId('grounding')).toBe(false);
    expect(isPrecheckId('')).toBe(false);
  });

  it('reports a check’s severity by identifier', () => {
    expect(precheckSeverity('duplicate_detection')).toBe('advisory');
    expect(precheckSeverity('safety_appropriateness')).toBe('blocking');
  });

  it('is closed at the type level: an identifier outside the list does not compile', () => {
    // @ts-expect-error — a thirteenth, unlisted check is not a PrecheckId
    const unlisted: PrecheckId = 'plagiarism';
    expect(isPrecheckId(unlisted)).toBe(false);
  });
});
