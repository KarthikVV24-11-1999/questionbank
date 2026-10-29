import { readFileSync } from 'node:fs';

/**
 * Reads the event catalog out of docs/EVENT-TAXONOMY.md §3, the way `policy-declarations.ts` reads policy declarations out of source: the document is the
 * source of truth, and anything that has to agree with it is held to it by a test that parses the document at test time.
 *
 * The catalog writes related events on one row ("`a.b_started` / `_completed` / `_failed`"). A token that begins with an underscore replaces the last word of
 * the row's first name; a token that is a whole name stands as it is.
 */
export interface CatalogEvent {
  readonly name: string;
  /** The milestone that owns it, or `none`. */
  readonly owner: string;
  /** The payload fields the row lists. */
  readonly payloadKeys: readonly string[];
}

function expand(cell: string): string[] {
  const tokens = cell.split(' / ').map((token) => /`([^`]+)`/u.exec(token)?.[1]).filter((token): token is string => token !== undefined);
  const first = tokens[0];
  if (first === undefined) return [];
  const [domain = '', object = ''] = first.split('.');
  const names = [first];
  for (const token of tokens.slice(1)) {
    if (!token.startsWith('_')) {
      names.push(token);
      continue;
    }
    const underscore = object.lastIndexOf('_');
    names.push(underscore === -1 ? `${domain}.${token.slice(1)}` : `${domain}.${object.slice(0, underscore)}${token}`);
  }
  return names;
}

export function parseCatalog(markdown: string): CatalogEvent[] {
  const from = markdown.indexOf('## 3. Catalog');
  const to = markdown.indexOf('**Total:', from);
  if (from === -1 || to === -1) throw new Error('EVENT-TAXONOMY.md has no §3 catalog');
  const events: CatalogEvent[] = [];
  for (const line of markdown.slice(from, to).split('\n')) {
    const cells = /^\| (.+?) \| (.+) \| (\S+) \|$/u.exec(line);
    if (cells === null || cells[1] === 'Event') continue;
    const payloadKeys = [...cells[2]!.matchAll(/`([a-z_]+)`/gu)].map((match) => match[1]!);
    for (const name of expand(cells[1]!)) events.push({ name, owner: cells[3]!, payloadKeys });
  }
  return events;
}

export const readCatalog = (path: string): CatalogEvent[] => parseCatalog(readFileSync(path, 'utf8'));
