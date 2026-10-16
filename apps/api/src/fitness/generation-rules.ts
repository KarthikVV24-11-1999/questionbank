import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { contextOf, resolveImport } from './boundary-rules.js';
import { KEY_BEARING_FIELDS } from './content-rules.js';
import { importsOf, readCode } from './source-scan.js';

/**
 * **Generation is downstream of Content, and nothing points back** (ADR-0025).
 *
 * `generation` reaches `content` through `content/public/` and issues the same
 * authoring command a human author's draft goes through. Content does not know
 * generation exists — no import, no handler reading `ai.*`, no second queue.
 * That direction is what lets `content` stay deployable with no AI anywhere in
 * the picture, and it is what SEC-20 leans on: the AI service holds no
 * capability to write Content aggregates, so a successful prompt injection has
 * nothing to reach.
 *
 * F1 already checks that cross-context imports go through a barrel. It says
 * nothing about **direction** — `content` importing `generation/public/` would
 * satisfy F1 and still be the coupling this rule exists to prevent. Hence a
 * separate rule rather than a widened one.
 *
 * **Status: governing a real context** (M5 Track A). `contexts/generation/`
 * exists, so the clean-tree assertion is no longer the `no subject` posture
 * F26 takes for the attempt engine. The planted fixture is still what keeps the
 * rule non-vacuous — a rule that has only ever run against a clean tree is not
 * proven by that tree being clean.
 */
export interface GenerationViolation {
  readonly rule: 'GENERATION_IS_DOWNSTREAM_ONLY' | 'GENERATION_REACHES_CONTENT_ONLY_AS_BARREL_TYPES' | 'F27_GENERATION_TOUCHES_CONTENT_TABLES'
    | 'M5_20_EVENT_CARRIES_CONTENT'
    | 'M5_20_HANDLER_INVENTS_ENVELOPE';
  readonly file: string;
  readonly importPath: string;
  readonly message: string;
}

export const GENERATION_CONTEXT = 'generation';

const GENERATION_PREFIX = `src/contexts/${GENERATION_CONTEXT}/`;

/**
 * `platform/composition/` is not covered, and the omission is deliberate: the
 * composition root imports every context's `public/composition.js` by design
 * (DEC-M0-5), which is how generation gets wired at all. This rule governs
 * *bounded contexts* reaching sideways, never the root that composes them.
 */
const CONTEXTS_ROOT = 'src/contexts';

function tsFilesUnder(root: string, directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, directory));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${directory}/${entry}`;
    return statSync(join(root, path)).isDirectory()
      ? tsFilesUnder(root, path)
      : path.endsWith('.ts') || path.endsWith('.tsx')
        ? [path]
        : [];
  });
}

/** Every context file that is not generation's own — the files this rule governs. */
export function upstreamContextFiles(root: string): string[] {
  return tsFilesUnder(root, CONTEXTS_ROOT).filter((file) => contextOf(file) !== GENERATION_CONTEXT);
}

export function checkGenerationIsDownstreamOnly(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files = options.files ?? upstreamContextFiles(root);
  const violations: GenerationViolation[] = [];

  for (const file of files) {
    for (const importPath of importsOf(readCode(join(root, file)))) {
      const resolved = resolveImport(file, importPath, root);
      const reachesGeneration =
        resolved?.startsWith(GENERATION_PREFIX) === true ||
        // A non-relative specifier cannot resolve to a path, so it is matched
        // on its text. Nothing in this repository publishes generation as a
        // package today; this catches the day something tries.
        /(^|\/)contexts\/generation\//u.test(importPath);

      if (reachesGeneration) {
        violations.push({
          rule: 'GENERATION_IS_DOWNSTREAM_ONLY',
          file,
          importPath,
          message: `${file} imports ${importPath}; generation is downstream of content and nothing may point back (ADR-0025)`,
        });
      }
    }
  }

  return violations;
}

const CONTENT_BARREL = 'src/contexts/content/public/index';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Every file in generation, specs included: a test that reaches past the barrel is the same coupling. */
export function generationFiles(root: string): string[] {
  return tsFilesUnder(root, `${CONTEXTS_ROOT}/${GENERATION_CONTEXT}`);
}

/**
 * **The other half of ADR-0025: what generation may take from content.**
 *
 * `checkGenerationIsDownstreamOnly` stops content pointing at generation. This
 * stops generation reaching further into content than the one door content
 * built for it. Two conditions, both of which F1 alone would allow:
 *
 *   - the barrel only — F1 already insists on that for any cross-context
 *     import, restated here so this rule is complete on its own;
 *   - **as types, never as values.** Generation names content's commands; it
 *     does not call, construct or run anything of content's. Running content's
 *     handlers is the composition root's job, which is what lets SEC-20 hold:
 *     the AI service has no capability to write a content aggregate because
 *     there is no content code in it to write with.
 */
export function checkGenerationReachesContentOnlyAsBarrelTypes(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files = options.files ?? generationFiles(root);
  const violations: GenerationViolation[] = [];

  for (const file of files) {
    const code = readCode(join(root, file));
    for (const importPath of importsOf(code)) {
      const resolved = resolveImport(file, importPath, root);
      if (resolved === null || contextOf(resolved) !== 'content') continue;

      if (resolved.replace(/\.[jt]sx?$/u, '') !== CONTENT_BARREL) {
        violations.push({
          rule: 'GENERATION_REACHES_CONTENT_ONLY_AS_BARREL_TYPES',
          file,
          importPath,
          message: `${file} imports ${importPath}, past content's barrel; generation may reach content only through content/public/ (ADR-0025)`,
        });
        continue;
      }

      // Every statement that names the barrel is judged on its own: a type
      // import of the same path elsewhere in the file must not excuse a value
      // import, and a `require`, dynamic `import()` or bare side-effect import
      // has no `from` clause at all, so it is counted as the value it is.
      const quoted = `['"]${escapeRegExp(importPath)}['"]`;
      const statements = [...code.matchAll(new RegExp(`(?:import|export)\\b[^;]*?\\bfrom\\s+${quoted}`, 'gu'))];
      const mentions = [...code.matchAll(new RegExp(quoted, 'gu'))].length;
      const allTypes = statements.every((statement) => /^(?:import|export)\s+type\b/u.test(statement[0]));
      if (!allTypes || mentions > statements.length) {
        violations.push({
          rule: 'GENERATION_REACHES_CONTENT_ONLY_AS_BARREL_TYPES',
          file,
          importPath,
          message: `${file} imports content's barrel as a value; generation may take only types from it, and the composition root runs content (ADR-0025, SEC-20)`,
        });
      }
    }
  }

  return violations;
}

