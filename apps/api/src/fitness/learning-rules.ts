import { join } from 'node:path';
import { contextOf, resolveImport } from './boundary-rules.js';
import { importsOf, readCode, tsFilesUnder } from './source-scan.js';

/**
 * **Learning and the two contexts its evidence is derived from share no import, in either direction** (M7-06, DEC-M7-1).
 *
 * Learning's evidence is assembled from what scoring says happened to each slot and what content says each item version is
 * about. It reads both through seams the composition root joins (`platform/composition/learning-evidence.ts`) and holds a
 * port of its own; it has no production import of scoring or content. F1 admits a public-barrel import and the composition
 * rule (M5-37) governs only the root, so neither says this: a barrel import from `learning` into `scoring` satisfies both and
 * is still the coupling this rule exists to prevent. The temptation is structural rather than occasional — the data is
 * *derived* from those two contexts, so the shortest path to it is always a direct read.
 *
 * Four clauses, one per directed pair:
 *
 *   - learning → scoring, and learning → content: Learning reaches for the data instead of taking the seam.
 *   - scoring → learning, and content → learning: the owning context learns who consumes it, which is the dependency
 *     DEC-M7-1 turned around (scoring's own header says Learning reads the owning context rather than a copy in an event).
 *
 * Imports are read by `importsOf`, which sees `import type` and `export … from` as well as a value import and a dynamic
 * `import()`: a type-only import costs nothing at runtime and couples exactly as far.
 *
 * Specs are not governed, as everywhere in `source-scan.ts`: a test that reaches across is testing the seam, and the
 * vocabulary specs in `platform/composition/` are that.
 */
export interface LearningBoundaryViolation {
  readonly rule: 'LEARNING_REACHES_ITS_SOURCES' | 'SOURCE_REACHES_LEARNING';
  readonly file: string;
  readonly importPath: string;
  readonly message: string;
}

export const LEARNING_CONTEXT = 'learning';
/** The two contexts Learning's evidence is derived from. */
export const EVIDENCE_SOURCE_CONTEXTS = ['scoring', 'content'] as const;

const CONTEXTS_ROOT = 'src/contexts';

/** Every production file in every context: the files this rule governs. */
export function contextFiles(root: string): string[] {
  return tsFilesUnder(join(root, CONTEXTS_ROOT)).map((file) => file.slice(root.length + 1).replaceAll('\\', '/'));
}

function targetContextOf(file: string, importPath: string, root: string): string | null {
  const resolved = resolveImport(file, importPath, root);
  if (resolved !== null) return contextOf(resolved);
  // A specifier that is not relative cannot resolve to a path, so it is matched on its text: nothing here publishes a context as
  // a package today, and this is what would catch the day something tries.
  return /(?:^|\/)contexts\/([^/]+)\//u.exec(importPath)?.[1] ?? null;
}

/**
 * `as` makes every given file stand for a context, so a planted fixture — which lives outside `src/contexts/`, where the real
 * scan never reaches it — can play a file of Learning's, or of scoring's, or content's.
 */
export function checkLearningBoundary(
  root: string,
  options: { readonly files?: readonly string[]; readonly as?: string } = {},
): LearningBoundaryViolation[] {
  const files = options.files ?? contextFiles(root);
  const sources = EVIDENCE_SOURCE_CONTEXTS as readonly string[];
  const violations: LearningBoundaryViolation[] = [];

  for (const file of files) {
    const owner = options.as ?? contextOf(file);
    if (owner === null) continue;
    for (const importPath of importsOf(readCode(join(root, file)))) {
      const target = targetContextOf(file, importPath, root);
      if (target === null) continue;

      if (owner === LEARNING_CONTEXT && sources.includes(target)) {
        violations.push({
          rule: 'LEARNING_REACHES_ITS_SOURCES',
          file,
          importPath,
          message: `${file} imports ${importPath}; learning takes its evidence through the composition root's seams and imports no ${target} (DEC-M7-1)`,
        });
      }
      if (sources.includes(owner) && target === LEARNING_CONTEXT) {
        violations.push({
          rule: 'SOURCE_REACHES_LEARNING',
          file,
          importPath,
          message: `${file} imports ${importPath}; ${owner} does not know who consumes it, and learning is downstream of it (DEC-M7-1)`,
        });
      }
    }
  }
  return violations;
}
