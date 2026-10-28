import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The code a context layer holds (DEC-M7-26): TypeScript that is not a spec. A directory is a layer when this is
 * non-empty; `.gitkeep` is a promise that a layer will exist, and `existsSync` cannot tell the two apart.
 */
export function sourceFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}
