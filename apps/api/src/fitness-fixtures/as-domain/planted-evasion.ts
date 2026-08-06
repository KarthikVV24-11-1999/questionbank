/**
 * A domain module trying to reach infrastructure by routes a naive scanner
 * misses: a dynamic import and a require. The boundary spec cruises this
 * directory as if it were the domain layer, so both must be caught.
 */
export async function smuggledByDynamicImport(): Promise<unknown> {
  return import('../../contexts/curriculum/infrastructure/schema.js');
}

export function smuggledByRequire(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('drizzle-orm');
}
