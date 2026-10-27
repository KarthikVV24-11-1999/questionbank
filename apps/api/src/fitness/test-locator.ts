import ts from 'typescript';

/**
 * Finds a test by its title, and says whether it **runs** (M7-17).
 *
 * A rule that names a test by title and checks that the title is *in the file* is checking the code's intentions: `describe.skip` leaves every title where it
 * was, so a gate built on `includes(title)` passed while the key-free argument's absence test for the attempt responses did not run (D73). A gate that names a
 * test asserts that the test is run (DEC-M7-10, ADR-0047).
 *
 * **It reads the structure, not more text.** The file is parsed, every `describe`/`it`/`test` call is found with its chain of modifiers and the calls that
 * enclose it, and a title matches when it appears in the source of that call's title argument (the table's titles are the start of the real ones, and a template
 * title is matched on its text). A test does **not** run when:
 *
 *   - it or an enclosing `describe` is `.skip` or `.todo` (vitest has no `xit` family: those are Jest's, and a call to one would not run at all);
 *   - it or an enclosing block is `.skipIf(...)` or `.runIf(...)`: conditional on something the gate cannot read, so it cannot be shown to run;
 *   - the file holds a `.only` that neither it nor an enclosing block shares, which silences everything else in the file.
 *
 * `it.each(table)('title')` and `describe.concurrent` are read through: the base name is the leftmost identifier and the modifiers are every property named
 * along the callee, whether or not a call sits between them.
 */
export interface LocatedTest {
  readonly found: boolean;
  /** At least one test with the title is run. Meaningless when not found. */
  readonly runs: boolean;
  /** When found and not run: the form that stops it, with its line. */
  readonly because?: string;
}

const BLOCKS = new Set(['describe', 'suite', 'it', 'test']);
const NOT_RUNNING = new Set(['skip', 'todo', 'skipIf', 'runIf']);

interface Block {
  readonly base: string;
  readonly modifiers: readonly string[];
  readonly title: string;
  readonly line: number;
  readonly parent: Block | undefined;
}

/** The leftmost identifier and every property named along a callee, through any calls in the chain. */
function calleeParts(expression: ts.Expression): { base: string; modifiers: string[] } | undefined {
  const modifiers: string[] = [];
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      modifiers.unshift(current.name.text);
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else break;
  }
  return ts.isIdentifier(current) && BLOCKS.has(current.text) ? { base: current.text, modifiers } : undefined;
}

const stops = (block: Block): string | undefined => {
  const modifier = block.modifiers.find((m) => NOT_RUNNING.has(m));
  return modifier === undefined ? undefined : `${block.base}.${modifier} (line ${block.line})`;
};

export function locateTest(source: string, title: string, fileName = 'file.spec.ts'): LocatedTest {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const blocks: Block[] = [];
  let firstOnly: Block | undefined;

  const visit = (node: ts.Node, parent: Block | undefined): void => {
    let enclosing = parent;
    if (ts.isCallExpression(node)) {
      const parts = calleeParts(node.expression);
      const first = node.arguments[0];
      if (parts !== undefined && first !== undefined && (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first) || ts.isBinaryExpression(first))) {
        const block: Block = { ...parts, title: first.getText(file), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, parent };
        blocks.push(block);
        if (block.modifiers.includes('only')) firstOnly ??= block;
        enclosing = block;
      }
    }
    ts.forEachChild(node, (child) => visit(child, enclosing));
  };
  visit(file, undefined);

  const candidates = blocks.filter((b) => b.title.includes(title));
  if (candidates.length === 0) return { found: false, runs: false };

  const chain = (b: Block): Block[] => (b.parent === undefined ? [b] : [b, ...chain(b.parent)]);
  let because: string | undefined;
  for (const candidate of candidates) {
    const blocking = chain(candidate).map(stops).find((s) => s !== undefined);
    if (blocking !== undefined) {
      because ??= blocking;
      continue;
    }
    if (firstOnly !== undefined && !chain(candidate).some((b) => b.modifiers.includes('only'))) {
      because ??= `a .only at line ${firstOnly.line} silences everything else in the file`;
      continue;
    }
    return { found: true, runs: true };
  }
  return { found: true, runs: false, because: because! };
}
