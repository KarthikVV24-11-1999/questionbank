import type { ScreenAnalytics } from '../analytics/emitter.js';

/**
 * What the host tells a screen about where it was opened: the attempt this device last sat, a key that is the same for every try of one tap on this page, and where it says that something
 * happened. The exam profile and the taxonomy used to be here as well, read off the address; they are the learner's own and come from their profile now (`home/exam-pins.ts`, D88).
 */
export interface ScreenContext {
  readonly lastAttemptId: string | null;
  /** Fixed for the life of the page, so a tap retried on it makes one run. */
  readonly pageKey: string;
  /** Where a screen says that something happened (M7-62). It cannot fail a render or a request. */
  readonly analytics: ScreenAnalytics;
}

/** Which screen an address opens, and what it needs to know to open it. */
export type Screen =
  | { readonly practice: string }
  | { readonly report: string }
  | { readonly onboarding: true | 'coverage' }
  | { readonly map: true }
  | { readonly topic: string; readonly from?: number }
  | Record<string, never>;

/** The address of a screen. It carries which screen and which thing, and nothing about the learner: who they are and what they chose are read from the server. */
export function screenHref(screen: Screen): string {
  const params = new URLSearchParams();
  if ('practice' in screen) params.set('practice', screen.practice);
  if ('report' in screen) params.set('report', screen.report);
  if ('onboarding' in screen) params.set('onboarding', screen.onboarding === true ? '1' : screen.onboarding);
  if ('map' in screen) params.set('map', '1');
  if ('topic' in screen) {
    params.set('topic', screen.topic);
    if (screen.from !== undefined && screen.from > 0) params.set('from', String(screen.from));
  }
  const query = params.toString();
  return query === '' ? '?' : `?${query}`;
}
