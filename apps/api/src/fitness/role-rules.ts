import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { ROLES, ROLE_KEYS, ROLE_VALUES } from '../platform/auth/roles.js';
import { importsOf, readCode } from './source-scan.js';

/**
 * **M5-36 — a policy names a role from the vocabulary, or the build fails.**
 *
 * Roles were bare strings. A typo in one yields a role nothing holds, so the
 * policy authorizes nobody and the feature quietly never works — failing closed,
 * which is correct and therefore invisible. This rule makes the two mistakes
 * loud: a bare string where a role belongs, and a name `ROLES` does not have.
 *
 * **What a role position is**, decided syntactically so the rule needs no type
 * information and runs on a fixture as well as on the real tree:
 *
 *   - the second argument of a call to `policy(…)`, followed through any
 *     constant it names — in the same file or one it imports by a relative path —
 *     and through spreads, `Object.freeze(…)` and `as const`;
 *   - the value of a `roleContext:` property;
 *   - a role value compared with `===`/`!==` against a role-named operand, or
 *     passed to `includes`/`indexOf` on a role-named receiver.
 *
 * In any of them the only acceptable leaf is `ROLES.<key>` with a key the
 * vocabulary has. A string literal is a violation, and when it is also not a
 * role at all the message says so, because that is the typo.
 *
 * Governed: the application and API layers of every context. The domain imports
 * nothing and so cannot import the vocabulary (F2); its one role-valued constant
 * is held to the vocabulary by a spec instead.
 */

export interface RoleViolation {
  readonly rule: 'M5_36_BARE_ROLE_STRING' | 'M5_36_UNKNOWN_ROLE' | 'M5_36_ROLE_NOT_FROM_THE_VOCABULARY' | 'M5_36_CONTEXT_REACHES_PAST_THE_VOCABULARY';
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface RoleLiteral {
  readonly file: string;
  readonly line: number;
  /** Offsets in the file's source, for the substitution to replace exactly this literal. */
  readonly start: number;
  readonly end: number;
  readonly value: string;
  /** The `ROLES` key it should read as, when the value is a role; absent for a typo. */
  readonly key?: string;
}

const KEY_BY_VALUE = new Map<string, string>(ROLE_KEYS.map((key) => [ROLES[key], key] as const));

/** Source files under a directory, as paths relative to `root`. */
function tsFilesUnder(root: string, directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, directory));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${directory}/${entry}`;
    return statSync(join(root, path)).isDirectory() ? tsFilesUnder(root, path) : /\.tsx?$/u.test(path) ? [path] : [];
  });
}

const SOURCE_EXTENSIONS = /\.[jt]sx?$/u;

/** Parsed once per file per run; the walk revisits imported modules often. */
const PARSED = new Map<string, ts.SourceFile | undefined>();
function parse(path: string): ts.SourceFile | undefined {
  if (!PARSED.has(path)) {
    PARSED.set(path, existsSync(path) ? ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true) : undefined);
  }
  return PARSED.get(path);
}

function isCall(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'Object' &&
      current.expression.name.text === 'freeze' &&
      current.arguments.length === 1
    ) {
      current = current.arguments[0] as ts.Expression;
    } else return current;
  }
}

/** The initializer of a top-level `const NAME`, in this file or in a module it imports by relative path. */
function resolveConstant(name: string, source: ts.SourceFile): { initializer: ts.Expression; file: ts.SourceFile } | undefined {
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
          return { initializer: declaration.initializer, file: source };
        }
      }
    }
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings)) {
      const imported = statement.importClause.namedBindings.elements.find((element) => element.name.text === name);
      const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '';
      if (imported !== undefined && specifier.startsWith('.')) {
        const target = parse(resolve(dirname(source.fileName), specifier.replace(SOURCE_EXTENSIONS, '.ts')));
        return target === undefined ? undefined : resolveConstant((imported.propertyName ?? imported.name).text, target);
      }
    }
  }
  return undefined;
}

interface Finding {
  readonly node: ts.Node;
  readonly file: ts.SourceFile;
  readonly kind: 'bare' | 'not-vocabulary' | 'unknown-key';
  readonly value?: string;
}

/** Everything in a role expression that is not `ROLES.<known key>`. */
function problemsIn(expr: ts.Expression, file: ts.SourceFile, seen: Set<string>): Finding[] {
  const node = unwrap(expr);

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) => problemsIn(ts.isSpreadElement(element) ? element.expression : element, file, seen));
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [{ node, file, kind: 'bare', value: node.text }];
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(unwrap(node.expression)) && unwrap(node.expression).getText() === 'ROLES') {
    return (ROLE_KEYS as readonly string[]).includes(node.name.text) ? [] : [{ node, file, kind: 'unknown-key', value: node.name.text }];
  }
  if (ts.isIdentifier(node)) {
    const marker = `${file.fileName}#${node.text}`;
    if (seen.has(marker)) return [];
    seen.add(marker);
    const resolved = resolveConstant(node.text, file);
    // A forwarded parameter is not a literal anybody wrote; the call that supplies it is the position that matters.
    return resolved === undefined ? [] : problemsIn(resolved.initializer, resolved.file, seen);
  }
  return [{ node, file, kind: 'not-vocabulary' }];
}

const ROLE_NAMED = /role/iu;
const textOf = (node: ts.Node): string => node.getText();

