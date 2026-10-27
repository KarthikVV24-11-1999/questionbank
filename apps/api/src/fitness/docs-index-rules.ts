import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **`docs/README.md` indexes every document, and every entry names one that exists** (M7-07).
 *
 * The index opens "One line per document", and for a milestone it did not: `KEY-FREE.md` and `M6-ACCEPTANCE.md` were tracked
 * and unlisted, so a reader who started from the index could not find either. Both directions are checked, as the register rules
 * check theirs: a document with no entry cannot be found from the index, and an entry naming a file that is gone sends a reader
 * nowhere.
 *
 * **The set a document must be listed in is what git keeps, not what the directory holds.** The working handoffs and task
 * documents sit in `docs/` and are correctly absent from the index; they are excluded from the repository, so listing the
 * directory would demand an entry for each. `--cached --others --exclude-standard` is the register rules' own listing — a
 * document added in this very commit is checked now rather than one commit later.
 *
 * Governed: every `*.md` directly under `docs/` except the index itself, which a reader is already holding. A subdirectory is indexed by its own entry (`adr/`), which must exist as a
 * directory; the documents inside are that directory's business.
 */
export interface DocsIndexViolation {
  readonly rule: 'DOCUMENT_NOT_INDEXED' | 'INDEX_ENTRY_NAMES_NOTHING';
  readonly detail: string;
}

export const DOCS_INDEX = 'docs/README.md';

/** The repo-relative paths of the `*.md` files directly under `docs/` that git would keep. */
export function trackedDocuments(root: string): string[] {
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'docs'], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...new Set(listing.split('\0'))]
    .filter((path) => /^docs\/[^/]+\.md$/u.test(path))
    .filter((path) => existsSync(join(root, path)))
    .sort();
}

/** The link targets of the index's entries: the `(target)` of a `- [label](target)` line. */
export function indexEntries(index: string): string[] {
  return [...index.matchAll(/^- \[[^\]]+\]\(([^)\s]+)\)/gmu)].map((match) => match[1]!);
}

export function checkDocsIndex(
  index: string,
  documents: readonly string[],
  exists: (target: string) => boolean,
): DocsIndexViolation[] {
  const entries = indexEntries(index);
  const violations: DocsIndexViolation[] = [];

  for (const document of documents.filter((path) => path !== DOCS_INDEX)) {
    const name = document.slice('docs/'.length);
    if (!entries.includes(name)) {
      violations.push({ rule: 'DOCUMENT_NOT_INDEXED', detail: `${document} is tracked and has no entry in ${DOCS_INDEX}` });
    }
  }
  for (const entry of entries) {
    if (!exists(entry)) {
      violations.push({ rule: 'INDEX_ENTRY_NAMES_NOTHING', detail: `${DOCS_INDEX} lists ${entry}, which does not exist` });
    }
  }
  return violations;
}

/** The entry's target resolved against `docs/`, for a file or for a directory (`adr/`). */
export function entryExists(root: string, target: string): boolean {
  return existsSync(join(root, 'docs', target));
}
