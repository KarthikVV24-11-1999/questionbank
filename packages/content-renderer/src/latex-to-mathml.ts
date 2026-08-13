/**
 * LaTeX → **real MathML** (ACC-02, TECH-STACK §1).
 *
 * MathML, not HTML-and-CSS that looks like mathematics: a screen reader can
 * read `<mfrac>` and cannot read a stack of styled `<span>`s, which is the
 * whole reason TECH-STACK chose a MathML emitter over KaTeX.
 *
 * **Why this is written here rather than delegated to Temml.** TECH-STACK names
 * Temml, and Temml is not in the dependency tree — this repository has no
 * network, and a rendering path is not something to leave unbuilt for a whole
 * milestone while M3-11's publication precondition consumes a render verdict.
 * So the subset JEE/NEET items actually use is emitted here, behind one
 * module, and swapping Temml in is a change to this file and nothing else.
 * Recorded as debt with a named trigger: the first authored expression this
 * subset cannot express.
 *
 * **Deterministic by construction.** A pure function of the source string: no
 * identifiers, no counters, no clock. The same LaTeX yields byte-identical
 * MathML on every call and on every surface, which is what M3-38's parity
 * claim rests on.
 */

export type MathMLResult =
  | { readonly ok: true; readonly mathml: string }
  | { readonly ok: false; readonly reason: string };

/** Commands that take one braced argument and wrap it. */
const UNARY_WRAPPERS: Readonly<Record<string, string>> = Object.freeze({
  '\\sqrt': 'msqrt',
  '\\overline': 'mover',
  '\\vec': 'mover',
});

/** Symbols with a single MathML character. Closed, so an unknown one is refused. */
const SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  '\\alpha': 'α',
  '\\beta': 'β',
  '\\gamma': 'γ',
  '\\delta': 'δ',
  '\\Delta': 'Δ',
  '\\epsilon': 'ε',
  '\\theta': 'θ',
  '\\lambda': 'λ',
  '\\mu': 'μ',
  '\\nu': 'ν',
  '\\pi': 'π',
  '\\rho': 'ρ',
  '\\sigma': 'σ',
  '\\tau': 'τ',
  '\\phi': 'φ',
  '\\omega': 'ω',
  '\\Omega': 'Ω',
  '\\infty': '∞',
  '\\partial': '∂',
});

/** Operators, which become `<mo>`. */
const OPERATORS: Readonly<Record<string, string>> = Object.freeze({
  '\\times': '×',
  '\\cdot': '⋅',
  '\\div': '÷',
  '\\pm': '±',
  '\\mp': '∓',
  '\\leq': '≤',
  '\\geq': '≥',
  '\\neq': '≠',
  '\\approx': '≈',
  '\\rightarrow': '→',
  '\\to': '→',
  '\\int': '∫',
  '\\sum': '∑',
  '\\prod': '∏',
});

/** Function names, set upright as `<mi>` per the MathML convention. */
const FUNCTIONS = [
  '\\sin',
  '\\cos',
  '\\tan',
  '\\cot',
  '\\sec',
  '\\csc',
  '\\log',
  '\\ln',
  '\\exp',
  '\\lim',
  '\\max',
  '\\min',
] as const;

const OPEN_DELIMITERS = new Set(['(', '[', '\\{', '|']);
const CLOSE_DELIMITERS = new Set([')', ']', '\\}', '|']);

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

interface Token {
  readonly kind: 'command' | 'text';
  readonly value: string;
}

class LatexError extends Error {}

/** Splits the source into commands and single characters. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === '\\') {
      const match = /^\\([A-Za-z]+|[{}|,;\\ ])/u.exec(source.slice(index));
      if (match === null) throw new LatexError(`a stray backslash at position ${index}`);
      tokens.push({ kind: 'command', value: `\\${match[1] as string}` });
      index += match[0].length;
      continue;
    }

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    tokens.push({ kind: 'text', value: char });
    index += 1;
  }

  return tokens;
}

interface Parser {
  readonly tokens: readonly Token[];
  position: number;
}

function peek(parser: Parser): Token | undefined {
  return parser.tokens[parser.position];
}

function next(parser: Parser): Token {
  const token = parser.tokens[parser.position];
  if (token === undefined) throw new LatexError('the expression ends where an argument was expected');
  parser.position += 1;
  return token;
}

/** One argument: a braced group, or a single token. */
function parseArgument(parser: Parser): string {
  const token = next(parser);
  if (token.kind === 'text' && token.value === '{') {
    const inner = parseUntilClose(parser);
    return inner;
  }
  parser.position -= 1;
  return parseAtom(parser);
}

function parseUntilClose(parser: Parser): string {
  const parts: string[] = [];
  for (;;) {
    const token = peek(parser);
    if (token === undefined) throw new LatexError('an unclosed group');
    if (token.kind === 'text' && token.value === '}') {
      parser.position += 1;
      return parts.join('');
    }
    parts.push(parseNode(parser));
  }
}

