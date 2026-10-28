import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceFilesIn } from './context-anatomy.js';

/** What counts as a layer being there (DEC-M7-26): code, and not the file that holds a place for it. */
const made: string[] = [];
afterEach(() => made.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function layer(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'anatomy-'));
  made.push(directory);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, '..'), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  return directory;
}

describe('the source a layer holds', () => {
  it('is none for a directory that holds only a placeholder', () => {
    expect(sourceFilesIn(layer({ '.gitkeep': '' }))).toEqual([]);
  });

  it('is none for a directory of specs alone: a test is not the layer it tests', () => {
    expect(sourceFilesIn(layer({ 'thing.spec.ts': '' }))).toEqual([]);
  });

  it('is none for files that are not TypeScript', () => {
    expect(sourceFilesIn(layer({ 'notes.md': '', 'thing.js': '' }))).toEqual([]);
  });

  it('finds a module however deep it sits', () => {
    const directory = layer({ '.gitkeep': '', 'dto/schemas.ts': '', 'dto/schemas.spec.ts': '' });
    expect(sourceFilesIn(directory)).toEqual([join(directory, 'dto', 'schemas.ts')]);
  });
});
