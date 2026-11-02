import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { readCode, tsFilesUnder } from './source-scan.js';

/**
 * **No route that costs a password derive is reachable without passing the limiter, and no derive runs outside the bound** (M8-10, NFR SEC-09).
 *
 * The strongest thing that can be checked from source is weaker than that sentence, and this file says so. It cannot show that a limit's numbers are sane, that the limiter was
 * given a working store, or what a deployed process was composed with. It checks four things that, together, leave no route that derives and no way to derive that skips either:
 *
 *   1. **Which handlers derive.** A handler class in identity's `application/handlers` that calls `hasher.hash` or `hasher.verify` is a deriving handler. The composition root maps each
 *      handler name to its class, so a route's handler can be traced to whether it derives without a list written by hand that could go stale.
 *   2. **Every route whose handler derives names a limit.** In identity's controller each `this.run(...)` call passes the limit it is subject to, and for a deriving handler that argument
 *      is not `null` and not left out. A route added tomorrow that calls a deriving handler with `null` fails here.
 *   3. **The hasher the handlers get is the bounded one.** The composition builds it as `new BoundedPasswordHasher(...)`, and `new ScryptPasswordHasher(` is written nowhere else in shipped
 *      code, so the bound cannot be walked round by constructing the plain one.
 *   4. **Nothing else derives.** `scrypt` and its relatives are imported from `node:crypto` only by the hasher's own file.
 *
 * What stays outside: a handler that derives through some other primitive the list in (4) does not name; a controller in another context that is handed identity's handlers (the
 * context-list gates keep identity's door shut, and `public/index.ts` exports nothing); and whether the limit named on a route is a sensible one, which `abuse-simulation.integration.spec.ts` shows
 * for the routes it covers by running them.
 */
export interface AbuseViolation {
  readonly rule: 'M8_10_DERIVING_ROUTE_UNLIMITED' | 'M8_10_HANDLER_NOT_FOUND' | 'M8_10_HASHER_NOT_BOUNDED' | 'M8_10_DERIVE_OUTSIDE_THE_HASHER';
  readonly file: string;
  readonly detail: string;
}

export interface AbuseScope {
  readonly controller: string;
  readonly handlers: readonly string[];
  readonly composition: string;
  /** Every shipped file, for the two rules that look everywhere. */
  readonly shipped: readonly string[];
}

const HASHER_FILE = 'src/contexts/identity/infrastructure/scrypt-password-hasher.ts';
const NOT_GOVERNED = [/^src\/testing\//u, /^src\/fitness\//u, /^src\/fitness-fixtures\//u, /\.spec\.ts$/u];
const DERIVE_PRIMITIVES = /import\s*\{[^}]*\b(scrypt|scryptSync|pbkdf2|pbkdf2Sync)\b[^}]*\}\s*from\s*['"](?:node:)?crypto['"]/u;
const posix = (path: string): string => path.split('\\').join('/');

export function defaultAbuseScope(root: string): AbuseScope {
  const shipped = tsFilesUnder(join(root, 'src')).map((file) => posix(relative(root, file))).filter((file) => !NOT_GOVERNED.some((pattern) => pattern.test(file)));
  return {
    controller: 'src/contexts/identity/api/identity.controller.ts',
    handlers: shipped.filter((file) => file.startsWith('src/contexts/identity/application/handlers/')),
    composition: 'src/contexts/identity/public/composition.ts',
    shipped,
  };
}

const parse = (root: string, file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);

function derivingClasses(root: string, handlers: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of handlers) {
    const source = parse(root, file);
    source.forEachChild(function visit(node): void {
      if (ts.isClassDeclaration(node) && node.name !== undefined && /\.hasher\.(hash|verify)\s*\(/u.test(node.getText(source))) found.add(node.name.text);
      ts.forEachChild(node, visit);
    });
  }
  return found;
}

/** `{ register: new RegisterHandler(...) }` in the composition: handler name -> class name. */
function handlerClasses(root: string, composition: string): Map<string, string> {
  const source = parse(root, composition);
  const found = new Map<string, string>();
  source.forEachChild(function visit(node): void {
    if (ts.isPropertyAssignment(node) && ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && /Handler$/u.test(node.initializer.expression.text)) {
      found.set(node.name.getText(source), node.initializer.expression.text);
    }
    ts.forEachChild(node, visit);
  });
  return found;
}

/** The position of `limit` among `run`'s arguments: response, headers, handler, input, success, as, limit, ip. */
const LIMIT_ARGUMENT = 6;

export function checkDerivesAreBoundedAndLimited(root: string, scope: AbuseScope = defaultAbuseScope(root)): AbuseViolation[] {
  const violations: AbuseViolation[] = [];
  const deriving = derivingClasses(root, scope.handlers);
  const classes = handlerClasses(root, scope.composition);

  const controller = parse(root, scope.controller);
  controller.forEachChild(function visit(node): void {
    if (ts.isCallExpression(node) && node.expression.getText(controller) === 'this.run') {
      const handler = /^this\.handlers\.(\w+)$/u.exec(node.arguments[2]?.getText(controller) ?? '')?.[1];
      const limit = node.arguments[LIMIT_ARGUMENT];
      const unlimited = limit === undefined || limit.kind === ts.SyntaxKind.NullKeyword;
      const line = controller.getLineAndCharacterOfPosition(node.getStart(controller)).line + 1;
      if (handler === undefined || !classes.has(handler)) {
        violations.push({ rule: 'M8_10_HANDLER_NOT_FOUND', file: scope.controller, detail: `line ${line}: a route's handler could not be traced to a class in the composition, so whether it derives is not known` });
      } else if (unlimited && deriving.has(classes.get(handler)!)) {
        violations.push({ rule: 'M8_10_DERIVING_ROUTE_UNLIMITED', file: scope.controller, detail: `line ${line}: the route for ${handler} (${classes.get(handler)}) derives a password hash and names no limit` });
      }
    }
    ts.forEachChild(node, visit);
  });

  if (!/\bhasher:\s*new\s+BoundedPasswordHasher\s*\(/u.test(readCode(join(root, scope.composition)))) {
    violations.push({ rule: 'M8_10_HASHER_NOT_BOUNDED', file: scope.composition, detail: 'the hasher the handlers are given is not built as new BoundedPasswordHasher(...)' });
  }
  for (const file of scope.shipped) {
    const code = readCode(join(root, file));
    if (file !== HASHER_FILE && /\bnew\s+ScryptPasswordHasher\s*\(/u.test(code) && !/\bnew\s+BoundedPasswordHasher\s*\(\s*[^)]*new\s+ScryptPasswordHasher/u.test(code.replace(/\s+/gu, ' '))) {
      violations.push({ rule: 'M8_10_HASHER_NOT_BOUNDED', file, detail: 'builds a ScryptPasswordHasher that is not handed straight to the bounded one' });
    }
    if (file !== HASHER_FILE && DERIVE_PRIMITIVES.test(code)) {
      violations.push({ rule: 'M8_10_DERIVE_OUTSIDE_THE_HASHER', file, detail: 'imports a key derivation function from node:crypto; derives belong to the hasher, which the bound wraps' });
    }
  }
  return violations;
}
