import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { importsOf, readCode, tsFilesUnder } from './source-scan.js';

/**
 * The fitness functions M3 adds and amends.
 *
 *   F5   — every content JSONB column has a sibling `*_schema_version`
 *   F6/F35 (amended by ADR-0009) — the answer key is on the authoring surface
 *          and nowhere else, asserted in **both** directions
 *   F7/F40 — no UPDATE/DELETE grant on a published-version table
 *   F20  — exactly one `ContentRenderer` implementation in the monorepo
 *   INV-01 — no import path from an AI context into `contexts/content/`
 *   INV-14 — no rendered-markup or image-of-text field in the vocabulary
 *   ADR-0009 condition 3 — no `Authoring*` module is reachable from a delivery
 *          controller, by **import graph** rather than by naming convention
 *   ADR-0008 — every correctness-bearing content module carries a 100%
 *          coverage threshold, and the list polices itself
 *   M4-01 (DEC-M4-7) — the review/authoring intra-context sub-boundary: a
 *          review/ module reaches only content's domain aggregates/value
 *          objects and application/authorization.ts; the rest of content
 *          reaches nothing in review/, in either direction
 *
 * Every function here is pure over its inputs, so each can be run against the
 * real tree *and* against a planted violation. A gate nobody has seen fail is
 * a gate nobody knows works.
 */

export const CONTENT_RULES = [
  'F5_JSONB_WITHOUT_A_VERSION_SIBLING',
  'F6_KEY_ON_A_DELIVERY_SURFACE',
  'F6_KEY_ABSENT_FROM_AN_AUTHORING_SURFACE',
  'F7_WRITE_GRANT_ON_A_PUBLISHED_VERSION_TABLE',
  'F40_WRITE_GRANT_ON_AN_APPEND_ONLY_TABLE',
  'F20_SECOND_CONTENT_RENDERER',
  'INV01_AI_REACHES_CONTENT',
  'INV14_RENDERED_MARKUP_FIELD',
  'ADR0009_AUTHORING_MODULE_REACHABLE_FROM_DELIVERY',
  'ADR0008_MISSING_THRESHOLD',
  'ADR0008_WEAK_THRESHOLD',
  'ADR0008_THRESHOLD_NAMES_A_DELETED_MODULE',
  'M4_01_REVIEW_REACHES_AUTHORING',
  'M4_01_AUTHORING_REACHES_REVIEW',
  'M4_01_INTERNAL_MODULE_IMPORTS_BARREL',
] as const;
export type ContentRule = (typeof CONTENT_RULES)[number];

export interface ContentViolation {
  readonly rule: ContentRule;
  /** The file, table or module the violation is in. */
  readonly subject: string;
  readonly detail: string;
}

/* ------------------------------------------------------------------ *
 * F6 / F35, amended by ADR-0009
 * ------------------------------------------------------------------ */

/**
 * The field names that *are* the key, or name it.
 *
 * Enumerated rather than inferred from shape: a structural check passes on a
 * field a spread carried in by accident, which is exactly how a key reaches a
 * payload.
 */
export const KEY_BEARING_FIELDS = [
  'answerKey',
  'answer_key',
  'correctOptionId',
  'correctOptionIds',
  'isCorrect',
  'is_correct',
  'expectedValue',
  'toleranceValue',
  'rangeMin',
  'rangeMax',
  'significantFigures',
  'finalAnswerAssertion',
] as const;

export interface PayloadSurfaces {
  /** Modules that must never name a key field, on any code path. */
  readonly delivery: readonly string[];
  /**
   * Modules that must name one. Enumerated and closed (DEC-4 condition 1):
   * adding to this list is a reviewed change to a named constant.
   */
  readonly authoring: readonly string[];
}

/**
 * F6/F35 as ADR-0009 amends it, **in both directions**.
 *
 * The one-directional version passes cheerfully on the day somebody removes
 * the key from the item editor's own view, which is a different bug and just
 * as bad: the editor silently stops being able to author an answer.
 *
 * **The two directions are asked differently, and each asymmetry has a
 * reason.** A delivery surface must not *name* a key field in its own text:
 * naming it is how it gets serialized, and following its imports would flag
 * the domain's own `ResponseSpecification`, which every layer legitimately
 * reaches. An authoring surface must *reach* key material, because it carries
 * the key by handing on a whole specification and by importing the generated
 * schema rather than restating the field names — so a text scan of the module
 * alone would report the correct design as a violation.
 */
