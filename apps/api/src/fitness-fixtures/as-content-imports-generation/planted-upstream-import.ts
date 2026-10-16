/**
 * Planted violation for `generation-rules.spec.ts` — an upstream context
 * reaching into `contexts/generation/`, which ADR-0025 forbids in that
 * direction. The spec cruises this directory as if it were content's.
 *
 * Both forms are planted because both are how it would actually happen: a
 * barrel import that looks entirely legitimate under F1, and a `require` that
 * a naive scanner misses. Neither path exists yet — `contexts/generation/`
 * has not been built — so both are written as specifiers the type-checker
 * does not resolve. What the rule reads is the import text, which is exactly
 * what it would read on the day the context lands.
 *
 * Never imported by production code.
 */
export function smuggledByBarrelImport(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../contexts/generation/public/index.js');
}

export function smuggledByDeepRequire(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../contexts/generation/domain/generation-candidate.js');
}
