import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source scanning for the architecture guards that specs run directly.
 *
 * The naive version — matching `from '...'` against raw file text — reports a
 * violation for the phrase `from "invalid item"` sitting in a doc comment. It
 * found exactly that on the first run of the content guards, which is the
 * right lesson twice over: a guard that reads comments is measuring prose, and
 * the fix belongs in the guard rather than in the comment.
 *
 * `stripComments` is string-aware, so a `//` inside a string literal survives
 * and a quote inside a comment does not open one. It does **not** parse regular
 * expression literals: a `'` or `"` inside one would be read as opening a
 * string. No module scanned here contains such a literal, and the direction of
 * that failure is a missed import rather than an invented one — so it is
 * recorded here rather than solved with a parser.
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;
    const pair = source.slice(index, index + 2);

    if (pair === '//') {
      while (index < source.length && source[index] !== '\n') {
        out.push(' ');
        index += 1;
      }
      continue;
    }

    if (pair === '/*') {
      while (index < source.length && source.slice(index, index + 2) !== '*/') {
        out.push(source[index] === '\n' ? '\n' : ' ');
        index += 1;
      }
      out.push('  ');
      index += 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      out.push(char);
      index += 1;
      while (index < source.length) {
        const inner = source[index] as string;
        out.push(inner);
        index += 1;
        if (inner === '\\' && index < source.length) {
          out.push(source[index] as string);
          index += 1;
          continue;
        }
        if (inner === char) break;
      }
      continue;
    }

    out.push(char);
    index += 1;
  }

  return out.join('');
}

/** Every non-spec TypeScript file under a directory, recursively. */
export function tsFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * Every module a source file reaches, however it reaches it. A dynamic
 * `import()` or a `require()` reaches just as far as a static import, and a
 * rule that misses them can be stepped around — which is worse than no rule
 * (ADR-0002).
 *
 * The static pattern's gap between the keyword and `from` excludes `;`, `'`,
 * `"` and a backtick. Without that, `[\s\S]*?` runs from any line-starting
 * `export` through arbitrary code until it finds the word `from` next to a
 * quote — and it found one: the message string
 * `'a published item records where it came from', 'version.provenance'`
 * reported an import of `", "`, failing F2 on prose inside a string literal.
 *
 * A real import statement has none of those characters before its `from`, so
 * excluding them costs nothing and closes the whole class: comments were the
 * first layer (see `stripComments`), string literals were the second.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*(?:import|export)(?![\w$])[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/gu,
  /(?:^|\n)\s*import\s+['"]([^'"\n]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu,
];

export function importsOf(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined && !found.includes(specifier)) found.push(specifier);
    }
  }
  return found;
}

export function readCode(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

/** Files under `directory` whose executable code matches `pattern`. */
export function filesMatching(directory: string, pattern: RegExp): string[] {
  return tsFilesUnder(directory).filter((file) => pattern.test(readCode(file)));
}