export function checkPayloadSurfaces(
  root: string,
  surfaces: PayloadSurfaces,
  keyFields: readonly string[] = KEY_BEARING_FIELDS,
  resolution: ModuleResolution = {},
): ContentViolation[] {
  const violations: ContentViolation[] = [];

  for (const module of surfaces.delivery) {
    const source = readCode(join(root, module));
    for (const field of keyFields) {
      if (!nameAppears(source, field)) continue;
      violations.push({
        rule: 'F6_KEY_ON_A_DELIVERY_SURFACE',
        subject: module,
        detail: `names the key-bearing field "${field}"`,
      });
    }
  }

  for (const module of surfaces.authoring) {
    const entry = join(root, module);
    const sources = [entry, ...modulesReachableFrom(entry, resolution)].map(readCode);
    if (sources.some((source) => keyFields.some((field) => nameAppears(source, field)))) continue;
    violations.push({
      rule: 'F6_KEY_ABSENT_FROM_AN_AUTHORING_SURFACE',
      subject: module,
      detail: 'carries no key-bearing field, so the surface can no longer author an answer',
    });
  }

  return violations;
}

/** Matches an identifier, not a substring of a longer one. */
function nameAppears(source: string, field: string): boolean {
  return new RegExp(`\\b${field}\\b`, 'u').test(source);
}

/* ------------------------------------------------------------------ *
 * ADR-0009 condition 3 — by import graph
 * ------------------------------------------------------------------ */

export interface ModuleResolution {
  /**
   * Bare specifiers the walk follows, mapped to a file. Enumerated rather than
   * resolved through node: a graph that silently walked into `node_modules`
   * would answer a question nobody asked.
   */
  readonly packages?: Readonly<Record<string, string>>;
}

function resolveSpecifier(
  from: string,
  specifier: string,
  resolution: ModuleResolution,
): string | null {
  if (!specifier.startsWith('.')) return resolution.packages?.[specifier] ?? null;
  const target = resolve(dirname(from), specifier).replace(/\.js$/u, '.ts');
  return existsSync(target) ? target : null;
}

/** Every module reachable from `entry` by following imports. */
export function modulesReachableFrom(
  entry: string,
  resolution: ModuleResolution = {},
): string[] {
  const seen = new Set<string>();
  const frontier = [entry];

  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const specifier of importsOf(readCode(current))) {
      const target = resolveSpecifier(current, specifier, resolution);
      if (target !== null && existsSync(target)) frontier.push(target);
    }
  }

  seen.delete(entry);
  return [...seen];
}

/**
 * ADR-0009's third ratified condition, structurally.
 *
 * **Not by naming convention**, which a rename defeats: the graph is walked
 * from the delivery controller, and a listed authoring module appearing
 * anywhere in it fails — however many hops away, and whatever it is called.
 */
export function checkAuthoringUnreachableFromDelivery(
  deliveryEntries: readonly string[],
  authoringModules: readonly string[],
): ContentViolation[] {
  return deliveryEntries.flatMap((entry) => {
    const reachable = modulesReachableFrom(entry);
    return authoringModules
      .filter((module) => reachable.includes(module))
      .map((module) => ({
        rule: 'ADR0009_AUTHORING_MODULE_REACHABLE_FROM_DELIVERY' as const,
        subject: entry,
        detail: `reaches ${module}`,
      }));
  });
}

/* ------------------------------------------------------------------ *
 * F20 — one renderer
 * ------------------------------------------------------------------ */

const RENDERER_DECLARATION = /export (?:function|const|class) ContentRenderer\b/u;

/** Directories that are not source: dependencies, build output, coverage. */
const NOT_SOURCE = ['node_modules', 'dist', 'build', 'coverage', '.turbo'];

/**
 * Every `.ts`/`.tsx` source file under a root.
 *
 * `tsFilesUnder` is not enough here: the renderer is a `.tsx`, and a scan that
 * cannot see `.tsx` would report exactly one implementation by being unable to
 * find any.
 */
function sourceFilesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    if (NOT_SOURCE.includes(entry)) return [];
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return sourceFilesUnder(path);
    if (path.endsWith('.d.ts')) return [];
    return /\.tsx?$/u.test(path) && !/\.spec\.tsx?$/u.test(path) ? [path] : [];
  });
}

/**
 * F20 (§9 rule 13). Two implementations mean the authoring preview diverges
 * from what students see, silently, and INV-14's promise becomes unfalsifiable.
 *
 * `exclude` holds path fragments the rule exempts, named at the call site: the
 * planted-violation fixtures live inside `apps/`, and a fixture that exists to
 * be found by this scan must not also be found by the production run.
 */
