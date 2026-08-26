import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **Tier 3 — the gate's wording, guarded across the whole repository
 * (M4-44, DEC-M4-5).**
 *
 * DEC-M4-5 fixes the close-out sentence now, at the start, "so it cannot
 * drift toward *basically met* as pieces land". That is a rule about words,
 * and words drift in documents nobody re-reads — so it is asserted rather
 * than trusted:
 *
 * > **the phrase `40 items/hour` may appear only where `Fail — blocked`
 * > appears too.**
 *
 * The failure this prevents is specific and plausible. Three Tier-1
 * measurements exist (`throughput.spec.ts`, `interaction-cost.spec.tsx`,
 * `machine-time.integration.spec.ts`), all green, all about software. The
 * temptation at close-out is to write "the workspace sustains 40
 * items/hour" — which is a claim about people, supported by none of them.
 * A reader who sees the phrase must see its status in the same breath.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The phrase the gate is written in, in every spelling the documents use. */
const GATE_PHRASES = ['40 items/hour', '40 items per hour'] as const;

/** The status that must accompany it. Both dash spellings, since documents use both. */
const REQUIRED_STATUS = ['Fail — blocked', 'Fail - blocked', 'Fail—blocked'] as const;

/**
 * **Everything git would keep, and nothing it would not.** `--cached`
 * catches tracked files; `--others --exclude-standard` catches files that
 * are new but not ignored, so a mention introduced in this very commit is
 * caught now rather than one commit later. What both exclude is the
 * gitignored working notes — `docs/HANDOFF-*.md`, `docs/tasks/M*-PROGRESS.md`
 * — which are not part of the repository a reader clones, and holding a
 * private scratch file to the close-out's wording rule would be rigour aimed
 * at the wrong document.
 */
const TEXT_EXTENSIONS = ['.md', '.ts', '.tsx', '.yaml', '.yml', '.json', '.sql'];

function trackedTextFiles(): string[] {
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing
    .split('\0')
    .filter((path) => path !== '' && TEXT_EXTENSIONS.some((extension) => path.endsWith(extension)));
}

/**
 * The checker exempts itself, by name — the same discipline
 * `key-boundary.spec.ts`'s `SCANNER` constant uses, and for the same reason:
 * a scanner that matches its own pattern, and its own deliberately-broken
 * counter-example, would report itself forever. Written here rather than
 * inferred from a path, because an exemption nobody had to type is one that
 * quietly grows.
 */
const SELF = 'apps/api/src/testing/review/timing-criterion.spec.ts';

interface Mention {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly accompanied: boolean;
}

/**
 * "Accompanied" is judged over a **window of lines**, not the same line.
 * The close-out and the plan both write the gate on one line and its status
 * on the next; requiring them on a single line would fail correct documents
 * and push authors toward cramming, which is not the point. Six lines is
 * wide enough for a table row plus its note and narrow enough that the two
 * are genuinely being read together.
 */
const WINDOW = 6;

function mentionsIn(file: string): Mention[] {
  const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n');
  const mentions: Mention[] = [];

  for (const [index, text] of lines.entries()) {
    if (!GATE_PHRASES.some((phrase) => text.includes(phrase))) continue;
    const window = lines
      .slice(Math.max(0, index - WINDOW), Math.min(lines.length, index + WINDOW + 1))
      .join('\n');
    mentions.push({
      file,
      line: index + 1,
      text: text.trim(),
      accompanied: REQUIRED_STATUS.some((status) => window.includes(status)),
    });
  }

  return mentions;
}

const allMentions = trackedTextFiles()
  .filter((file) => file !== SELF)
  .flatMap(mentionsIn);

describe('Tier 3 — "40 items/hour" never appears without its status (M4-44)', () => {
  it('found the phrase somewhere, so the scan is not passing over an empty set', () => {
    expect(allMentions.length).toBeGreaterThan(3);
  });

  it('scanned more than one file — the gate is named in the plan and the docs both', () => {
    expect(new Set(allMentions.map((mention) => mention.file)).size).toBeGreaterThan(1);
  });

  it('every mention is accompanied by "Fail — blocked"', () => {
    const unaccompanied = allMentions
      .filter((mention) => !mention.accompanied)
      .map((mention) => `${mention.file}:${mention.line} — ${mention.text}`);
    expect(unaccompanied).toEqual([]);
  });

  /**
   * The rule proven able to fail. A mention with no status anywhere near it
   * is exactly the drift DEC-M4-5 forbids, and the checker must call it —
   * otherwise "every mention is accompanied" above is a statement about the
   * checker's blindness rather than about the repository.
   */
  it('is red on a planted unaccompanied mention', () => {
    const planted = ['The workspace sustains 40 items/hour.', 'Nothing else on this line.'].join('\n');
    const lines = planted.split('\n');
    const found = lines
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => GATE_PHRASES.some((phrase) => text.includes(phrase)))
      .map(({ index }) => {
        const window = lines
          .slice(Math.max(0, index - WINDOW), Math.min(lines.length, index + WINDOW + 1))
          .join('\n');
        return REQUIRED_STATUS.some((status) => window.includes(status));
      });

    expect(found).toEqual([false]);
  });

  /**
   * And the converse: the same phrase with the status nearby passes, so the
   * check is discriminating between the two cases rather than refusing the
   * phrase outright.
   */
  it('is green on a mention that carries its status', () => {
    const lines = ['≥ 40 items/hour sustained by a reviewer', '', '**Fail — blocked**: no reviewer pool exists.'];
    const index = 0;
    const window = lines
      .slice(Math.max(0, index - WINDOW), Math.min(lines.length, index + WINDOW + 1))
      .join('\n');
    expect(REQUIRED_STATUS.some((status) => window.includes(status))).toBe(true);
  });
});
