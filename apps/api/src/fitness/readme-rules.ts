import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The root README names the bounded contexts there are, and no others** (M7-10).
 *
 * The most-read claim in the repository said "Four bounded contexts" while there were five and then six; the diagram and the table under it
 * were four as well. It went stale at M5, worse at M6, worse again at Track A, and nothing could notice. Three things are held to the
 * directory listing of `apps/api/src/contexts/`, in both directions as the register and documentation-index rules are: the number the heading
 * says, the rows of the table, and the contexts the diagram names.
 */
export interface ReadmeViolation {
  readonly rule: 'README_CONTEXT_COUNT' | 'README_TABLE_ROWS' | 'README_DIAGRAM';
  readonly detail: string;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** The directories under `apps/api/src/contexts/`: the contexts that exist. */
export function contextDirectories(root: string): string[] {
  const base = join(root, 'src', 'contexts');
  return readdirSync(base)
    .filter((entry) => statSync(join(base, entry)).isDirectory())
    .sort();
}

export function checkReadmeContexts(readme: string, directories: readonly string[]): ReadmeViolation[] {
  const violations: ReadmeViolation[] = [];
  const expected = [...directories].sort();

  const heading = /^(\w+) bounded contexts?, each under `apps\/api\/src\/contexts\/`/mu.exec(readme)?.[1];
  const stated = heading === undefined ? -1 : NUMBER_WORDS.indexOf(heading.toLowerCase());
  if (stated !== expected.length) {
    violations.push({
      rule: 'README_CONTEXT_COUNT',
      detail: `the README says ${heading ?? 'nothing'} bounded contexts and the directory holds ${expected.length} (${expected.join(', ')})`,
    });
  }

  const rows = [...readme.matchAll(/^\| `([a-z]+)` \|/gmu)].map((match) => match[1]!).sort();
  for (const name of expected.filter((name) => !rows.includes(name))) {
    violations.push({ rule: 'README_TABLE_ROWS', detail: `contexts/${name}/ exists and the README table has no row for it` });
  }
  for (const name of rows.filter((name) => !expected.includes(name))) {
    violations.push({ rule: 'README_TABLE_ROWS', detail: `the README table has a row for ${name}, and contexts/${name}/ does not exist` });
  }

  const diagram = [...readme.matchAll(/contexts\/([a-z]+)\/ /gu)].map((match) => match[1]!);
  const named = [...new Set(diagram)].sort();
  for (const name of expected.filter((name) => !named.includes(name))) {
    violations.push({ rule: 'README_DIAGRAM', detail: `contexts/${name}/ exists and the README diagram does not show it` });
  }
  for (const name of named.filter((name) => !expected.includes(name))) {
    violations.push({ rule: 'README_DIAGRAM', detail: `the README diagram shows contexts/${name}/, which does not exist` });
  }
  return violations;
}
