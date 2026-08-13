/**
 * The Studio's destinations (FRONTEND §2), as a **typed data structure the
 * shell consumes** — not a router (DEC-5).
 *
 * There is no running application in this repository: no `main.tsx`, no Vite
 * dev server, no bootstrapping. Adding a router now would be M0's work
 * borrowed against a content milestone, for a second time. The route table is
 * data, so the shell is testable in jsdom and the router that eventually reads
 * it is a wiring change.
 *
 * **Every destination is listed, and the ones M3 has not built are `enabled:
 * false` rather than absent.** A navigation model that grows by *enabling* is
 * reviewable — the diff says "Review Queue is live now". One that grows by
 * *appearing* is not: nobody can tell a missing destination from a forgotten
 * one.
 */

export interface Destination {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** Whether this milestone ships the surface behind it. */
  readonly enabled: boolean;
  /** Why it is not yet reachable — shown to the user, not just to a reviewer. */
  readonly pendingReason?: string;
}

export const DESTINATIONS: readonly Destination[] = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', path: '/', enabled: false, pendingReason: 'Arrives with author metrics' },
  { id: 'authoring', label: 'Authoring', path: '/authoring', enabled: true },
  {
    id: 'review-queue',
    label: 'Review Queue',
    path: '/review',
    enabled: false,
    pendingReason: 'Arrives with the review workspace',
  },
  {
    id: 'content-health',
    label: 'Content Health',
    path: '/content-health',
    enabled: false,
    pendingReason: 'Arrives with content statistics',
  },
  { id: 'taxonomy', label: 'Taxonomy', path: '/taxonomy', enabled: true },
  { id: 'exams', label: 'Exams & Forms', path: '/exams', enabled: true },
  {
    id: 'ai-console',
    label: 'AI Console',
    path: '/ai',
    enabled: false,
    pendingReason: 'Arrives with AI generation',
  },
  {
    id: 'defects',
    label: 'Defects & Challenges',
    path: '/defects',
    enabled: false,
    pendingReason: 'Arrives with governance intake',
  },
  { id: 'users', label: 'Users', path: '/users', enabled: false, pendingReason: 'Arrives with administration' },
  { id: 'reports', label: 'Reports', path: '/reports', enabled: false, pendingReason: 'Arrives with reporting' },
  { id: 'audit', label: 'Audit', path: '/audit', enabled: false, pendingReason: 'Arrives with the audit reader' },
]);

/** The width below which the Studio refuses to render an authoring surface. */
export const MINIMUM_VIEWPORT_WIDTH = 1280;

export function destinationById(id: string): Destination | undefined {
  return DESTINATIONS.find((destination) => destination.id === id);
}

/** Case-insensitive substring match on the label, for the command palette. */
export function filterDestinations(query: string): readonly Destination[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return DESTINATIONS;
  return DESTINATIONS.filter((destination) => destination.label.toLowerCase().includes(needle));
}
