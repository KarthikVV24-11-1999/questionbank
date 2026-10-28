import { join } from 'node:path';
import { readCode, tsFilesUnder } from './source-scan.js';

/**
 * The handlers a context has, read from the `policy(...)` declarations in its handler directory (M7-51, DEC-M7-26).
 *
 * A handler cannot run without a policy (`authorize` takes one), so the declaration is the one place each handler already names
 * itself exhaustively. Learning has no `HandlerRegistry`, and one added only to be enumerated would be a second list free to
 * drift from the first. Reading the source is the precedent `source-scan.ts` set for a gate's subject.
 *
 * Only a literal declaration is understood — `policy('Name', [ROLES.x], true)`. A declaration of any other shape (a computed
 * name, a spread of roles) would be a handler this scan cannot see, so `unreadableDeclarations` counts the `policy(` calls the
 * literal pattern did not account for and the contract fails on a non-zero count rather than undercounting.
 */
export interface DeclaredPolicy {
  readonly name: string;
  /** The `ROLES` keys named, in order, e.g. `learner`. */
  readonly roles: readonly string[];
  readonly requiresStepUp: boolean;
}

const LITERAL = /\bpolicy\(\s*'(\w+)'\s*,\s*\[([^\]]*)\]\s*(?:,\s*(true|false)\s*)?,?\s*\)/gu;
const ANY_CALL = /(?<![.\w])policy\(/gu;
const ROLE = /ROLES\.(\w+)/gu;

export function policiesDeclaredIn(source: string): { readonly declared: DeclaredPolicy[]; readonly unreadableDeclarations: number } {
  const declared = [...source.matchAll(LITERAL)].map((match) => ({
    name: match[1] as string,
    roles: [...(match[2] as string).matchAll(ROLE)].map((role) => role[1] as string),
    requiresStepUp: match[3] === 'true',
  }));
  const calls = [...source.matchAll(ANY_CALL)].length;
  return { declared, unreadableDeclarations: calls - declared.length };
}

/** Every policy declared by a non-spec module under `handlersDirectory`, with the count the literal pattern could not read. */
export function policiesUnder(handlersDirectory: string): { readonly declared: DeclaredPolicy[]; readonly unreadableDeclarations: number } {
  const found = tsFilesUnder(handlersDirectory).map((file) => policiesDeclaredIn(readCode(file)));
  return {
    declared: found.flatMap((entry) => entry.declared),
    unreadableDeclarations: found.reduce((sum, entry) => sum + entry.unreadableDeclarations, 0),
  };
}

export const LEARNING_HANDLERS_DIRECTORY = (srcRoot: string): string => join(srcRoot, 'contexts', 'learning', 'application', 'handlers');
