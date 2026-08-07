import { compareRational, rationalToDecimalString, subtractRational, ZERO, type Rational } from './numeric/decimal.js';
import type { ScoreRecord } from './score-record.js';

/**
 * The impact preview a re-score cannot be executed without (DOMAIN-MODEL §7).
 *
 * The preview is built from records the **same executor** produced, never from
 * a separate estimate. A preview computed a different way is a second scoring
 * implementation wearing a different name, and the whole point of the dry-run
 * is that what the operator approves is what will happen.
 */

export interface ScoreDelta {
  readonly attemptId: string;
  readonly before: string;
  readonly after: string;
  readonly delta: string;
}

export interface ScoreDeltaDistribution {
  readonly improved: number;
  readonly worsened: number;
  readonly unchanged: number;
  readonly largestGain: string;
  readonly largestLoss: string;
}

export interface RankMovement {
  readonly movedUp: number;
  readonly movedDown: number;
  readonly unchanged: number;
}

export interface DryRunResult {
  readonly affectedAttemptCount: number;
  readonly scoreDeltaDistribution: ScoreDeltaDistribution;
  readonly rankMovement: RankMovement;
  /** Per-attempt deltas, so an operator can see who is affected and not only how many. */
  readonly deltas: readonly ScoreDelta[];
}

export interface RescoringPair {
  readonly before: ScoreRecord;
  readonly after: ScoreRecord;
}

/**
 * Rank 1 is the highest total, and tied totals share the better rank — the way
 * an exam board reports them.
 *
 * Computed as "how many scored strictly higher, plus one" rather than by
 * sorting and indexing. Ties fall out correctly without a special case, and
 * two entries for the same attempt cannot collide in a lookup table.
 */
function rankOf(total: Rational, all: readonly Rational[]): number {
  return all.filter((other) => compareRational(other, total) > 0).length + 1;
}

export function buildDryRunResult(pairs: readonly RescoringPair[]): DryRunResult {
  const deltas: ScoreDelta[] = [];
  let improved = 0;
  let worsened = 0;
  let unchanged = 0;
  let largestGain: Rational = ZERO;
  let largestLoss: Rational = ZERO;

  for (const pair of pairs) {
    const delta = subtractRational(pair.after.totalScore.raw, pair.before.totalScore.raw);
    const direction = compareRational(delta, ZERO);

    if (direction > 0) {
      improved += 1;
      if (compareRational(delta, largestGain) > 0) largestGain = delta;
    } else if (direction < 0) {
      worsened += 1;
      if (compareRational(delta, largestLoss) < 0) largestLoss = delta;
    } else {
      unchanged += 1;
    }

    deltas.push({
      attemptId: pair.before.attemptId,
      before: rationalToDecimalString(pair.before.totalScore.raw),
      after: rationalToDecimalString(pair.after.totalScore.raw),
      delta: rationalToDecimalString(delta),
    });
  }

  const beforeTotals = pairs.map((pair) => pair.before.totalScore.raw);
  const afterTotals = pairs.map((pair) => pair.after.totalScore.raw);

  let movedUp = 0;
  let movedDown = 0;
  let rankUnchanged = 0;
  for (const pair of pairs) {
    const from = rankOf(pair.before.totalScore.raw, beforeTotals);
    const to = rankOf(pair.after.totalScore.raw, afterTotals);
    if (to < from) movedUp += 1;
    else if (to > from) movedDown += 1;
    else rankUnchanged += 1;
  }

  return Object.freeze({
    affectedAttemptCount: pairs.length,
    scoreDeltaDistribution: Object.freeze({
      improved,
      worsened,
      unchanged,
      largestGain: rationalToDecimalString(largestGain),
      largestLoss: rationalToDecimalString(largestLoss),
    }),
    rankMovement: Object.freeze({ movedUp, movedDown, unchanged: rankUnchanged }),
    deltas: Object.freeze(deltas),
  });
}
