/**
 * The token layer (§9 rule 16 / F24): every colour the Learn shell emits names a custom property, and no component carries a literal
 * colour — `frontend-rules.ts` scans for it. The values live in the host stylesheet; this module fixes the names.
 *
 * Calm by design (ASSESSMENT-ENGINE §7, UX): there is no alarm colour for being offline. The sync indicator uses the same muted and
 * raised surfaces as the rest of the shell, and the timer changes only when little time is left.
 */
export const TOKENS = Object.freeze({
  textPrimary: 'var(--qb-color-text-primary)',
  textMuted: 'var(--qb-color-text-muted)',
  surface: 'var(--qb-color-surface)',
  surfaceRaised: 'var(--qb-color-surface-raised)',
  borderSubtle: 'var(--qb-color-border-subtle)',
  accent: 'var(--qb-color-accent)',
  feedbackWarning: 'var(--qb-color-feedback-warning)',
  spaceSmall: 'var(--qb-space-100)',
  spaceMedium: 'var(--qb-space-200)',
});
