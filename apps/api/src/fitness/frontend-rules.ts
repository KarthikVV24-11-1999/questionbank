import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './source-scan.js';

/**
 * Fitness functions over the frontend workspaces (`apps/studio`,
 * `packages/*`), run from `apps/api`'s own fitness suite the way every other
 * F-numbered gate in this repository is — one implementation, run in CI
 * (DEC-M0-3). `root` here is the **repository root**, not the API project
 * root, since these rules reach outside `apps/api` on purpose.
 *
 *   F15 — no hand-written API call; everything through the generated client (M0-17)
 *   F24 — no colour literal outside the token layer (§9 rule 16, M0-18)
 */
export interface HandwrittenFetchViolation {
  readonly rule: 'F15_HANDWRITTEN_FETCH';
  readonly file: string;
}

const FETCH_PATTERN = /\bfetch\s*\(|\bXMLHttpRequest\b/u;

/**
 * The one file allowed to call `fetch` — everything else reaches the network
 * through the client it builds. Paths are relative to the repository root.
 */
export const HANDWRITTEN_FETCH_ALLOWLIST = ['packages/contracts/src/client.ts'] as const;

const DEFAULT_INCLUDES = ['apps/studio/src', 'packages/contracts/src', 'packages/content-renderer/src'];
const DEFAULT_EXCLUDES = [/\.spec\.tsx?$/u, /^apps\/studio\/src\/testing\//u];

function walk(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * `root` is the repository root (absolute). Overridable `include` is what
 * lets a planted-fixture spec point this at a fixture tree instead of the
 * real frontend source, and is also what proves the scan itself is not
 * vacuous — a non-empty file count is asserted by the caller, not by this
 * function's return value alone.
 */
export function checkNoHandwrittenFetch(
  root: string,
  options: {
    readonly include?: readonly string[];
    readonly allowlist?: readonly string[];
    readonly excludePatterns?: readonly RegExp[];
  } = {},
): { readonly violations: readonly HandwrittenFetchViolation[]; readonly scannedFiles: number } {
  const includes = options.include ?? DEFAULT_INCLUDES;
  const allowlist = options.allowlist ?? HANDWRITTEN_FETCH_ALLOWLIST;
  const excludes = options.excludePatterns ?? DEFAULT_EXCLUDES;

  const files = includes
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)))
    .filter((file) => !allowlist.includes(file));

  const violations: HandwrittenFetchViolation[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(root, file), 'utf8'));
    if (FETCH_PATTERN.test(code)) {
      violations.push({ rule: 'F15_HANDWRITTEN_FETCH', file });
    }
  }
  return { violations, scannedFiles: files.length };
}

export interface ColorLiteralViolation {
  readonly rule: 'F24_COLOR_LITERAL';
  readonly file: string;
}

/**
 * The closed set of modules permitted to name a colour value — the token
 * layer itself. Paths are relative to the repository root. A module added to
 * this list is a reviewed diff; a new token file that skips this list still
 * fails the check.
 */
export const COLOR_TOKEN_MODULES = [
  'apps/studio/src/tokens.ts',
  'packages/content-renderer/src/tokens.ts',
] as const;

const HEX_OR_FUNCTIONAL_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/u;

/**
 * CSS Level 3's named colours (the full keyword list minus `transparent` and
 * `currentColor`, which are not a *colour choice* the way `crimson` is).
 * Matched only when quoted immediately after a colour-shaped CSS property
 * key — `color: 'crimson'`, never a bare word — so a stimulus about gold
 * foil or a silver nitrate precipitate never trips this scan. That scoping
 * is deliberate: a blanket word match over source that authors exam content
 * in the sciences would be a false positive machine, not a gate.
 */
const CSS_NAMED_COLORS = [
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque','black','blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue','chartreuse','chocolate','coral','cornflowerblue','cornsilk','crimson','cyan','darkblue','darkcyan','darkgoldenrod','darkgray','darkgreen','darkgrey','darkkhaki','darkmagenta','darkolivegreen','darkorange','darkorchid','darkred','darksalmon','darkseagreen','darkslateblue','darkslategray','darkslategrey','darkturquoise','darkviolet','deeppink','deepskyblue','dimgray','dimgrey','dodgerblue','firebrick','floralwhite','forestgreen','fuchsia','gainsboro','ghostwhite','gold','goldenrod','gray','green','greenyellow','grey','honeydew','hotpink','indianred','indigo','ivory','khaki','lavender','lavenderblush','lawngreen','lemonchiffon','lightblue','lightcoral','lightcyan','lightgoldenrodyellow','lightgray','lightgreen','lightgrey','lightpink','lightsalmon','lightseagreen','lightskyblue','lightslategray','lightslategrey','lightsteelblue','lightyellow','lime','limegreen','linen','magenta','maroon','mediumaquamarine','mediumblue','mediumorchid','mediumpurple','mediumseagreen','mediumslateblue','mediumspringgreen','mediumturquoise','mediumvioletred','midnightblue','mintcream','mistyrose','moccasin','navajowhite','navy','oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod','palegreen','paleturquoise','palevioletred','papayawhip','peachpuff','peru','pink','plum','powderblue','purple','rebeccapurple','red','rosybrown','royalblue','saddlebrown','salmon','sandybrown','seagreen','seashell','sienna','silver','skyblue','slateblue','slategray','slategrey','snow','springgreen','steelblue','tan','teal','thistle','tomato','turquoise','violet','wheat','white','whitesmoke','yellow','yellowgreen',
] as const;

const NAMED_COLOR_ALTERNATION = CSS_NAMED_COLORS.join('|');
const NAMED_COLOR_IN_STYLE_CONTEXT_PATTERN = new RegExp(
  `\\b(?:color|background|background-color|border-color|fill|stroke|outline-color)\\s*:\\s*['"\`](?:${NAMED_COLOR_ALTERNATION})\\b`,
  'iu',
);

const COLOR_DEFAULT_EXCLUDES = [/\.spec\.tsx?$/u, /^apps\/studio\/src\/testing\//u];

/**
 * `root` is the repository root (absolute). See `checkNoHandwrittenFetch` for
 * why `include`/`allowlist` are overridable, and why the scanned-file count
 * is returned rather than only the violation list.
 */
export function checkNoColorLiterals(
  root: string,
  options: {
    readonly include?: readonly string[];
    readonly tokenModules?: readonly string[];
    readonly excludePatterns?: readonly RegExp[];
  } = {},
): { readonly violations: readonly ColorLiteralViolation[]; readonly scannedFiles: number } {
  const includes = options.include ?? DEFAULT_INCLUDES;
  const tokenModules = options.tokenModules ?? COLOR_TOKEN_MODULES;
  const excludes = options.excludePatterns ?? COLOR_DEFAULT_EXCLUDES;

  const files = includes
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)))
    .filter((file) => !tokenModules.includes(file));

  const violations: ColorLiteralViolation[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(root, file), 'utf8'));
    if (HEX_OR_FUNCTIONAL_COLOR_PATTERN.test(code) || NAMED_COLOR_IN_STYLE_CONTEXT_PATTERN.test(code)) {
      violations.push({ rule: 'F24_COLOR_LITERAL', file });
    }
  }
  return { violations, scannedFiles: files.length };
}
