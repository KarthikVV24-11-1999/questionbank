/**
 * The token layer (§9 rule 16 / F24). Every colour Studio's own components
 * emit names a custom property; **no literal colour appears in any
 * component**, and `frontend-rules.ts`'s scan asserts it.
 *
 * Mirrors `packages/content-renderer/src/tokens.ts`'s shape — **mirrored,
 * not imported**, on the same argument M3-01 records for `Result`: Studio and
 * the renderer are separate consumers of a design system, and importing one
 * app's token module from the other would make a theme change in either ripple
 * into a package that has nothing to do with it.
 *
 * The values themselves live in the host application's theme (a stylesheet
 * this milestone does not author). What this module fixes is the *names*, so
 * a component cannot invent one that nothing defines.
 */
export const TOKENS = Object.freeze({
  textPrimary: 'var(--qb-color-text-primary)',
  textMuted: 'var(--qb-color-text-muted)',
  surfaceRaised: 'var(--qb-color-surface-raised)',
  borderSubtle: 'var(--qb-color-border-subtle)',
  feedbackWarning: 'var(--qb-color-feedback-warning)',
  feedbackError: 'var(--qb-color-feedback-error)',
  spaceSmall: 'var(--qb-space-100)',
  spaceMedium: 'var(--qb-space-200)',
});
