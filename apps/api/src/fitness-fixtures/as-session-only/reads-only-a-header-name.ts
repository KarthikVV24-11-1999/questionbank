/** Planted: a route handler reading the header by name and nothing else. */
export const raw = (headers: Record<string, string | undefined>): string | undefined => headers['authorization'];
