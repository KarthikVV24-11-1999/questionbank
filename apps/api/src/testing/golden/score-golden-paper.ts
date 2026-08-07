import { createAnswerKey } from '../../contexts/scoring/domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../../contexts/scoring/domain/aggregation-data.js';
import { createScoringInput, type CreateScoredSlot } from '../../contexts/scoring/domain/scoring-input.js';
import { parseRational, rationalToDecimalString } from '../../contexts/scoring/domain/numeric/decimal.js';
import { scoreAttemptAtPinnedVersion } from '../../contexts/scoring/domain/schema-version-registry.js';
import type { ScoreRecord } from '../../contexts/scoring/domain/score-record.js';
import type { GoldenPaper } from './format.js';

const HASH = 'golden-fixture-hash';

/** Turns a fixture into an attempt and scores it through the real executor. */
export function scoreGoldenPaper(paper: GoldenPaper, computedAt = '2026-08-07T00:00:00.000Z'): ScoreRecord {
  const sections = paper.sections.map((section) => ({
    ordinal: section.ordinal,
    slots: section.slots.map((slot): CreateScoredSlot => {
      const key = createAnswerKey(slot.answerKey);
      if (!key.ok) throw new Error(`${paper.paperId}: slot ${slot.slotId} has an invalid key: ${key.error.message}`);
      const marks = parseRational(String(slot.marksAvailable));
      if (!marks.ok) throw new Error(`${paper.paperId}: slot ${slot.slotId} has invalid marks`);

      return {
        slotId: slot.slotId,
        ordinal: slot.ordinal,
        itemType: slot.itemType,
        itemVersionId: `iv-${slot.slotId}`,
        marksAvailable: slot.marksAvailable,
        answerKey: key.value,
        ...(slot.response !== undefined ? { response: slot.response } : {}),
      };
    }),
  }));

  const input = createScoringInput({
    attemptId: `attempt-${paper.paperId}`,
    pin: {
      examProfileVersionId: `epv-${paper.paperId}`,
      markingRuleSetHash: HASH,
      ruleSchemaVersion: paper.ruleSet.schemaVersion,
      taxonomyVersionId: `tax-${paper.paperId}`,
      itemVersionIds: ['iv-1'],
    },
    sections,
    overrides: [],
  });
  if (!input.ok) throw new Error(`${paper.paperId}: ${input.error.code} — ${input.error.message}`);

  const scored = scoreAttemptAtPinnedVersion({
    input: input.value,
    ruleSet: paper.ruleSet,
    ruleSetHash: HASH,
    aggregation: paper.aggregation ?? DEFAULT_AGGREGATION,
    computedAt,
    scoreRecordId: `sr-${paper.paperId}`,
  });
  if (!scored.ok) throw new Error(`${paper.paperId}: ${scored.error.code} — ${scored.error.message}`);

  return scored.value;
}

/** A canonical rendering, for byte-identity comparison across runs (REL-03). */
export function canonicalise(record: ScoreRecord): string {
  return JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : (value as unknown),
  );
}

export function totalOf(record: ScoreRecord): string {
  return rationalToDecimalString(record.totalScore.raw);
}
