/**
 * Which surface a document is being drawn for.
 *
 * **A parameter, not four components** — that is what makes INV-14's
 * byte-for-byte claim provable rather than aspirational. Four components would
 * have four render trees to keep in step, and the divergence would be
 * invisible until a student saw something the author never previewed.
 *
 * The profile changes layout affordances only: which width the container
 * assumes, whether an overflowing expression scrolls or wraps. **It never
 * changes what a node means**, so the serialized output for one profile is a
 * function of the document alone (M3-38 asserts the parity).
 */
export const SURFACE_PROFILES = ['web', 'mobile', 'offline', 'print'] as const;
export type SurfaceProfile = (typeof SURFACE_PROFILES)[number];

/**
 * The minimum device profile (FR-QM-14 rule 3, UX §10.1). Preview defaults
 * here rather than to desktop: an item that breaks does so on the smallest
 * screen, and previewing at desktop width is how that goes unnoticed until a
 * learner meets it.
 */
export const MINIMUM_DEVICE_PROFILE: SurfaceProfile = 'mobile';

/** The nominal width each profile lays out for, in CSS pixels. */
export const PROFILE_WIDTH: Readonly<Record<SurfaceProfile, number>> = Object.freeze({
  web: 1280,
  mobile: 360,
  offline: 360,
  print: 794,
});

export function isSurfaceProfile(value: string): value is SurfaceProfile {
  return (SURFACE_PROFILES as readonly string[]).includes(value);
}