export function checkSingleContentRenderer(
  roots: readonly string[],
  options: { readonly exclude?: readonly string[] } = {},
): {
  readonly implementations: readonly string[];
  readonly scanned: number;
  readonly violations: readonly ContentViolation[];
} {
  const exempt = options.exclude ?? [];
  const files = roots
    .flatMap((root) => sourceFilesUnder(root))
    .filter((file) => !exempt.some((fragment) => file.includes(fragment)));
  const implementations = files.filter((file) => RENDERER_DECLARATION.test(readFileSync(file, 'utf8')));

  const violations = implementations.slice(1).map((file) => ({
    rule: 'F20_SECOND_CONTENT_RENDERER' as const,
    subject: file,
    detail: 'a second ContentRenderer implementation',
  }));

  return { implementations, scanned: files.length, violations };
}

/* ------------------------------------------------------------------ *
 * INV-01 — no path from a model to content
 * ------------------------------------------------------------------ */

/**
 * The AI context, by every name it could arrive under.
 *
 * **None of these exists yet** — the generation context is M5's — so this is a
 * tripwire rather than a check with something to find today. That is the
 * point: INV-01 is a boundary property, and the moment somebody creates the
 * far side of it, an import into content fails the build rather than being
 * noticed in review. The spec proves the mechanism fires by pointing it at a
 * context that does exist.
 */
export const AI_CONTEXT_PATTERNS = [
  /contexts\/ai\//u,
  /contexts\/generation\//u,
  /@questionbank\/ai\b/u,
] as const;

export function checkNoAiImportIntoContent(
  contentRoot: string,
  patterns: readonly RegExp[] = AI_CONTEXT_PATTERNS,
): ContentViolation[] {
  return tsFilesUnder(contentRoot).flatMap((file) =>
    importsOf(readCode(file))
      .filter((specifier) => patterns.some((pattern) => pattern.test(specifier)))
      .map((specifier) => ({
        rule: 'INV01_AI_REACHES_CONTENT' as const,
        subject: relative(contentRoot, file),
        detail: `imports ${specifier}`,
      })),
  );
}

/* ------------------------------------------------------------------ *
 * INV-14 — structured markup, never rendered markup
 * ------------------------------------------------------------------ */

/**
 * Field names that would let a node carry rendered markup or an image of text
 * — the two things DOMAIN-MODEL §5 says a `ContentBody` is never made of.
 *
 * A vocabulary with an `html` field renders as literal text on print and as
 * markup on the web, which is the exact divergence INV-14 exists to prevent.
 */
export const RENDERED_MARKUP_FIELDS = [
  'html',
  'innerHtml',
  'rendered',
  'renderedHtml',
  'markup',
  'svg',
  'imageOfText',
  'dataUri',
] as const;

export function checkNoRenderedMarkupField(
  vocabularyFiles: readonly string[],
  fields: readonly string[] = RENDERED_MARKUP_FIELDS,
): ContentViolation[] {
  return vocabularyFiles.flatMap((file) => {
    const source = readCode(file);
    return fields
      .filter((field) => new RegExp(`\\breadonly ${field}\\b|\\b${field}\\s*[?:]`, 'u').test(source))
      .map((field) => ({
        rule: 'INV14_RENDERED_MARKUP_FIELD' as const,
        subject: file,
        detail: `declares a "${field}" field`,
      }));
  });
}

/* ------------------------------------------------------------------ *
 * F5 and F7 — the database halves, over catalogue rows
 * ------------------------------------------------------------------ */

export interface ColumnRow {
  readonly table: string;
  readonly column: string;
  readonly dataType: string;
}

/** F5 (§9 rule 7): every JSONB column has a sibling `*_schema_version`. */
export function checkJsonbVersionSiblings(columns: readonly ColumnRow[]): ContentViolation[] {
  const present = new Set(columns.map((row) => `${row.table}.${row.column}`));

  return columns
    .filter((row) => row.dataType === 'jsonb')
    .filter((row) => !present.has(`${row.table}.${row.column}_schema_version`))
    .map((row) => ({
      rule: 'F5_JSONB_WITHOUT_A_VERSION_SIBLING' as const,
      subject: `${row.table}.${row.column}`,
      detail: `no ${row.column}_schema_version sibling`,
    }));
}

export interface GrantRow {
  readonly table: string;
  readonly privilege: string;
  readonly grantee: string;
}

/**
 * F7/F40 (§9 rule 11), as M3-20 adapts it.
 *
 * A content version is editable while a draft and frozen from publication, so
 * the app role keeps UPDATE and DELETE — the trigger, not the grant, is what
 * holds INV-03 for rows. What no role may hold is TRUNCATE, which a row
 * trigger cannot see.
 */
