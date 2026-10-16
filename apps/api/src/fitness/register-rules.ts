import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **A register and the tree that cites it must agree, both ways.**
 *
 * This repository names things by identifier — `debt D25`, `per DEC-M4-9`,
 * `closes D22` — in module headers, ADRs, migrations and a vitest config,
 * four hundred times over. The convention is only worth anything while every
 * identifier resolves to something a reader can find. Both registers stopped
 * resolving at once, silently, and the failure mode is quiet in both
 * directions: a citation with no entry sends a reader nowhere, and an entry
 * nothing cites is a decision or a gap that may well have been superseded
 * with no one crossing it off.
 *
 * **One implementation, two registers.** ENGINEERING-HANDBOOK §5: two
 * implementations of one rule will drift. Debt and decisions differ only in
 * which file holds the register, what an identifier looks like, and which
 * tokens are somebody else's namespace — so those are parameters, not a
 * second copy of this logic.
 */
export interface RegisterViolation {
  readonly rule: 'UNDEFINED_IDENTIFIER' | 'ORPHAN_ENTRY';
  readonly detail: string;
}

export interface RegisterSpec {
  /** What this register is called, for the violation message. */
  readonly label: string;
  /** Repository-relative path to the register. */
  readonly path: string;
  /** Matches a citation anywhere in a file. Must be global. */
  readonly citation: RegExp;
  /** Matches an entry heading at the start of a line. Must be global + multiline. */
  readonly heading: RegExp;
  /**
   * Files that write a matching token meaning something else, named
   * individually because an exemption nobody had to type is one that quietly
   * grows. The register itself always belongs here: it *defines*, and letting
   * it count as a citation would make every orphan entry satisfy itself.
   */
  readonly notACitation: readonly string[];
  /** Identifiers belonging to another namespace, rejected with a reason at the call site. */
  readonly belongsToAnotherRegister?: (identifier: string) => boolean;
}

const TEXT_EXTENSIONS = ['.md', '.ts', '.tsx', '.yaml', '.yml', '.json', '.sql'];

const PLANTED = 'apps/api/src/fitness-fixtures/as-register-uncited/planted-uncited-identifiers.ts';
const SELF = ['apps/api/src/fitness/register-rules.ts', 'apps/api/src/fitness/register-rules.spec.ts'];

/**
 * `D1`–`D10` are DOMAIN-MODEL's design decisions and `D-001`/`D-002` are
 * DECISIONS.md's product decisions — three registers share the letter, which
 * is how the dangling half stayed invisible for so long. The hyphenated form
 * never matches `citation` at all; the first ten are filtered here.
 */
const DESIGN_DECISION_CEILING = 10;

export const DEBT_REGISTER: RegisterSpec = {
  label: 'debt',
  path: 'docs/DEBT.md',
  citation: /\bD(\d{1,3})\b/gu,
  heading: /^#{2,4}\s+(D\d{1,3})\b/gmu,
  notACitation: [
    'docs/DEBT.md',
    // Its metrics table reads `D7 / D30 retention` — day-7 and day-30
    // retention. `D7` is filtered by the ceiling below anyway; `D30` is not,
    // and it is not a citation of the router debt.
    'docs/PRD.md',
    PLANTED,
    ...SELF,
  ],
  belongsToAnotherRegister: (identifier) => Number(identifier.slice(1)) <= DESIGN_DECISION_CEILING,
};

export const DECISION_REGISTER: RegisterSpec = {
  label: 'implementation decision',
  path: 'docs/IMPLEMENTATION-DECISIONS.md',
  citation: /\bDEC-(?:M\d+-)?\d{1,3}\b/gu,
  heading: /^#{2,4}\s+(DEC-(?:M\d+-)?\d{1,3})\b/gmu,
  notACitation: ['docs/IMPLEMENTATION-DECISIONS.md', PLANTED, ...SELF],
};

export function identifiersDefinedIn(register: string, spec: RegisterSpec): string[] {
  return [...register.matchAll(spec.heading)].map((match) => match[1] as string);
}

/**
 * Everything git would keep, and nothing it would not — the same rule
 * `timing-criterion.spec.ts` scans by. `--others --exclude-standard` means a
 * citation added in this very commit is caught now rather than one commit
 * later; ignored files are excluded because they are not part of the
 * repository a reader clones.
 */
export function citingFiles(root: string, spec: RegisterSpec): string[] {
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing
    .split('\0')
    .filter((path) => path !== '' && TEXT_EXTENSIONS.some((extension) => path.endsWith(extension)))
    .filter((path) => !spec.notACitation.includes(path));
}

export function citationsIn(
  root: string,
  spec: RegisterSpec,
  files: readonly string[],
): { file: string; identifier: string }[] {
  const found: { file: string; identifier: string }[] = [];
  for (const file of files) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(spec.citation)) {
      const identifier = match[0];
      if (spec.belongsToAnotherRegister?.(identifier) === true) continue;
      found.push({ file, identifier });
    }
  }
  return found;
}

export function checkRegister(
  root: string,
  spec: RegisterSpec,
  options: { readonly files?: readonly string[] } = {},
): readonly RegisterViolation[] {
  const defined = new Set(identifiersDefinedIn(readFileSync(join(root, spec.path), 'utf8'), spec));
  const citations = citationsIn(root, spec, options.files ?? citingFiles(root, spec));
  const violations: RegisterViolation[] = [];

  const undefinedFirstSeen = new Map<string, string>();
  for (const { file, identifier } of citations) {
    if (!defined.has(identifier) && !undefinedFirstSeen.has(identifier)) {
      undefinedFirstSeen.set(identifier, file);
    }
  }
  for (const [identifier, file] of [...undefinedFirstSeen].sort()) {
    violations.push({
      rule: 'UNDEFINED_IDENTIFIER',
      detail: `${file} cites ${identifier}, absent from ${spec.path}`,
    });
  }

  // Only meaningful over the whole tree: a caller that passed one file has not
  // looked anywhere an entry could legitimately be cited from.
  if (options.files === undefined) {
    const cited = new Set(citations.map(({ identifier }) => identifier));
    for (const identifier of [...defined].sort()) {
      if (!cited.has(identifier)) {
        violations.push({
          rule: 'ORPHAN_ENTRY',
          detail: `${spec.path} carries ${identifier}, cited nowhere`,
        });
      }
    }
  }

  return violations;
}
