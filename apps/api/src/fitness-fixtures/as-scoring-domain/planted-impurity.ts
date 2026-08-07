/**
 * A planted F45 violation. Not production code — `checkScoringPurity` is run
 * against this directory to prove the check fails when it should, rather than
 * only that it passes on a tree that happens to be clean.
 */
export function scoredAt(): string {
  return new Date().toISOString();
}

export function jitter(): number {
  return Math.random();
}

export function tuning(): string | undefined {
  return process.env['SCORING_TUNING'];
}
