/**
 * Planted violation for `learning-rules.spec.ts` — a file of Learning's reaching scoring by a specifier that is not a relative
 * path, which cannot be resolved to a file and so is matched on its text. Nothing publishes a context as a package today; this
 * is the shape the day something does. Written as a `require` the type-checker does not resolve, as the other planted
 * specifiers are.
 *
 * Never imported by production code.
 */
export function readsScoringByPackageName(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@questionbank/api/contexts/scoring/domain/score-record.js');
}
