import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { readCode, tsFilesUnder } from './source-scan.js';

/**
 * **No path sets a password without asking the screen for it** (M8-13, M8-11).
 *
 * The strongest thing that can be checked from source is weaker than that sentence, and this file says so. It cannot follow a string through a program, and it cannot show that the
 * source the screen was given is a good one or that the list it reads is long. It checks six things that, together, leave a handler that sets a password only by going through
 * `PasswordScreen`, and no other way to write one:
 *
 *   1. **Which calls write a credential.** Read off `application/ports.ts`: a method of a `...Store` interface that takes a `StoredCredential`. Not a list written by hand, so a store
 *      method added tomorrow is covered the day it is declared. `rehash` is the one exemption, with its reason: it rewrites the hash of a password the person has just proved they hold,
 *      and sets no new one. If the exemption names a method that no longer exists, that is a violation, so the list cannot go stale.
 *   2. **Every method of a handler that makes such a call first asks the screen,** `const x = await this.deps.screen.check(...)`, and returns on `!x.ok` before the call. The order is
 *      the order in the text; a screen reached on a branch the write does not follow would pass, and review is what sees that.
 *   3. **What is hashed is what was screened.** Each `hasher.hash(` in such a method takes `x.value`, so a handler cannot screen one string and hash another.
 *   4. **No handler reads the length rules itself.** `checkPassword` is imported nowhere in the handlers: it is the screen's first step, and a handler that called it would be applying
 *      the rules without the list.
 *   5. **The composition builds the screen and gives it to every such handler.** `new PasswordScreen(` is written there, `screen` is in the shared dependencies, and each handler class
 *      that sets a password is constructed from them.
 *   6. **Nothing else writes a credential.** The store methods of (1) are called only from the handlers, and `identity.credential` is written by SQL only in the stores file.
 *
 * What stays outside: a handler that reaches a store method through an alias the names in (1) do not match; a second composition root; a database trigger or a script run by hand; a
 * method name that is also another store's (`create` is on `UserStore`, and so a call is matched on the property a handler holds the store under, `users.create(`, never on `create` alone); and
 * whether the screen's source is a source, which the simulation shows for the paths it covers by running them.
 */
export interface PasswordViolation {
  readonly rule:
    | 'M8_13_PASSWORD_SET_WITHOUT_THE_SCREEN'
    | 'M8_13_UNSCREENED_PASSWORD_REACHES_THE_HASH'
    | 'M8_13_PASSWORD_CHECKED_AROUND_THE_SCREEN'
    | 'M8_13_SCREEN_NOT_COMPOSED'
    | 'M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER'
    | 'M8_13_EXEMPTION_STALE';
  readonly file: string;
  readonly detail: string;
}

export interface PasswordScope {
  readonly ports: string;
  readonly handlers: readonly string[];
  readonly composition: string;
  /** The one file whose SQL may write `identity.credential`. */
  readonly stores: string;
  /** Every shipped file, for the rule that looks everywhere. */
  readonly shipped: readonly string[];
}

const EXEMPT: ReadonlyMap<string, string> = new Map([['rehash', 'it rewrites the hash of a password the person has just proved they hold, under newer parameters, and sets no new one']]);
const NOT_GOVERNED = [/^src\/testing\//u, /^src\/fitness\//u, /^src\/fitness-fixtures\//u, /\.spec\.ts$/u];
const posix = (path: string): string => path.split('\\').join('/');

export function defaultPasswordScope(root: string): PasswordScope {
  const shipped = tsFilesUnder(join(root, 'src')).map((file) => posix(relative(root, file))).filter((file) => !NOT_GOVERNED.some((pattern) => pattern.test(file)));
  return {
    ports: 'src/contexts/identity/application/ports.ts',
    handlers: shipped.filter((file) => file.startsWith('src/contexts/identity/application/handlers/')),
    composition: 'src/contexts/identity/public/composition.ts',
    stores: 'src/contexts/identity/infrastructure/postgres-stores.ts',
    shipped,
  };
}

const parse = (root: string, file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
const lineOf = (source: ts.SourceFile, node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** The store methods that take a credential, by the interface that declares them, from the port declarations. */
function credentialWriters(root: string, ports: string): Map<string, string[]> {
  const source = parse(root, ports);
  const found = new Map<string, string[]>();
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && /Store$/u.test(node.name.text)) {
      const methods = node.members.filter((member): member is ts.MethodSignature => ts.isMethodSignature(member) && member.parameters.some((parameter) => /\bStoredCredential\b/u.test(parameter.getText(source)))).map((member) => member.name.getText(source));
      if (methods.length > 0) found.set(node.name.text, methods);
    }
  });
  return found;
}

