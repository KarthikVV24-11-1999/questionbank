/**
 * The token layer (§9 rule 16 / F24). Every colour, spacing and type value the
 * renderer emits names a custom property; **no literal colour appears in any
 * component**, and a source scan asserts it.
 *
 * The values themselves live in the host application's theme. What this module
 * fixes is the *names*, so a component cannot invent one that nothing defines.
 */
export const TOKENS = Object.freeze({
  textPrimary: 'var(--qb-color-text-primary)',
  textMuted: 'var(--qb-color-text-muted)',
  surfaceRaised: 'var(--qb-color-surface-raised)',
  borderSubtle: 'var(--qb-color-border-subtle)',
  feedbackWarning: 'var(--qb-color-feedback-warning)',
  spaceSmall: 'var(--qb-space-100)',
  spaceMedium: 'var(--qb-space-200)',
});