export function checkNoTruncateGrant(
  grants: readonly GrantRow[],
  appRoles: readonly string[],
): ContentViolation[] {
  return grants
    .filter((row) => row.privilege === 'TRUNCATE' && appRoles.includes(row.grantee))
    .map((row) => ({
      rule: 'F7_WRITE_GRANT_ON_A_PUBLISHED_VERSION_TABLE' as const,
      subject: row.table,
      detail: `${row.grantee} holds TRUNCATE`,
    }));
}

/**
 * F40 (M0-24) — `platform.*` tables are append-only by design (the audit
 * log, the idempotency ledger, the outbox): the app role may `SELECT` and
 * `INSERT`, never `UPDATE`, `DELETE` or `TRUNCATE`. Unlike a content version,
 * there is no draft state to make any of the three legitimate.
 */
export function checkNoWriteGrantOnAppendOnlyTable(
  grants: readonly GrantRow[],
  appRoles: readonly string[],
): ContentViolation[] {
  const forbidden = new Set(['UPDATE', 'DELETE', 'TRUNCATE']);
  return grants
    .filter((row) => forbidden.has(row.privilege) && appRoles.includes(row.grantee))
    .map((row) => ({
      rule: 'F40_WRITE_GRANT_ON_AN_APPEND_ONLY_TABLE' as const,
      subject: row.table,
      detail: `${row.grantee} holds ${row.privilege}`,
    }));
}

/* ------------------------------------------------------------------ *
 * ADR-0008 — the coverage list polices itself
 * ------------------------------------------------------------------ */

export interface CoverageThreshold {
  readonly branches?: number;
  readonly lines?: number;
  readonly functions?: number;
  readonly statements?: number;
}

/**
 * Every content module that is correctness-bearing under ADR-0008 — it
 * determines *what gets published*, *what a delivery payload contains*, or
 * *what the executor is handed*. A defect in one of these produces content
 * that looks right, passes review, and is wrong.
 *
 * The list is checked three ways: a module on it with no threshold fails, a
 * threshold below 100 fails, and a module on it that no longer exists fails —
 * so deleting a file without updating the list is caught rather than silently
 * shrinking the gate.
 */