/**
 * One finding per literal. A constant several policies share is reached once per
 * policy that names it; the literal is one place in one file, and is reported
 * (and, by the substitution, replaced) once.
 */
function distinct(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.file.fileName}:${finding.node.getStart(finding.file)}:${finding.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every role-position problem in one parsed file. */
function findingsIn(source: ts.SourceFile): Finding[] {
  return distinct(rawFindingsIn(source));
}

function rawFindingsIn(source: ts.SourceFile): Finding[] {
  const found: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (isCall(node, 'policy') && node.arguments.length >= 2) {
      found.push(...problemsIn(node.arguments[1] as ts.Expression, source, new Set()));
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'roleContext') {
      found.push(...problemsIn(node.initializer, source, new Set()));
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      for (const [literal, other] of [[node.left, node.right], [node.right, node.left]] as const) {
        if (ts.isStringLiteral(literal) && ROLE_NAMED.test(textOf(other)) && !textOf(other).includes('ROLES')) {
          found.push({ node: literal, file: source, kind: 'bare', value: literal.text });
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['includes', 'indexOf'].includes(node.expression.name.text) &&
      ROLE_NAMED.test(textOf(node.expression.expression))
    ) {
      for (const argument of node.arguments) if (ts.isStringLiteral(argument)) found.push({ node: argument, file: source, kind: 'bare', value: argument.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function lineOf(finding: Finding): number {
  return finding.file.getLineAndCharacterOfPosition(finding.node.getStart(finding.file)).line + 1;
}

/** The files the rule governs: every context's application and API layers, specs excluded. */
export function governedRoleFiles(root: string): string[] {
  return tsFilesUnder(root, 'src/contexts').filter(
    (file) => /\/contexts\/[^/]+\/(application|api)\//u.test(`/${file}`) && !/\.spec\.tsx?$/u.test(file),
  );
}

function describe(finding: Finding): { rule: RoleViolation['rule']; message: string } {
  if (finding.kind === 'unknown-key') {
    return { rule: 'M5_36_UNKNOWN_ROLE', message: `ROLES.${finding.value} is not in the vocabulary; the roles are ${ROLE_KEYS.join(', ')}` };
  }
  if (finding.kind === 'bare') {
    const isRole = KEY_BY_VALUE.has(finding.value as string);
    return isRole
      ? { rule: 'M5_36_BARE_ROLE_STRING', message: `the role "${finding.value}" is written as a string; write ROLES.${KEY_BY_VALUE.get(finding.value as string)}` }
      : { rule: 'M5_36_UNKNOWN_ROLE', message: `"${finding.value}" is not a role — a typo here authorizes nobody, silently; the roles are ${ROLE_VALUES.join(', ')}` };
  }
  return { rule: 'M5_36_ROLE_NOT_FROM_THE_VOCABULARY', message: 'a role position holds something that is not ROLES.<key>' };
}

export function checkRoleVocabulary(root: string, options: { readonly files?: readonly string[] } = {}): RoleViolation[] {
  const files = options.files ?? governedRoleFiles(root);
  // A literal is reported where it is written, which is not always the file whose policy reached it.
  const seen = new Set<string>();
  return files.flatMap((file) => {
    const source = parse(join(root, file));
    if (source === undefined) return [];
    return findingsIn(source).flatMap((finding) => {
      const violation = { file: relative(root, finding.file.fileName).split('\\').join('/'), line: lineOf(finding), ...describe(finding) };
      const key = `${violation.file}:${violation.line}:${violation.message}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [violation];
    });
  });
}

/** Every bare role-valued literal in a role position, with where it sits — what the mechanical substitution replaces. */
export function bareRoleLiterals(root: string, files: readonly string[] = governedRoleFiles(root)): RoleLiteral[] {
  return files.flatMap((file) => {
    const source = parse(join(root, file));
    if (source === undefined) return [];
    return findingsIn(source)
      .filter((finding): finding is Finding & { value: string } => finding.kind === 'bare' && finding.file === source)
      .map((finding) => ({
        file,
        line: lineOf(finding),
        start: finding.node.getStart(source),
        end: finding.node.getEnd(),
        value: finding.value,
        ...(KEY_BY_VALUE.has(finding.value) ? { key: KEY_BY_VALUE.get(finding.value) as string } : {}),
      }));
  });
}

/**
 * **A context reaches `platform/` for the role vocabulary and nothing else.**
 * A new direction of dependency is worth being narrow: the day a context imports
 * the composition root, or the config, the layering is gone. ADR-0026.
 */
export function checkContextsImportOnlyTheVocabularyFromPlatform(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): RoleViolation[] {
  const files = options.files ?? tsFilesUnder(root, 'src/contexts').filter((file) => !/\.spec\.tsx?$/u.test(file));
  const violations: RoleViolation[] = [];
  for (const file of files) {
    for (const specifier of importsOf(readCode(join(root, file)))) {
      if (!specifier.startsWith('.')) continue;
      const target = relative(root, resolve(root, dirname(file), specifier)).replaceAll('\\', '/');
      if (target.startsWith('src/platform/') && target.replace(SOURCE_EXTENSIONS, '') !== 'src/platform/auth/roles') {
        violations.push({
          rule: 'M5_36_CONTEXT_REACHES_PAST_THE_VOCABULARY',
          file,
          line: 0,
          message: `${file} imports ${specifier}; a context may import only platform/auth/roles from platform (ADR-0026)`,
        });
      }
    }
  }
  return violations;
}