/** An atom, before any script attaches to it. */
function parseAtom(parser: Parser): string {
  const token = next(parser);

  if (token.kind === 'command') {
    if (token.value === '\\frac') {
      const numerator = parseArgument(parser);
      const denominator = parseArgument(parser);
      return `<mfrac>${numerator}${denominator}</mfrac>`;
    }
    if (token.value === '\\left') {
      const open = next(parser);
      if (!OPEN_DELIMITERS.has(open.value)) throw new LatexError(`"${open.value}" is not an opening delimiter`);
      const body = parseUntilRight(parser);
      return body;
    }
    if (token.value in UNARY_WRAPPERS) {
      const argument = parseArgument(parser);
      const element = UNARY_WRAPPERS[token.value] as string;
      if (element === 'msqrt') return `<msqrt>${argument}</msqrt>`;
      const accent = token.value === '\\vec' ? '→' : '¯';
      return `<mover>${argument}<mo>${accent}</mo></mover>`;
    }
    if (token.value in SYMBOLS) {
      return `<mi>${escapeXml(SYMBOLS[token.value] as string)}</mi>`;
    }
    if (token.value in OPERATORS) {
      return `<mo>${escapeXml(OPERATORS[token.value] as string)}</mo>`;
    }
    if ((FUNCTIONS as readonly string[]).includes(token.value)) {
      return `<mi>${token.value.slice(1)}</mi>`;
    }
    if (token.value === '\\ ' || token.value === '\\,' || token.value === '\\;') {
      return '<mspace width="0.2em"/>';
    }
    if (token.value === '\\{' || token.value === '\\}') {
      return `<mo>${escapeXml(token.value.slice(1))}</mo>`;
    }
    // Refused rather than passed through: a command nobody taught the renderer
    // would reach a student as literal backslash text.
    throw new LatexError(`unsupported command "${token.value}"`);
  }

  if (token.value === '{') return `<mrow>${parseUntilClose(parser)}</mrow>`;
  if (token.value === '}') throw new LatexError('a closing brace with no group');

  if (/[0-9.]/u.test(token.value)) {
    // Digits run together into one `<mn>`, so 981 is a number and not three.
    let digits = token.value;
    for (;;) {
      const ahead = peek(parser);
      if (ahead === undefined || ahead.kind !== 'text' || !/[0-9.]/u.test(ahead.value)) break;
      digits += ahead.value;
      parser.position += 1;
    }
    return `<mn>${digits}</mn>`;
  }

  if (/[A-Za-z]/u.test(token.value)) return `<mi>${token.value}</mi>`;

  return `<mo>${escapeXml(token.value)}</mo>`;
}

function parseUntilRight(parser: Parser): string {
  const parts: string[] = [];
  for (;;) {
    const token = peek(parser);
    if (token === undefined) throw new LatexError('a \\left with no matching \\right');
    if (token.kind === 'command' && token.value === '\\right') {
      parser.position += 1;
      const close = next(parser);
      if (!CLOSE_DELIMITERS.has(close.value)) {
        throw new LatexError(`"${close.value}" is not a closing delimiter`);
      }
      return `<mrow>${parts.join('')}</mrow>`;
    }
    parts.push(parseNode(parser));
  }
}

/** An atom with whatever scripts follow it. */
function parseNode(parser: Parser): string {
  const base = parseAtom(parser);

  let subscript: string | undefined;
  let superscript: string | undefined;

  for (;;) {
    const token = peek(parser);
    if (token === undefined || token.kind !== 'text') break;
    if (token.value === '_' && subscript === undefined) {
      parser.position += 1;
      subscript = parseAtom(parser);
      continue;
    }
    if (token.value === '^' && superscript === undefined) {
      parser.position += 1;
      superscript = parseAtom(parser);
      continue;
    }
    break;
  }

  if (subscript !== undefined && superscript !== undefined) {
    return `<msubsup>${base}${subscript}${superscript}</msubsup>`;
  }
  if (subscript !== undefined) return `<msub>${base}${subscript}</msub>`;
  if (superscript !== undefined) return `<msup>${base}${superscript}</msup>`;
  return base;
}

/**
 * Converts LaTeX to a MathML fragment.
 *
 * Returns a reason rather than throwing: an unrenderable expression is a
 * publication precondition (FR-QM-14 rule 2), and a precondition that arrives
 * as an exception is one the caller handles by crashing.
 */
export function latexToMathML(latex: string): MathMLResult {
  if (latex.trim().length === 0) return { ok: false, reason: 'the expression is empty' };

  try {
    const parser: Parser = { tokens: tokenize(latex), position: 0 };
    const parts: string[] = [];
    while (parser.position < parser.tokens.length) {
      parts.push(parseNode(parser));
    }
    return { ok: true, mathml: parts.join('') };
  } catch (error) {
    if (error instanceof LatexError) return { ok: false, reason: error.message };
    throw error;
  }
}