/**
 * The calls that write a credential in a piece of code. A method name alone would match every `create` in the tree, so a call is matched on the property a handler holds the store
 * under (`readonly users: UserStore` makes `users.create(` a write); an interface no handler holds is matched on the method name.
 */
function writeCalls(writers: Map<string, string[]>, held: Map<string, Set<string>>): (code: string) => Array<{ method: string; index: number }> {
  const patterns = [...writers].map(([iface, methods]) => {
    const names = methods.filter((method) => !EXEMPT.has(method));
    const props = [...(held.get(iface) ?? [])];
    return names.length === 0 ? null : new RegExp(`${props.length > 0 ? `\\b(?:${props.join('|')})` : ''}\\.(${names.join('|')})\\s*\\(`, 'gu');
  });
  return (code) => patterns.flatMap((pattern) => (pattern === null ? [] : [...code.matchAll(pattern)].map((match) => ({ method: match[1]!, index: match.index! }))));
}

/** The handler classes that make a call which writes a credential: the ones the rule judges. */
export function passwordSettingClasses(root: string, scope: PasswordScope = defaultPasswordScope(root)): string[] {
  const held = new Map<string, Set<string>>();
  for (const file of scope.handlers) {
    for (const match of readCode(join(root, file)).matchAll(/readonly\s+(\w+)\s*:\s*(\w+Store)\b/gu)) held.set(match[2]!, (held.get(match[2]!) ?? new Set<string>()).add(match[1]!));
  }
  const callsIn = writeCalls(credentialWriters(root, scope.ports), held);
  const names: string[] = [];
  for (const file of scope.handlers) {
    const source = parse(root, file);
    const code = readCode(join(root, file));
    source.forEachChild((node) => {
      if (ts.isClassDeclaration(node) && node.name !== undefined && callsIn(code.slice(node.getStart(source), node.getEnd())).length > 0) names.push(node.name.text);
    });
  }
  return names;
}

