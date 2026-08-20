/**
 * Stands in for a domain module reaching for a builtin that is not on
 * `PURE_NODE_BUILTINS` — `node:fs` reads the filesystem, which is exactly the
 * I/O §9 rule 2 forbids in the domain layer. Proves the rule does not exempt
 * every `node:` import, only the enumerated, pure ones.
 */
import { readFileSync } from 'node:fs';

export const plantedImpureBuiltin = readFileSync;
