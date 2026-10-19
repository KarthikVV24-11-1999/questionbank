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
    | 'M5_20_HANDLER_INVENTS_ENVELOPE'
    | 'EXT05_PROVIDER_LEAKS_OUT_OF_ITS_ADAPTER'
    | 'EXT05_API_KEY_READ_IN_REPOSITORY'
    | 'F33_INFERENCE_ON_A_REQUEST_PATH'
    | 'F32_AI_CALL_WITHOUT_A_BUDGET_SCOPE';
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Every file in generation, specs included: a test that reaches past the barrel is the same coupling. */
export function generationFiles(root: string): string[] {
  return tsFilesUnder(root, `${CONTEXTS_ROOT}/${GENERATION_CONTEXT}`);
}

/**
 * **The other half of ADR-0025: what generation may take from the contexts upstream of it.**
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
export function checkGenerationReachesUpstreamOnlyAsBarrelTypes(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files = options.files ?? generationFiles(root);
  const violations: GenerationViolation[] = [];

  for (const file of files) {
    const code = readCode(join(root, file));
    for (const importPath of importsOf(code)) {
      const resolved = resolveImport(file, importPath, root);
      const target = resolved === null ? null : contextOf(resolved);
      if (resolved === null || target === null || target === GENERATION_CONTEXT) continue;

      if (resolved.replace(/\.[jt]sx?$/u, '') !== `src/contexts/${target}/public/index`) {
        violations.push({
          rule: 'GENERATION_REACHES_CONTENT_ONLY_AS_BARREL_TYPES',
          file,
          importPath,
          message: `${file} imports ${importPath}, past ${target}'s barrel; generation may reach ${target} only through ${target}/public/ (ADR-0025)`,
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
          message: `${file} imports ${target}'s barrel as a value; generation may take only types from it, and the composition root runs ${target} (ADR-0025, SEC-20)`,
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

/**
 * **EXT-05: the provider is the adapter's, and nobody else's.** Substituting a
 * provider must be a change to one directory. So outside `infrastructure/provider/`
 * nothing in generation may import a provider SDK or an HTTP client, call the
 * network, read an API-key-shaped environment variable, or name a model as a
 * string — the model is a registry row the pin references.
 */
export const PROVIDER_ADAPTER_DIRECTORY = 'src/contexts/generation/infrastructure/provider/';

/** Packages and built-ins that reach a provider, or any network, directly. */
const PROVIDER_IMPORT =
  /^(?:@anthropic-ai\/|@google\/generative-ai|openai$|axios$|got$|node-fetch$|undici$|ky$|superagent$|(?:node:)?https?$|(?:node:)?net$|(?:node:)?tls$|(?:node:)?http2$)/u;
