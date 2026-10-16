import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { contextOf, resolveImport } from './boundary-rules.js';
import { importsOf, readCode } from './source-scan.js';

/**
 * **Generation is downstream of Content, and nothing points back** (ADR-0025).
 *
 * `generation` reaches `content` through `content/public/` and issues the same
 * authoring command a human author's draft goes through. Content does not know
 * generation exists — no import, no handler reading `ai.*`, no second queue.
 * That direction is what lets `content` stay deployable with no AI anywhere in
 * the picture, and it is what SEC-20 leans on: the AI service holds no
 * capability to write Content aggregates, so a successful prompt injection has
 * nothing to reach.
 *
 * F1 already checks that cross-context imports go through a barrel. It says
 * nothing about **direction** — `content` importing `generation/public/` would
 * satisfy F1 and still be the coupling this rule exists to prevent. Hence a
 * separate rule rather than a widened one.
 *
 * **Status: governing a real context** (M5 Track A). `contexts/generation/`
 * exists, so the clean-tree assertion is no longer the `no subject` posture
 * F26 takes for the attempt engine. The planted fixture is still what keeps the
 * rule non-vacuous — a rule that has only ever run against a clean tree is not
 * proven by that tree being clean.
 */
export interface GenerationViolation {
  readonly rule: 'GENERATION_IS_DOWNSTREAM_ONLY';
  readonly file: string;
  readonly importPath: string;
  readonly message: string;
}

export const GENERATION_CONTEXT = 'generation';

const GENERATION_PREFIX = `src/contexts/${GENERATION_CONTEXT}/`;

/**
 * `platform/composition/` is not covered, and the omission is deliberate: the
 * composition root imports every context's `public/composition.js` by design
 * (DEC-M0-5), which is how generation gets wired at all. This rule governs
 * *bounded contexts* reaching sideways, never the root that composes them.
 */
const CONTEXTS_ROOT = 'src/contexts';

function tsFilesUnder(root: string, directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, directory));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${directory}/${entry}`;
    return statSync(join(root, path)).isDirectory()
      ? tsFilesUnder(root, path)
      : path.endsWith('.ts') || path.endsWith('.tsx')
        ? [path]
        : [];
  });
}

/** Every context file that is not generation's own — the files this rule governs. */
export function upstreamContextFiles(root: string): string[] {
  return tsFilesUnder(root, CONTEXTS_ROOT).filter((file) => contextOf(file) !== GENERATION_CONTEXT);
}

export function checkGenerationIsDownstreamOnly(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files = options.files ?? upstreamContextFiles(root);
  const violations: GenerationViolation[] = [];

  for (const file of files) {
    for (const importPath of importsOf(readCode(join(root, file)))) {
      const resolved = resolveImport(file, importPath, root);
      const reachesGeneration =
        resolved?.startsWith(GENERATION_PREFIX) === true ||
        // A non-relative specifier cannot resolve to a path, so it is matched
        // on its text. Nothing in this repository publishes generation as a
        // package today; this catches the day something tries.
        /(^|\/)contexts\/generation\//u.test(importPath);

      if (reachesGeneration) {
        violations.push({
          rule: 'GENERATION_IS_DOWNSTREAM_ONLY',
          file,
          importPath,
          message: `${file} imports ${importPath}; generation is downstream of content and nothing may point back (ADR-0025)`,
        });
      }
    }
  }

  return violations;
}

/** Repo-relative path of a file, for a caller holding an absolute one. */
export function repoRelative(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll('\\', '/');
}
