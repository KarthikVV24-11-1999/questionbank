/** Planted: a route handler recognising a caller itself. */
export function whoIs(headers: Record<string, string | undefined>): string | null {
  const raw = headers['authorization'];
  return raw?.startsWith('Bearer ') === true ? raw.slice(7) : null;
}