export const CORRECTNESS_BEARING_CONTENT_MODULES = [
  'src/contexts/content/application/answer-key-projection.ts',
  'src/contexts/content/application/final-answer-agreement.ts',
  'src/contexts/content/application/authorization.ts',
  'src/contexts/content/application/handler-registry.ts',
  'src/contexts/content/application/handlers/authoring-handlers.ts',
  'src/contexts/content/application/handlers/import-handlers.ts',
  'src/contexts/content/application/handlers/lifecycle-handlers.ts',
  'src/contexts/content/application/handlers/media-handlers.ts',
  'src/contexts/content/application/handlers/solution-handlers.ts',
  'src/contexts/content/application/handlers/stimulus-handlers.ts',
  'src/contexts/content/application/import/import-batch.ts',
  'src/contexts/content/application/ports.ts',
  // M4-26. Decides who may claim, decide, edit, reassign, sweep or read queue
  // health — a gap here is a role reaching a capability DEC-M4-9/DEC-M4-1
  // never assigned it.
  'src/contexts/content/application/review/policies.ts',
  // M4-27. Claim, release, reassign, extend — a gap here is a race the
  // atomic claim exists to close reopened at the application layer, or a
  // reviewer holding a claim past its policy cap.
  'src/contexts/content/application/review/handlers/assignment-handlers.ts',
  // M4-29. Approve-with-edits — a gap here lets an edited version publish
  // under its own editor's signature, or lets the author's name slip off a
  // reviewer edit.
  'src/contexts/content/application/review/handlers/reviewer-edit-handlers.ts',
  // M4-31. The ageing sweep — a gap here silently leaves an ageing item
  // unescalated, or emits the escalation twice.
  'src/contexts/content/application/review/handlers/ageing-handlers.ts',
  // M4-32. Duplicate detection's write half — a gap here either misses a
  // planted duplicate pair or reports one that never existed.
  'src/contexts/content/application/review/handlers/fingerprint-handlers.ts',
  // M4-32. Duplicate detection's read half — a gap here merges the three
  // labelled groups, or reports evaluated when nothing has run yet.
  'src/contexts/content/application/review/queries/duplicate-queries.ts',
  // M4-33. A gap here derives "overdue" wrong, mislabels a notification as
  // an overdue verdict, or lets a reviewer read another's throughput.
  'src/contexts/content/application/review/queries/queue-queries.ts',
  'src/contexts/content/application/queries/authoring-queries.ts',
  'src/contexts/content/application/queries/delivery-queries.ts',
  'src/contexts/content/domain/content-body.ts',
  'src/contexts/content/domain/content-body-projections.ts',
  'src/contexts/content/domain/content-error.ts',
  'src/contexts/content/domain/events/content-events.ts',
  'src/contexts/content/domain/item.ts',
  'src/contexts/content/domain/item-lifecycle.ts',
  'src/contexts/content/domain/item-version.ts',
  'src/contexts/content/domain/licensing-status.ts',
  'src/contexts/content/domain/locale-variant.ts',
  'src/contexts/content/domain/media-asset.ts',
  'src/contexts/content/domain/pre-submission-validation.ts',
  'src/contexts/content/domain/provenance.ts',
  'src/contexts/content/domain/publication-preconditions.ts',
  'src/contexts/content/domain/response-specification.ts',
  'src/contexts/content/domain/review-decision.ts',
  'src/contexts/content/domain/review/review-assignment.ts',
  'src/contexts/content/domain/review/queue-ordering.ts',
  'src/contexts/content/domain/review/self-review.ts',
  'src/contexts/content/domain/review/ageing.ts',
  'src/contexts/content/domain/review/review-policy.ts',
  'src/contexts/content/domain/review/rejection-taxonomy.ts',
  'src/contexts/content/domain/review/decision-evidence.ts',
  'src/contexts/content/domain/review/edit-scope.ts',
  'src/contexts/content/domain/review/fingerprint.ts',
  'src/contexts/content/domain/review/trigram.ts',
  'src/contexts/content/domain/review/qc-sampling.ts',
  'src/contexts/content/domain/solution.ts',
  'src/contexts/content/domain/stimulus.ts',
  'src/contexts/content/domain/taxonomy-tag.ts',
  'src/contexts/content/infrastructure/item.repository.ts',
  'src/contexts/content/infrastructure/media-asset.repository.ts',
  'src/contexts/content/infrastructure/outbox-emitter.ts',
  'src/contexts/content/infrastructure/render-validator.adapter.ts',
  'src/contexts/content/infrastructure/review-decision.repository.ts',
  // M4-28. The shared transaction a decision, its candidate rows, the
  // assignment's transition and the item's lifecycle transition commit
  // through together — a gap here is the one-transaction guarantee silently
  // losing atomicity.
  'src/contexts/content/infrastructure/transaction-runner.ts',
  'src/contexts/content/infrastructure/review/fingerprint.repository.ts',
  'src/contexts/content/infrastructure/review/review-assignment.repository.ts',
  'src/contexts/content/infrastructure/review/review-candidate-shown.repository.ts',
  'src/contexts/content/infrastructure/review/review-escalation.repository.ts',
  'src/contexts/content/infrastructure/solution.repository.ts',
  'src/contexts/content/infrastructure/stimulus.repository.ts',
] as const;

export function checkCoverageThresholds(
  thresholds: Readonly<Record<string, unknown>>,
  modules: readonly string[],
  moduleExists: (module: string) => boolean,
): ContentViolation[] {
  const violations: ContentViolation[] = [];

  for (const module of modules) {
    if (!moduleExists(module)) {
      violations.push({
        rule: 'ADR0008_THRESHOLD_NAMES_A_DELETED_MODULE',
        subject: module,
        detail: 'is on the correctness-bearing list but no longer exists',
      });
      continue;
    }

    const declared = thresholds[module];
    if (declared === undefined) {
      violations.push({
        rule: 'ADR0008_MISSING_THRESHOLD',
        subject: module,
        detail: 'is correctness-bearing and carries no coverage threshold',
      });
      continue;
    }

    const threshold = declared as CoverageThreshold;
    for (const metric of ['branches', 'lines', 'functions', 'statements'] as const) {
      if (threshold[metric] === 100) continue;
      violations.push({
        rule: 'ADR0008_WEAK_THRESHOLD',
        subject: module,
        detail: `${metric} threshold is ${String(threshold[metric])}, not 100`,
      });
    }
  }

  return violations;
}

/* ------------------------------------------------------------------ *
 * M4-01 — the review/authoring intra-context sub-boundary (DEC-M4-7)
 * ------------------------------------------------------------------ */

