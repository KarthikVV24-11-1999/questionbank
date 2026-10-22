/** The same copy under another name: caught by what it does, not by what it is called. */
export function combine<T extends { readonly eventId: string }>(left: readonly T[], right: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((event) => (seen.has(event.eventId) ? false : (seen.add(event.eventId), true)));
}