/** A statement naming a `content.` table, in any verb that reads or writes one. */
const CONTENT_TABLE_STATEMENT = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|FROM|JOIN)\s+content\.\w+/iu;

/**
 * **F27: no code path in generation touches a `content.*` table.** Writing is
 * the point (SEC-20), and reading is refused with it: the link between the two
 * contexts is an identifier the application carries, never a join (§9 rule 3),
 * so there is no query that legitimately names a content table from here.
 * Specs are exempt — an integration spec may count content's rows to prove
 * generation left them alone.
 */
export function checkGenerationTouchesNoContentTable(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files = options.files ?? generationFiles(root).filter((file) => !file.endsWith('.spec.ts'));
  return files
    .filter((file) => CONTENT_TABLE_STATEMENT.test(readCode(join(root, file))))
    .map((file) => ({
      rule: 'F27_GENERATION_TOUCHES_CONTENT_TABLES' as const,
      file,
      importPath: '',
      message: `${file} names a content.* table in a statement; generation holds no capability to read or write content's tables (F27, SEC-20)`,
    }));
}

/**
 * What an event must never name: the proposal, an answer key or a solution
 * body. The outbox drains to analytics (P4/D17), which is exactly where none of
 * them may arrive. The key-bearing names are content's own list, reused so the
 * two cannot drift; the rest are the words a proposal's parts go by.
 */
export const EVENT_FORBIDDEN_FIELDS: readonly string[] = Object.freeze([
  ...KEY_BEARING_FIELDS,
  'stem',
  'body',
  'content',
  'options',
  'responseSpec',
  'solution',
  'solutionBody',
  'steps',
  'explanation',
]);

/** Declared field names in a source: `readonly name:` / `name?:` at the start of a member. */
function declaredFields(code: string): string[] {
  return [...code.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/gmu)].map((match) => match[1] as string);
}

/**
 * M5-20: an event declares no field that could carry a stem, a key or a
 * solution. Read from the event declarations themselves, so a field added to an
 * event is judged the day it is typed.
 */
export function checkEventsCarryNoContent(
  root: string,
  files: readonly string[] = ['src/contexts/generation/domain/events/generation-events.ts'],
): GenerationViolation[] {
  return files.flatMap((file) =>
    declaredFields(readCode(join(root, file)))
      .filter((field) => EVENT_FORBIDDEN_FIELDS.includes(field))
      .map((field) => ({
        rule: 'M5_20_EVENT_CARRIES_CONTENT' as const,
        file,
        importPath: '',
        message: `${file} declares an event field "${field}"; the outbox drains to analytics, where no stem, key or solution may arrive (P4, D17)`,
      })),
  );
}

/**
 * M5-20: no handler invents a principal or a correlation id. Both come from the
 * application context, the way content's handlers take them; an event stamped
 * with a made-up one is a fact nobody did and nobody can trace.
 */
const INVENTED_ENVELOPE = /\brandomUUID\b|\bcorrelationId\s*:\s*['"`]|\bprincipal\s*:\s*\{[^}]*\bid\s*:\s*['"`]|\bkind\s*:\s*['"]system['"]/u;

export function checkHandlersInventNoEnvelope(
  root: string,
  files?: readonly string[],
): GenerationViolation[] {
  const handlerFiles =
    files ??
    generationFiles(root).filter(
      (file) => file.includes('/application/handlers/') && !file.endsWith('.spec.ts'),
    );
  return handlerFiles
    .filter((file) => INVENTED_ENVELOPE.test(readCode(join(root, file))))
    .map((file) => ({
      rule: 'M5_20_HANDLER_INVENTS_ENVELOPE' as const,
      file,
      importPath: '',
      message: `${file} builds a principal or a correlation id itself; both must come from the application context (M5-20)`,
    }));
}

/** Repo-relative path of a file, for a caller holding an absolute one. */
export function repoRelative(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll('\\', '/');
}