/**
 * A module belongs to the **restricted review layer** when it is
 * `application/review/**` or `infrastructure/review/**` — the write-path
 * plumbing DEC-M4-7 walls off.
 *
 * **`api/review.controller.ts` is deliberately not matched here (amended
 * 2026-08-26, M4-37).** It originally was, alongside the two write-path
 * trees — an M4-01 acceptance line, not a conclusion DEC-M4-7's own
 * reasoning forced. Wiring the controller to real routes needed
 * `api/http-runner.ts` (`runOperation`, the two DI tokens), which is neither
 * review nor authoring: `authoring.controller.ts` and `content.controller.ts`
 * already depend on it and were never classified as either side. Two
 * choices existed — add `http-runner.ts` as a fourth context-wide contract
 * (category 2 below), or stop treating the HTTP edge as inside DEC-M4-7's
 * write-path boundary at all. The second is the one taken: **this gate
 * governs `application/` and `infrastructure/`, never `api/`.** The
 * asymmetry the old classification created — one controller walled off,
 * the other two never subject to the wall — was itself a sign the line was
 * drawn in the wrong place, and it would have kept generating exemption
 * requests: `http-runner.ts` today, the next DTO schema or authoring query
 * type the review screen needs tomorrow. Extraction-survivability, which is
 * what this whole gate protects, lives in `application/`/`infrastructure/`
 * coupling — a controller translating HTTP to a command and a `Result` back
 * to a status code carries no coupling of that kind to lose. The load-bearing
 * half is unchanged: `application/review/**` and `infrastructure/review/**`
 * still cannot reach authoring's queries, handlers or repositories, and
 * authoring still cannot reach either, in both directions, exactly as
 * before — proven by the same four planted violations this gate has always
 * asserted red, none of which named the controller.
 *
 * **`domain/review/*.ts` is deliberately not matched here.** F2 (`domain/`
 * imports nothing but itself and the shared kernel) already keeps every
 * domain module pure, `domain/review/` included — a second, narrower purity
 * rule for one sub-directory of domain would be a rule checking a rule. What
 * this gate adds on top of F2 is the *application/infrastructure/api*
 * boundary, where review's write path and content's existing authoring
 * surface would otherwise reach into each other's plumbing. A domain
 * aggregate that happens to live under `domain/review/` — `ReviewAssignment`,
 * `self-review.ts` — is exactly the kind of thing DEC-M4-7 says both sides
 * "meet only at": callable from content's authoring domain the same way any
 * other domain module is, which is what lets `publication-preconditions.ts`
 * call `isSelfReview` (M4-04) without this gate refusing it.
 *
 * **Two categories exist alongside "review" and "authoring", named here
 * rather than granted case by case — and deliberately not one list, because
 * they grow under different rules.**
 *
 * **Category 1: seam files.** A file whose entire job is to span the
 * context — not to hold review or authoring business logic of its own, but
 * to be the place every layer meets. Membership test: does this file exist
 * *because* something has to cross every internal sub-boundary to reach the
 * outside world? Exactly two, and the category is **closed at two** — not
 * capped-with-a-process like category 2 below, closed: `public/` contains
 * exactly these files, so a third would mean a third `public/` seam
 * existing at all, which is itself the reviewable event, not an addition to
 * this list.
 *
 *   1. `public/composition.ts` — the composition root (ADR-0015). Composing
 *      the module is its job: it wires every layer, review's own handlers
 *      included, into the `DynamicModule` the barrel exports, so it must be
 *      able to import `application/review/**` to instantiate what it wires.
 *   2. `public/index.ts` — the barrel (M4-35). Its job is exporting the
 *      whole context's public surface, and since M4-27 that surface
 *      includes review's commands, queries and events — DEC-M4-7 treats
 *      review as ordinary content plumbing behind *one* barrel, never a
 *      second context with its own. A barrel that could not name what half
 *      of its own context does would not be a barrel.
 *
 * Both are exempt from this gate **as a source**, in both directions —
 * `public/composition.ts` importing `application/review/**` is the seam
 * doing its job; a review module importing either seam file back has no
 * legitimate use captured here, so it is exempted the same way rather than
 * left an asymmetric special case. Neither is exempt **as a target** for
 * anything else: see `M4_01_INTERNAL_MODULE_IMPORTS_BARREL` below, which
 * closes the path a seam-as-target would otherwise open.
 *
 * **Category 2: context-wide contracts.** A module used by both sides,
 * specific to neither, carrying no authoring or review business logic of
 * its own — the same test applied each time a member was added. Exactly
 * three today, and this is the category where the stop-and-ask cap lives:
 * membership by *resemblance* ("it's used by both sides too") is exactly
 * how a boundary erodes, because nearly anything shared-looking can be
 * argued into it. A fourth contract requires **stopping and asking**:
 *
 *   1. `application/authorization.ts` — policies, role checks.
 *   2. `application/ports.ts` — `Clock`, `AuditRecorder`, `IdentifierFactory`,
 *      `ApplicationContext`, `TransactionRunner`.
 *   3. `infrastructure/transaction-runner.ts` — `TransactionContext`'s one
 *      concrete implementation and `clientOf`, its downcast (M4-28). Three
 *      repositories call `clientOf` in shipped code today —
 *      `item.repository.ts`, `review-decision.repository.ts` (both
 *      authoring-side) and `review-assignment.repository.ts`'s
 *      `hasLiveClaim` (review-side, M4-30) — so this is the established
 *      mechanism for joining a caller's shared transaction, not a new one
 *      invented to pass this gate.
 *
 * On extraction, a standalone review context would declare its own copies
 * of these three — exactly as content, curriculum and scoring each declare
 * their own `Clock`/`AuditRecorder`/`IdentifierFactory` today — never
 * import content's, so none of the three is an extraction-survivability
 * concern the way an authoring-specific module would be. The seam files
 * have no such story — a barrel and a composition root are exactly what an
 * extracted context would still need of its own — which is the structural
 * reason they sit in a different, closed category rather than growing the
 * capped one.
 *
 * Anything authoring-specific — `ListSubmittedForReview`, a lifecycle
 * command type, a handler class, `item.repository.ts` itself — is reachable
 * only through what `public/index.ts` exports, and only by importing the
 * barrel itself, never by reaching past it into `application/review/**`
 * directly. If a future task needs something the barrel does not carry,
 * the fix is a reviewed addition to what it exports, never a new exemption
 * here.
 *
 * **Debt, named with its trigger.** The three context-wide contracts are
 * scattered across `application/` and `infrastructure/` by historical
 * accident, not by a shared physical location — membership is enforced by
 * this list, not by path. Moving them under one `shared/`-shaped directory
 * would let this gate check a path prefix instead of an enumeration, which
 * is more robust against a future addition slipping in unreviewed. Not
 * attempted now: it touches every import site of all three, and
 * M4-28/M4-29/M4-30 already shipped against the current layout. Trigger:
 * the fourth contract.
 */
