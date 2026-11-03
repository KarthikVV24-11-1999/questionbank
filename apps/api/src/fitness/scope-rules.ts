import { join } from 'node:path';
import { contextOf } from './boundary-rules.js';
import { readCode, tsFilesUnder } from './source-scan.js';

/**
 * **A learner's declared scope is read by practice and by nothing else in Assessment** (M8-21, FR-STU-02 rule 1, ADR-0060, DEC-M8-10 in docs/IMPLEMENTATION-DECISIONS.md).
 *
 * Scope narrows practice and recommendations. It never narrows a mock exam: a mock that a scope had trimmed would still be delivered and still be scored, and would no longer be the
 * paper. The assessment handlers are composed from one dependency bag, so the scope source sits in the same object the mock handlers receive, and nothing in the type system says
 * they must not look at it.
 *
 * What this rule can say is the static half, and no more than that: the names that reach the scope (`LearnerScopeSource`, `learnerScope`, `conceptsInScope`, `scopeConceptIds`)
 * appear in Assessment's production files only in the five that carry it to practice — the port, the adapter to Learning, the practice handlers, the practice selector and the
 * composition that wires them. A file on the mock's path (attempt creation, form assembly, the form itself, scoring hand-off) that names any of them fails. It does not prove that
 * a file in the list never hands the value to a mock; `practice-scope.spec.ts` covers that by behaviour, composing a mock with a scope source in the same dependencies and showing it
 * is delivered whole and the source is never asked. A new file that needs the scope has to be added here, in the same change, and that is where a reviewer sees it.
 *
 * Specs are not governed, as everywhere in `source-scan.ts`.
 */
export interface ScopeViolation {
  readonly rule: 'SCOPE_OUTSIDE_PRACTICE';
  readonly file: string;
  readonly name: string;
  readonly message: string;
}

/** The files of Assessment that may name the scope, and why each does. */
export const SCOPE_READERS: readonly string[] = [
  'src/contexts/assessment/application/ports.ts',
  'src/contexts/assessment/application/handlers/practice-handlers.ts',
  'src/contexts/assessment/domain/practice-selection.ts',
  'src/contexts/assessment/infrastructure/learning-scope-source.ts',
  'src/contexts/assessment/public/composition.ts',
];

const SCOPE_NAMES = ['LearnerScopeSource', 'LearnerScopeHandler', 'LearningScopeSource', 'learnerScope', 'conceptsInScope', 'scopeConceptIds'] as const;

export function assessmentFiles(root: string): string[] {
  return tsFilesUnder(join(root, 'src/contexts/assessment')).map((file) => file.slice(root.length + 1).replaceAll('\\', '/'));
}

export function checkScopeReaders(root: string, options: { readonly files?: readonly string[]; readonly allowed?: readonly string[] } = {}): ScopeViolation[] {
  const files = options.files ?? assessmentFiles(root);
  const allowed = options.allowed ?? SCOPE_READERS;
  const violations: ScopeViolation[] = [];
  for (const file of files) {
    if (options.files === undefined && contextOf(file) !== 'assessment') continue;
    if (allowed.includes(file)) continue;
    const code = readCode(join(root, file));
    for (const name of SCOPE_NAMES) {
      if (new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'u').test(code)) {
        violations.push({ rule: 'SCOPE_OUTSIDE_PRACTICE', file, name, message: `${file} names ${name}; a declared scope is read by practice alone, never by a mock exam (FR-STU-02, ADR-0060)` });
      }
    }
  }
  return violations;
}
