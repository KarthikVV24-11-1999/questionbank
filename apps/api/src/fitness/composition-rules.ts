import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { importsOf, readCode, tsFilesUnder } from './source-scan.js';

/**
 * **The composition root imports each context's `public/composition.js` and nothing
 * else of the context** (DEC-M0-5, ADR-0015). It wires; it does not reach.
 *
 * The older F1 rule (`boundary-rules.ts`) keeps `platform/` out of a context's
 * internals but admits the public barrel as well. The root has no use for a barrel —
 * a type it needed from one would be a sign it was deciding something — and
 * generation made the question concrete: it is the first context whose composition
 * needs another's output, so the temptation to import a handler or a repository to
 * connect the two is real. This rule says the seam is the only door.
 *
 * Specs under `platform/composition/` are not held to it. They assemble real
 * subsystems to test them and import what that takes.
 */
export interface CompositionViolation {
  readonly rule: 'M5_37_ROOT_REACHES_PAST_THE_SEAM';
  readonly file: string;
  readonly message: string;
}

const COMPOSITION_ROOT = 'src/platform/composition';
const SEAM_TARGET = /^src\/contexts\/([^/]+)\/public\/composition\.ts$/u;
const ANY_CONTEXT_TARGET = /^src\/contexts\/([^/]+)\//u;

function governedFiles(root: string, include: readonly string[]): string[] {
  return include.flatMap((directory) =>
    tsFilesUnder(join(root, directory)).filter((file) => !/\.spec\.tsx?$/u.test(file)),
  );
}

function contextImports(root: string, file: string): { readonly path: string; readonly target: string }[] {
  return importsOf(readCode(file))
    .filter((path) => path.startsWith('.'))
    .map((path) => ({ path, target: relative(root, resolve(dirname(file), path.replace(/\.js$/u, '.ts'))).split('\\').join('/') }))
    .filter(({ target }) => ANY_CONTEXT_TARGET.test(target));
}

export function checkCompositionImportsOnlySeams(
  root: string,
  options: { readonly include?: readonly string[] } = {},
): CompositionViolation[] {
  return governedFiles(root, options.include ?? [COMPOSITION_ROOT]).flatMap((file) =>
    contextImports(root, file)
      .filter(({ target }) => !SEAM_TARGET.test(target))
      .map(({ path, target }) => ({
        rule: 'M5_37_ROOT_REACHES_PAST_THE_SEAM' as const,
        file: relative(root, file).split('\\').join('/'),
        message: `imports ${path} (${target}); the composition root may import only a context's public/composition.js`,
      })),
  );
}

/** The contexts whose seam the root imports, so a spec can assert the set and not the loop. */
export function composedContexts(root: string, include: readonly string[] = [COMPOSITION_ROOT]): string[] {
  const names = new Set<string>();
  for (const file of governedFiles(root, include)) {
    for (const { target } of contextImports(root, file)) {
      const match = SEAM_TARGET.exec(target);
      if (match !== null && existsSync(join(root, target))) names.add(match[1] as string);
    }
  }
  return [...names].sort();
}
