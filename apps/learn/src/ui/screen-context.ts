import type { ScreenAnalytics } from '../analytics/emitter.js';

/**
 * What the host tells a screen about where it was opened (D88): the exam profile a practice run is made under, the taxonomy "weakest" is asked about, the
 * attempt this device last sat, and a key that is the same for every try of one tap on this page. All of it arrives as identifiers; the screens name a
 * concept by its identifier because no route offers a learner the name.
 */
export interface ScreenContext {
  readonly examProfileVersionId: string | null;
  readonly taxonomyVersionId: string | null;
  readonly lastAttemptId: string | null;
  /** Fixed for the life of the page, so a tap retried on it makes one run. */
  readonly pageKey: string;
  /** Where a screen says that something happened (M7-62). It cannot fail a render or a request. */
  readonly analytics: ScreenAnalytics;
}

/** The address of a screen, carrying the context on so the next screen is opened where this one was. */
export function screenHref(screen: { readonly practice: string } | { readonly report: string } | Record<string, never>, context: ScreenContext): string {
  const params = new URLSearchParams();
  if ('practice' in screen) params.set('practice', screen.practice);
  if ('report' in screen) params.set('report', screen.report);
  if (context.examProfileVersionId !== null) params.set('profile', context.examProfileVersionId);
  if (context.taxonomyVersionId !== null) params.set('taxonomy', context.taxonomyVersionId);
  const query = params.toString();
  return query === '' ? '?' : `?${query}`;
}

/** A concept as a person is shown it: by its identifier, shortened, until a route offers its name. */
export const conceptLabel = (conceptIdentityId: string): string => `Concept ${conceptIdentityId.slice(0, 8)}`;