const NETWORK_CALL = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/u;
const API_KEY_READ = /process\.env\b[^;\n]*(?:API[_-]?KEY|ANTHROPIC|OPENAI|SECRET[_-]?KEY|AUTH[_-]?TOKEN)|\b(?:ANTHROPIC|OPENAI)_[A-Z_]+\b/iu;
/** A string that names a model: `claude-…`, `gpt-…`, or one of the tier names. */
const MODEL_NAME_LITERAL = /(['"`])[^'"`\n]*\b(?:claude|gpt|gemini|llama|haiku|sonnet|opus)\b[^'"`\n]*\1/iu;

export function checkProviderIsolation(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files =
    options.files ??
    generationFiles(root).filter((file) => !file.startsWith(PROVIDER_ADAPTER_DIRECTORY) && !file.endsWith('.spec.ts'));
  const violations: GenerationViolation[] = [];

  const flag = (file: string, what: string, importPath = ''): void => {
    violations.push({
      rule: 'EXT05_PROVIDER_LEAKS_OUT_OF_ITS_ADAPTER',
      file,
      importPath,
      message: `${file} ${what}; the provider belongs to infrastructure/provider/ alone, so that substituting one touches one directory (EXT-05)`,
    });
  };

  for (const file of files) {
    const code = readCode(join(root, file));
    for (const importPath of importsOf(code)) {
      if (PROVIDER_IMPORT.test(importPath)) flag(file, `imports ${importPath}`, importPath);
    }
    if (NETWORK_CALL.test(code)) flag(file, 'makes a network call');
    if (API_KEY_READ.test(code)) flag(file, 'reads an API-key-shaped environment variable');
    if (MODEL_NAME_LITERAL.test(code)) flag(file, 'names a model as a string literal');
  }
  return violations;
}

/**
 * **F33: no live inference on a request path.** A model is slow and can fail, and
 * an HTTP request that waits on one inherits both. The pipeline's calls to a
 * provider — proposing a candidate, running the judged pre-checks — happen off any
 * request path, and the HTTP layer of this context (`api/`) is the request path.
 *
 * So nothing in `api/` may import a provider adapter or name the two handlers that
 * reach one (`ProposeCandidate`, `RunPrecheckBattery`), the battery's own write
 * (`RecordPrecheckVerdict`), or either provider port. Naming them is how a route
 * would reach them; the route list is separately held closed by the contract spec,
 * and this rule is what stops the controller from being edited around it.
 */
const INFERENCE_NAMES = /\b(?:ProposeCandidate|RunPrecheckBattery|RecordPrecheckVerdict|ProposalProvider|JudgementProvider)\b/u;
const PROVIDER_ADAPTER_IMPORT = /(?:^|\/)infrastructure\/provider\//u;

export function checkNoInferenceOnARequestPath(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files =
    options.files ??
    generationFiles(root).filter((file) => file.includes('/api/') && !file.endsWith('.spec.ts'));
  const violations: GenerationViolation[] = [];

  const flag = (file: string, what: string, importPath = ''): void => {
    violations.push({
      rule: 'F33_INFERENCE_ON_A_REQUEST_PATH',
      file,
      importPath,
      message: `${file} ${what}; the HTTP layer is a request path, and no live inference runs behind one (F33)`,
    });
  };

  for (const file of files) {
    const code = readCode(join(root, file));
    for (const importPath of importsOf(code)) {
      if (PROVIDER_ADAPTER_IMPORT.test(importPath)) flag(file, `imports ${importPath}`, importPath);
    }
    const named = INFERENCE_NAMES.exec(code);
    if (named !== null) flag(file, `names ${named[0]}`);
  }
  return violations;
}

/**
 * **F32: every AI call site declares a budget scope** (AI-ARCHITECTURE §14, M5-41).
 *
 * The type system already requires `budgetScope` on a provider request, and this is
 * the rule that does not rest on it: a call to `.propose(` or `.judge(` whose
 * arguments do not name `budgetScope` fails, whatever the types were persuaded to
 * accept — a spread, a cast, a request built three calls away. A call made with a
 * bare identifier (`provider.propose(request)`) fails too, because the declaration is
 * the call site's to make where a reader can see it; a call that really does build
 * the request elsewhere belongs behind a function that takes the scope as a parameter,
 * and that function's own call names it.
 *
 * The adapters in `infrastructure/provider/` are exempt — they *implement* the ports,
 * and the call being governed is a caller's — and so are specs, which exercise the
 * ports directly and are held to the types.
 */
/**
 * The meter is the one file allowed to forward a request by name. It is the wrapper every provider
 * call goes through, and it has just read `request.budgetScope` and checked it before forwarding; a
 * rule that made it re-declare the scope it is validating would be asking it to lie. The exemption is
 * this exact path and `generation-rules.spec.ts` asserts it, so it cannot quietly widen.
 */
export const METERED_PROVIDER_FILE = 'src/contexts/generation/application/metered-provider.ts';

const PROVIDER_CALL = /\.(?:propose|judge)\(/gu;

/** The text between a call's opening parenthesis (at `open`) and its matching close. */
function argumentsAt(code: string, open: number): string {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, index);
    }
  }
  return code.slice(open + 1);
}

export function checkEveryAiCallDeclaresABudgetScope(
  root: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files =
    options.files ??
    generationFiles(root).filter(
      (file) => !file.startsWith(PROVIDER_ADAPTER_DIRECTORY) && !file.endsWith('.spec.ts') && file !== METERED_PROVIDER_FILE,
    );
  const violations: GenerationViolation[] = [];

  for (const file of files) {
    const code = readCode(join(root, file));
    for (const match of code.matchAll(PROVIDER_CALL)) {
      const open = (match.index as number) + match[0].length - 1;
      if (!/\bbudgetScope\b/u.test(argumentsAt(code, open))) {
        violations.push({
          rule: 'F32_AI_CALL_WITHOUT_A_BUDGET_SCOPE',
          file,
          importPath: '',
          message: `${file} calls ${match[0]}…) without declaring a budgetScope at the call site, so the spend has no ceiling to be charged to (F32)`,
        });
      }
    }
  }
  return violations;
}

/** Where application source lives, relative to the repository root. */
const REPOSITORY_SOURCE_ROOTS = ['apps/api/src', 'apps/studio/src', 'packages/contracts/src', 'packages/content-renderer/src', 'packages/domain-types/src', 'tools/seed'];

/**
 * **No API key is read anywhere in this repository.** The isolation rule above
 * governs where a provider may live; this one is stricter about the one thing
 * that must live nowhere: a credential. The recorded adapter replays files, and
 * a live adapter, when there is one, takes its credential from the deployment,
 * never from a read in source that a test could trigger.
 *
 * The fitness rules and their planted fixtures are exempt, because they must
 * name what they forbid.
 */
export function checkNoApiKeyReadAnywhere(
  repositoryRoot: string,
  options: { readonly files?: readonly string[] } = {},
): GenerationViolation[] {
  const files =
    options.files ??
    REPOSITORY_SOURCE_ROOTS.flatMap((directory) => tsFilesUnder(repositoryRoot, directory)).filter(
      (file) => !file.includes('/fitness/') && !file.includes('/fitness-fixtures/') && !file.includes('/node_modules/'),
    );
  return files
    .filter((file) => API_KEY_READ.test(readCode(join(repositoryRoot, file))))
    .map((file) => ({
      rule: 'EXT05_API_KEY_READ_IN_REPOSITORY' as const,
      file,
      importPath: '',
      message: `${file} reads an API-key-shaped environment variable; no credential is read anywhere in this repository (EXT-05)`,
    }));
}

/** Repo-relative path of a file, for a caller holding an absolute one. */
export function repoRelative(root: string, absolute: string): string {
  return relative(root, absolute).replaceAll('\\', '/');
}