const REVIEW_PATH_SEGMENT = /(^|\/)(?:application|infrastructure)\/review\//u;

/** Any module under a `domain/` tree, at any depth — the whole domain layer, F2-pure by construction. */
const DOMAIN_MODULE = /(^|\/)domain\/.+\.ts$/u;

/** Context-wide contract 1 of 3 (DEC-M4-7). */
const AUTHORIZATION_MODULE = /(^|\/)application\/authorization\.ts$/u;

/**
 * Context-wide contract 2 of 3 (DEC-M4-7). Exact path, not a prefix —
 * matching `application/ports.ts` specifically is what stops this exemption
 * growing into "all of `application/`" by accident. A review module
 * reaching `application/queries/authoring-queries.ts` or
 * `application/handlers/lifecycle-handlers.ts` must still fail; both are
 * planted and proven in `content-rules.spec.ts`.
 */
const PORTS_MODULE = /(^|\/)application\/ports\.ts$/u;

/**
 * Context-wide contract 3 of 3 (M4-28/M4-30). Exact path, same reasoning
 * as `PORTS_MODULE`: a review module reaching `infrastructure/item.repository.ts`
 * or any other authoring-specific infrastructure module must still fail,
 * planted and proven in `content-rules.spec.ts`.
 */
const TRANSACTION_RUNNER_MODULE = /(^|\/)infrastructure\/transaction-runner\.ts$/u;

/**
 * Seam-file membership (M4-35) is relative to whichever tree is being
 * scanned — `<includeRoot>/public/composition.ts` and `<includeRoot>/public/index.ts`
 * — never a bare `public/index.ts` filename match. A content module
 * legitimately imports **other contexts'** barrels (`answer-key-projection.ts`
 * reaches `contexts/scoring/public/index.ts` for `AnswerKeyData`, by the
 * barrel's own header note) — a filename-only pattern would misclassify
 * every one of those as this content's own barrel and fire
 * `M4_01_INTERNAL_MODULE_IMPORTS_BARREL` on a completely unrelated context.
 * Scoping to the actual include roots is also what lets the same function
 * run against a fixture tree shaped like content's (`as-content-review-subboundary/`)
 * without a second, fixture-specific pattern.
 */
function isSeamModule(relPath: string, includeRoots: readonly string[]): boolean {
  return includeRoots.some(
    (dir) => relPath === `${dir}/public/composition.ts` || relPath === `${dir}/public/index.ts`,
  );
}

