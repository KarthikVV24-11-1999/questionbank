import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The debt register and the tree that cites it must agree, both ways.**
 *
 * This repository names its known gaps by identifier — `debt D25`, `closes
 * D22`, `D36` — in module headers, ADRs, a migration and a vitest config,
 * 77 times at the last count. That convention is only worth anything while
 * every identifier resolves to something a reader can find. It stopped
 * resolving once, silently, and the failure mode is quiet in both
 * directions: a citation with no entry sends a reader nowhere, and an entry
 * nothing cites is a gap that may well have been closed with no one
 * crossing it off.
 *
 * So both directions are checked. `DEBT.md` is the index; the code is the
 * authority — which is exactly why the index cannot be allowed to drift
 * away from it.
 */
export interface DebtViolation {
  readonly rule: 'UNDEFINED_DEBT_ID' | 'ORPHAN_DEBT_ENTRY';
  readonly detail: string;
}

export const REGISTER = 'docs/DEBT.md';

/**
 * `D1`–`D10` are DOMAIN-MODEL's design decisions, not debt. The two
 * namespaces share a prefix, which is unfortunate and predates this check;
 * the boundary is recorded in `DEBT.md`'s own header so a reader meets it
 * before meeting a `D5` and wondering which kind it is.
 */
const FIRST_DEBT_ID = 11;

/**
 * Files that write a debt-shaped token meaning something else, named
 * individually because an exemption nobody had to type is one that quietly
 * grows.
 *
 * - `docs/PRD.md` — its metrics table reads `D7 / D30 retention`, which is
 *   day-7 and day-30 retention. `D7` is filtered by `FIRST_DEBT_ID` anyway;
 *   `D30` is not, and it is not a citation of the router debt.
 * - `docs/DEBT.md` — the register *defines*; letting it count as a citation
 *   would make every orphan entry satisfy itself.
 * - this module and its spec — a checker that matched its own pattern, and
 *   its own deliberately-broken counter-example, would report itself
 *   forever.
 */
const NOT_A_CITATION: readonly string[] = [
  'docs/PRD.md',
  REGISTER,
  'apps/api/src/fitness/debt-rules.ts',
  'apps/api/src/fitness/debt-rules.spec.ts',
  'apps/api/src/fitness-fixtures/as-debt-uncited/planted-debt-citation.ts',
];

const TEXT_EXTENSIONS = ['.md', '.ts', '.tsx', '.yaml', '.yml', '.json', '.sql'];

const CITATION = /\bD(\d{1,3})\b/gu;

/** `### D17 — Nothing drains the outbox` declares D17. Nothing else does. */
const ENTRY_HEADING = /^#{2,4}\s+D(\d{1,3})\b/gmu;

export function debtIdsDefinedIn(register: string): number[] {
  return [...register.matchAll(ENTRY_HEADING)].map((match) => Number(match[1]));
}

/**
 * Everything git would keep, and nothing it would not — the same rule
 * `timing-criterion.spec.ts` scans by. `--others --exclude-standard` means
 * a citation added in this very commit is caught now rather than one commit
 * later; ignored files are excluded because they are not part of the
 * repository a reader clones.
 */
export function citingFiles(root: string): string[] {
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing
    .split('\0')
    .filter((path) => path !== '' && TEXT_EXTENSIONS.some((extension) => path.endsWith(extension)))
    .filter((path) => !NOT_A_CITATION.includes(path));
}

export function debtCitationsIn(root: string, files: readonly string[]): { file: string; id: number }[] {
  const found: { file: string; id: number }[] = [];
  for (const file of files) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(CITATION)) {
      const id = Number(match[1]);
      if (id >= FIRST_DEBT_ID) found.push({ file, id });
    }
  }
  return found;
}

export function checkDebtRegister(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): readonly DebtViolation[] {
  const defined = new Set(debtIdsDefinedIn(readFileSync(join(root, REGISTER), 'utf8')));
  const citations = debtCitationsIn(root, options.files ?? citingFiles(root));
  const violations: DebtViolation[] = [];

  const undefinedIds = new Map<number, string>();
  for (const { file, id } of citations) {
    if (!defined.has(id) && !undefinedIds.has(id)) undefinedIds.set(id, file);
  }
  for (const [id, file] of [...undefinedIds].sort((a, b) => a[0] - b[0])) {
    violations.push({ rule: 'UNDEFINED_DEBT_ID', detail: `${file} cites D${id}, absent from ${REGISTER}` });
  }

  // Only meaningful over the whole tree: a caller that passed one file has
  // not looked anywhere an entry could legitimately be cited from.
  if (options.files === undefined) {
    const cited = new Set(citations.map(({ id }) => id));
    for (const id of [...defined].sort((a, b) => a - b)) {
      if (!cited.has(id)) {
        violations.push({ rule: 'ORPHAN_DEBT_ENTRY', detail: `${REGISTER} carries D${id}, cited nowhere` });
      }
    }
  }

  return violations;
}
