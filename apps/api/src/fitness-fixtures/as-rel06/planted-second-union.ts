/** A second implementation of set union by event id: the thing REL-06's one home exists to prevent. */
export function mergeLogs<T extends { readonly eventId: string }>(a: readonly T[], b: readonly T[]): readonly T[] {
  const byId = new Map<string, T>();
  for (const event of [...a, ...b]) byId.set(event.eventId, event);
  return [...byId.values()];
}