/** The barrel specifically, of the two seam files — the one target `M4_01_INTERNAL_MODULE_IMPORTS_BARREL` names. */
function isBarrelModule(relPath: string, includeRoots: readonly string[]): boolean {
  return includeRoots.some((dir) => relPath === `${dir}/public/index.ts`);
}

/**
 * DEC-M4-7's sub-boundary, both directions, by import graph rather than
 * convention — the same discipline `checkAuthoringUnreachableFromDelivery`
 * applies to ADR-0009 condition 3.
 *
 * Classification is purely structural on path segments, which is what lets
 * this run unchanged over both the real tree and a fixture directory shaped
 * like one (`as-content-review-subboundary/`): the rule does not care which
 * context it is scanning, only whether a review-plumbing module reaches an
 * authoring-plumbing one it should not, or vice versa.
 *
 * **Three rules, not two, since M4-35.** The barrel joining the seam-file
 * category opened a path the original two rules cannot see: `public/index.ts`
 * is classified as neither review nor authoring, so a plain authoring module
 * importing it — reaching review's re-exported command/query types without
 * ever naming `application/review/**` directly — trips neither
 * `M4_01_REVIEW_REACHES_AUTHORING` nor `M4_01_AUTHORING_REACHES_REVIEW`.
 * `M4_01_INTERNAL_MODULE_IMPORTS_BARREL` closes it: checked first, for every
 * file, regardless of which side it is on, so a review module importing its
 * own barrel back is caught here too rather than falling through to a less
 * specific message. The two seam files never reach this check themselves —
 * they are exempted **as a source** above the loop — and the seam specs
 * (`m4-seam.spec.ts`, `m5-seam.spec.ts`) that import the barrel on purpose
 * are `.spec.ts` files, already outside `files` under this function's
 * default `exclude`.
 */
export function checkReviewAuthoringSubBoundary(
  root: string,
  options: { readonly include?: readonly string[]; readonly exclude?: readonly RegExp[] } = {},
): ContentViolation[] {
  const includes = options.include ?? ['src/contexts/content'];
  const excludes = options.exclude ?? [/\.spec\.ts$/u];
  const violations: ContentViolation[] = [];

  const files = includes
    .flatMap((directory) => tsFilesUnder(join(root, directory)))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)));

  for (const file of files) {
    const relFile = relative(root, file).replaceAll('\\', '/');
    // Exempt as a source in both directions — see the seam-file category doc above.
    if (isSeamModule(relFile, includes)) continue;
    const fileIsReview = REVIEW_PATH_SEGMENT.test(relFile);

    for (const importPath of importsOf(readCode(file))) {
      if (!importPath.startsWith('.')) continue; // a package or a node builtin — not this context
      const resolved = resolve(dirname(file), importPath).replace(/\.js$/u, '.ts');
      if (!existsSync(resolved)) continue;
      const relTarget = relative(root, resolved).replaceAll('\\', '/');

      if (isBarrelModule(relTarget, includes)) {
        violations.push({
          rule: 'M4_01_INTERNAL_MODULE_IMPORTS_BARREL',
          subject: relFile,
          detail: `imports ${importPath} (${relTarget}); no module inside contexts/content/ may import its own public/index.ts — that is the path by which an authoring module could reach review's types (or a review module, authoring's) around this gate`,
        });
        continue;
      }

      const targetIsReview = REVIEW_PATH_SEGMENT.test(relTarget);

      if (fileIsReview && !targetIsReview) {
        const permitted =
          DOMAIN_MODULE.test(relTarget) ||
          AUTHORIZATION_MODULE.test(relTarget) ||
          PORTS_MODULE.test(relTarget) ||
          TRANSACTION_RUNNER_MODULE.test(relTarget) ||
          // Only public/composition.ts reaches this line — public/index.ts
          // (the barrel) is intercepted above, before this check ever runs.
          isSeamModule(relTarget, includes);
        if (!permitted) {
          violations.push({
            rule: 'M4_01_REVIEW_REACHES_AUTHORING',
            subject: relFile,
            detail: `imports ${importPath} (${relTarget}), which is none of a domain aggregate/value object, application/authorization.ts, application/ports.ts, or infrastructure/transaction-runner.ts`,
          });
        }
      }

      if (!fileIsReview && targetIsReview) {
        violations.push({
          rule: 'M4_01_AUTHORING_REACHES_REVIEW',
          subject: relFile,
          detail: `imports ${importPath} (${relTarget}); authoring/ may not import review/ (DEC-M4-7)`,
        });
      }
    }
  }

  return violations;
}