export function checkNoPasswordIsSetWithoutTheScreen(root: string, scope: PasswordScope = defaultPasswordScope(root)): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  const writers = credentialWriters(root, scope.ports);
  const declared = new Set([...writers.values()].flat());
  for (const exempt of EXEMPT.keys()) {
    if (!declared.has(exempt)) violations.push({ rule: 'M8_13_EXEMPTION_STALE', file: scope.ports, detail: `${exempt} is exempt from the screen but is no longer a store method that takes a credential` });
  }

  // the property each store is held under in the handlers: `readonly users: UserStore`
  const held = new Map<string, Set<string>>();
  for (const file of scope.handlers) {
    for (const match of readCode(join(root, file)).matchAll(/readonly\s+(\w+)\s*:\s*(\w+Store)\b/gu)) held.set(match[2]!, (held.get(match[2]!) ?? new Set<string>()).add(match[1]!));
  }
  const callsIn = writeCalls(writers, held);

  const setting = new Set<string>();
  for (const file of scope.handlers) {
    const source = parse(root, file);
    const code = readCode(join(root, file));
    source.forEachChild(function visit(node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'checkPassword') {
        violations.push({ rule: 'M8_13_PASSWORD_CHECKED_AROUND_THE_SCREEN', file, detail: `line ${lineOf(source, node)}: a handler calls checkPassword; the length rules are the first step of the screen and are applied there` });
      }
      ts.forEachChild(node, visit);
    });
    const insideAMethod: Array<[number, number]> = [];
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) return;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || member.body === undefined) continue;
        insideAMethod.push([member.getStart(source), member.getEnd()]);
        const body = code.slice(member.body.getStart(source), member.body.getEnd());
        const firstWrite = callsIn(body).sort((a, b) => a.index - b.index)[0];
        if (firstWrite === undefined) continue;
        setting.add(node.name.text);
        const asked = /const\s+(\w+)\s*=\s*await\s+this\.deps\.screen\.check\s*\(/u.exec(body);
        const where = `${node.name.text}.${member.name.getText(source)}, line ${lineOf(source, member)}`;
        if (asked === null || asked.index > firstWrite.index || !new RegExp(`if\\s*\\(\\s*!\\s*${asked[1]}\\.ok\\s*\\)`, 'u').test(body.slice(asked.index, firstWrite.index))) {
          violations.push({ rule: 'M8_13_PASSWORD_SET_WITHOUT_THE_SCREEN', file, detail: `${where}: calls ${firstWrite.method} without first asking the screen and returning on a refusal` });
          continue;
        }
        for (const hashed of body.matchAll(/\.hasher\.hash\s*\(\s*([^)]*)\)/gu)) {
          if (!hashed[1]!.trim().startsWith(`${asked[1]}.value`)) {
            violations.push({ rule: 'M8_13_UNSCREENED_PASSWORD_REACHES_THE_HASH', file, detail: `${where}: hashes ${hashed[1]!.trim()}, which is not what the screen returned (${asked[1]}.value)` });
          }
        }
      }
    });
    // comments are blanked in place, so an offset in the code is the same offset in the source
    for (const call of callsIn(code)) {
      if (!insideAMethod.some(([start, end]) => call.index >= start && call.index < end)) violations.push({ rule: 'M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER', file, detail: `${call.method} is called outside a handler's method` });
    }
  }

  const composition = readCode(join(root, scope.composition));
  if (!/\bscreen\s*=\s*new\s+PasswordScreen\s*\(/u.test(composition)) violations.push({ rule: 'M8_13_SCREEN_NOT_COMPOSED', file: scope.composition, detail: 'the composition does not build a PasswordScreen' });
  if (!/\bcommon\s*=\s*\{[^}]*\bscreen\b/u.test(composition)) violations.push({ rule: 'M8_13_SCREEN_NOT_COMPOSED', file: scope.composition, detail: 'the dependencies the handlers share do not include the screen' });
  for (const name of setting) {
    if (!new RegExp(`new\\s+${name}\\s*\\(\\s*\\{\\s*\\.\\.\\.common\\b`, 'u').test(composition)) {
      violations.push({ rule: 'M8_13_SCREEN_NOT_COMPOSED', file: scope.composition, detail: `${name} sets a password and is not constructed from the shared dependencies that carry the screen` });
    }
  }

  const handlerFiles = new Set(scope.handlers);
  for (const file of scope.shipped) {
    if (handlerFiles.has(file) || file === scope.ports || file === scope.stores) continue;
    const code = readCode(join(root, file));
    for (const call of callsIn(code)) violations.push({ rule: 'M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER', file, detail: `calls ${call.method}, which writes a credential, outside the handlers` });
    if (/\b(?:INSERT\s+INTO|UPDATE)\s+identity\.credential\b/iu.test(code)) violations.push({ rule: 'M8_13_CREDENTIAL_WRITTEN_OUTSIDE_A_HANDLER', file, detail: 'writes identity.credential in SQL outside the stores file' });
  }
  return violations;
}
