import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVENT_NAMES } from '@questionbank/contracts/analytics';
import { describe, expect, it } from 'vitest';
import { parseCatalog, readCatalog } from './event-catalog.js';

const TAXONOMY = resolve(import.meta.dirname, '../../../../docs/EVENT-TAXONOMY.md');
const MILESTONES = ['M1', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'none'];

describe('the event catalog, read from docs/EVENT-TAXONOMY.md §3', () => {
  const catalog = readCatalog(TAXONOMY);

  it('is the set of names the ingestion edge admits, both ways: a name in the document and not the contract, or the contract and not the document, is a red build', () => {
    expect([...EVENT_NAMES].sort()).toEqual(catalog.map((event) => event.name).sort());
  });

  it('names no event twice, and states the total it lists', () => {
    expect(new Set(catalog.map((event) => event.name)).size).toBe(catalog.length);
    const rows = readFileLines().filter((line) => /^\| (`|\*\*`)/u.test(line)).length;
    expect(readFileLines().find((line) => line.startsWith('**Total:'))).toContain(`${catalog.length} event names, written on ${rows} rows`);
  });

  it('gives every event an owner that is a milestone of the roadmap, or says none', () => {
    expect(catalog.filter((event) => !MILESTONES.includes(event.owner)).map((event) => event.name)).toEqual([]);
  });

  it('sees a name added to the document and nowhere else', () => {
    const planted = `${readFileLines().join('\n').replace('## 3. Catalog', '## 3. Catalog\n| Event | Key payload | Owner |\n|---|---|---|\n| `planted.thing_happened` | `x` | M7 |')}`;
    const names = parseCatalog(planted).map((event) => event.name);
    expect(names).toContain('planted.thing_happened');
    expect(EVENT_NAMES as readonly string[]).not.toContain('planted.thing_happened');
  });
});

function readFileLines(): string[] {
  return readFileSync(TAXONOMY, 'utf8').split('\n');
}
