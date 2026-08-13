import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { HandlerRegistry, type Handler } from '../contexts/content/application/handler-registry.js';
import {
  CREATE_ITEM_DRAFT_POLICY,
  DELETE_ITEM_DRAFT_POLICY,
  DERIVE_DRAFT_FROM_VERSION_POLICY,
  UPDATE_ITEM_DRAFT_POLICY,
} from '../contexts/content/application/handlers/authoring-handlers.js';
import {
  ATTACH_STIMULUS_TO_ITEM_POLICY,
  CREATE_STIMULUS_DRAFT_POLICY,
  UPDATE_STIMULUS_DRAFT_POLICY,
} from '../contexts/content/application/handlers/stimulus-handlers.js';
import {
  CREATE_SOLUTION_DRAFT_POLICY,
  UPDATE_SOLUTION_DRAFT_POLICY,
} from '../contexts/content/application/handlers/solution-handlers.js';
import {
  ADD_MEDIA_ASSET_VERSION_POLICY,
  REGISTER_MEDIA_ASSET_POLICY,
  RETIRE_MEDIA_ASSET_POLICY,
} from '../contexts/content/application/handlers/media-handlers.js';
import {
  PUBLISH_ITEM_VERSION_POLICY,
  PUBLISH_MEDIA_ASSET_VERSION_POLICY,
  PUBLISH_SOLUTION_VERSION_POLICY,
  PUBLISH_STIMULUS_VERSION_POLICY,
  RECORD_ITEM_REVIEW_DECISION_POLICY,
  RECORD_MEDIA_ASSET_REVIEW_DECISION_POLICY,
  RECORD_SOLUTION_REVIEW_DECISION_POLICY,
  RECORD_STIMULUS_REVIEW_DECISION_POLICY,
  RETIRE_ITEM_POLICY,
  RETIRE_STIMULUS_POLICY,
  SUBMIT_ITEM_FOR_REVIEW_POLICY,
  SUBMIT_MEDIA_ASSET_FOR_REVIEW_POLICY,
  SUBMIT_SOLUTION_FOR_REVIEW_POLICY,
  SUBMIT_STIMULUS_FOR_REVIEW_POLICY,
  SUSPEND_ITEM_POLICY,
  WITHDRAW_ITEM_FROM_REVIEW_POLICY,
} from '../contexts/content/application/handlers/lifecycle-handlers.js';
import { IMPORT_ITEM_BATCH_POLICY } from '../contexts/content/application/handlers/import-handlers.js';
import {
  GET_ITEM_DRAFT_POLICY,
  GET_ITEM_VERSION_FOR_AUTHORING_POLICY,
  GET_VALIDATION_FINDINGS_POLICY,
  LIST_MEDIA_ASSETS_POLICY,
  LIST_MY_DRAFTS_POLICY,
} from '../contexts/content/application/queries/authoring-queries.js';
import {
  GET_PUBLISHED_ITEM_POLICY,
  GET_PUBLISHED_SOLUTION_POLICY,
  GET_PUBLISHED_STIMULUS_POLICY,
} from '../contexts/content/application/queries/delivery-queries.js';

/**
 * The content contract, and ADR-0009's three ratified conditions.
 *
 * The scan runs over the **parsed and `$ref`-resolved** document rather than
 * over its text: a delivery response referencing a schema that references a
 * key-bearing one is a leak, and a text scan of the response block would never
 * see it.
 */

const CONTRACTS = fileURLToPath(new URL('../../../../packages/contracts/', import.meta.url));
const SPEC_PATH = join(CONTRACTS, 'openapi/content.yaml');
const SPEC_TEXT = readFileSync(SPEC_PATH, 'utf8');

interface Operation {
  readonly operationId?: string;
  readonly 'x-handler'?: string;
  readonly responses?: Record<string, unknown>;
  readonly requestBody?: unknown;
}

const document = parse(SPEC_TEXT) as {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly 'x-authoring-routes': readonly string[];
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly schemas: Record<string, Record<string, unknown>>;
    readonly responses: Record<string, unknown>;
    readonly parameters: Record<string, unknown>;
  };
};

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;

function operations(): readonly { path: string; method: string; operation: Operation }[] {
  const found: { path: string; method: string; operation: Operation }[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation !== undefined) found.push({ path, method, operation: operation as Operation });
    }
  }
  return found;
}

const HANDLER_POLICIES = {
  CreateItemDraft: CREATE_ITEM_DRAFT_POLICY,
  UpdateItemDraft: UPDATE_ITEM_DRAFT_POLICY,
  DeriveDraftFromVersion: DERIVE_DRAFT_FROM_VERSION_POLICY,
  DeleteItemDraft: DELETE_ITEM_DRAFT_POLICY,
  GetItemDraft: GET_ITEM_DRAFT_POLICY,
  GetItemVersionForAuthoring: GET_ITEM_VERSION_FOR_AUTHORING_POLICY,
  GetValidationFindings: GET_VALIDATION_FINDINGS_POLICY,
  ListMyDrafts: LIST_MY_DRAFTS_POLICY,
  ListMediaAssets: LIST_MEDIA_ASSETS_POLICY,
  CreateStimulusDraft: CREATE_STIMULUS_DRAFT_POLICY,
  UpdateStimulusDraft: UPDATE_STIMULUS_DRAFT_POLICY,
  AttachStimulusToItem: ATTACH_STIMULUS_TO_ITEM_POLICY,
  CreateSolutionDraft: CREATE_SOLUTION_DRAFT_POLICY,
  UpdateSolutionDraft: UPDATE_SOLUTION_DRAFT_POLICY,
  RegisterMediaAsset: REGISTER_MEDIA_ASSET_POLICY,
  AddMediaAssetVersion: ADD_MEDIA_ASSET_VERSION_POLICY,
  RetireMediaAsset: RETIRE_MEDIA_ASSET_POLICY,
  SubmitItemForReview: SUBMIT_ITEM_FOR_REVIEW_POLICY,
  WithdrawItemFromReview: WITHDRAW_ITEM_FROM_REVIEW_POLICY,
  RecordItemReviewDecision: RECORD_ITEM_REVIEW_DECISION_POLICY,
  PublishItemVersion: PUBLISH_ITEM_VERSION_POLICY,
  SuspendItem: SUSPEND_ITEM_POLICY,
  RetireItem: RETIRE_ITEM_POLICY,
  SubmitStimulusForReview: SUBMIT_STIMULUS_FOR_REVIEW_POLICY,
  RecordStimulusReviewDecision: RECORD_STIMULUS_REVIEW_DECISION_POLICY,
  PublishStimulusVersion: PUBLISH_STIMULUS_VERSION_POLICY,
  RetireStimulus: RETIRE_STIMULUS_POLICY,
  SubmitSolutionForReview: SUBMIT_SOLUTION_FOR_REVIEW_POLICY,
  RecordSolutionReviewDecision: RECORD_SOLUTION_REVIEW_DECISION_POLICY,
  PublishSolutionVersion: PUBLISH_SOLUTION_VERSION_POLICY,
  SubmitMediaAssetForReview: SUBMIT_MEDIA_ASSET_FOR_REVIEW_POLICY,
  RecordMediaAssetReviewDecision: RECORD_MEDIA_ASSET_REVIEW_DECISION_POLICY,
  PublishMediaAssetVersion: PUBLISH_MEDIA_ASSET_VERSION_POLICY,
  ImportItemBatch: IMPORT_ITEM_BATCH_POLICY,
  GetPublishedItem: GET_PUBLISHED_ITEM_POLICY,
  GetPublishedStimulus: GET_PUBLISHED_STIMULUS_POLICY,
  GetPublishedSolution: GET_PUBLISHED_SOLUTION_POLICY,
} as const;

describe('F15 — every endpoint reconciles with a real handler', () => {
  it('names a handler and an operationId on every operation', () => {
    for (const { path, method, operation } of operations()) {
      expect(operation.operationId, `${method} ${path}`).toBeTruthy();
      expect(operation['x-handler'], `${method} ${path}`).toBeTruthy();
    }
  });

  it('names only handlers that exist and declare a policy', () => {
    for (const { path, method, operation } of operations()) {
      const name = operation['x-handler'] as string;
      expect(Object.keys(HANDLER_POLICIES), `${method} ${path}`).toContain(name);
      expect(HANDLER_POLICIES[name as keyof typeof HANDLER_POLICIES].allowedRoles.length, name)
        .toBeGreaterThan(0);
    }
  });

  it('leaves no declared handler unrouted', () => {
    const routed = new Set(operations().map(({ operation }) => operation['x-handler'] as string));
    for (const name of Object.keys(HANDLER_POLICIES)) {
      expect(routed, name).toContain(name);
    }
  });

  it('registers every declared handler without boot failing (F36)', () => {
    const handlers = Object.entries(HANDLER_POLICIES).map(([name, policy]) => ({
      name,
      policy,
      async handle() {
        return { ok: true as const, value: undefined };
      },
    }));
    expect(HandlerRegistry.of(handlers as unknown as Handler<never, unknown>[]).names).toHaveLength(
      Object.keys(HANDLER_POLICIES).length,
    );
  });

  it('gives each operation a unique operationId', () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── ADR-0009 ────────────────────────────────────────────────────────────────

/**
 * Named explicitly rather than inferred. A structural check passes on a field
 * a spread carried in by accident, which is the exact way a key reaches a
 * payload.
 */
const KEY_BEARING_FIELDS = [
  'answerKey',
  'correctOptionId',
  'correctOptionIds',
  'isCorrect',
  'expectedValue',
  'toleranceValue',
  'rangeMin',
  'rangeMax',
  'significantFigures',
  'pairs',
  'finalAnswerAssertion',
] as const;

/** Every schema a node reaches, following `$ref` transitively. */
function schemasReachedFrom(node: unknown, seen = new Set<string>()): Set<string> {
  if (node === null || typeof node !== 'object') return seen;
  if (Array.isArray(node)) {
    for (const entry of node) schemasReachedFrom(entry, seen);
    return seen;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = /^#\/components\/schemas\/(.+)$/u.exec(value)?.[1];
      if (name !== undefined && !seen.has(name)) {
        seen.add(name);
        schemasReachedFrom(document.components.schemas[name], seen);
      }
    } else {
      schemasReachedFrom(value, seen);
    }
  }
  return seen;
}

function fieldNamesIn(schemaName: string): readonly string[] {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record['properties'] !== undefined && typeof record['properties'] === 'object') {
      collected.push(...Object.keys(record['properties'] as Record<string, unknown>));
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === '$ref') continue;
      walk(value);
    }
  };
  walk(document.components.schemas[schemaName]);
  return collected;
}

/** Field names on a schema and on everything it reaches. */
function reachableFieldNames(schemaName: string): readonly string[] {
  const names = new Set<string>([schemaName, ...schemasReachedFrom(document.components.schemas[schemaName])]);
  return [...names].flatMap((name) => fieldNamesIn(name));
}

const authoringRoutes: readonly string[] = document['x-authoring-routes'];

function isAuthoringPath(path: string): boolean {
  return authoringRoutes.includes(path);
}

describe('ADR-0009 condition 1 — the authoring route list is enumerated and closed', () => {
  it('lists exactly the /v1/authoring paths the document declares', () => {
    const declared = Object.keys(document.paths)
      .filter((path) => path.startsWith('/v1/authoring/'))
      .sort();
    expect([...authoringRoutes].sort()).toEqual(declared);
  });

  it('lists nothing that is not a path in the document', () => {
    for (const route of authoringRoutes) {
      expect(Object.keys(document.paths), route).toContain(route);
    }
  });

  // A prefix check would make `/v1/authoring-preview/...` an authoring route by
  // accident. The list is the authority; the prefix is only how it reads.
  it('is a list, not a prefix rule', () => {
    expect(SPEC_TEXT).toContain('x-authoring-routes:');
    for (const route of authoringRoutes) {
      expect(route.startsWith('/v1/authoring/'), route).toBe(true);
    }
  });
});

describe('ADR-0009 condition 2 — the check asserts both directions', () => {
  it('finds no key-bearing field on any schema a delivery response reaches', () => {
    for (const { path, method, operation } of operations()) {
      if (isAuthoringPath(path)) continue;
      const reached = schemasReachedFrom(operation.responses);
      for (const schemaName of reached) {
        // ProblemDetails is shared by both families and carries no content.
        if (schemaName === 'ProblemDetails' || schemaName === 'ErrorCode') continue;
        for (const field of fieldNamesIn(schemaName)) {
          expect(
            KEY_BEARING_FIELDS as readonly string[],
            `${method} ${path} reaches ${schemaName}.${field}`,
          ).not.toContain(field);
        }
      }
    }
  });

  // The other direction. A one-directional check passes when somebody silently
  // removes the key from the editor — a broken product nobody notices.
  it('finds the key present on the authoring schemas that are supposed to carry it', () => {
    const itemFields = reachableFieldNames('AuthoringItem');
    expect(itemFields).toContain('correctOptionId');
    expect(itemFields).toContain('correctOptionIds');
    expect(itemFields).toContain('expectedValue');
    expect(itemFields).toContain('pairs');

    const solutionFields = reachableFieldNames('AuthoringSolution');
    expect(solutionFields).toContain('finalAnswerAssertion');

    const createRequest = reachableFieldNames('AuthoringCreateItemRequest');
    expect(createRequest).toContain('correctOptionId');
  });

  it('reaches the key from every authoring route that edits or returns an item', () => {
    const keyBearing = [
      '/v1/authoring/items',
      '/v1/authoring/items/{itemId}',
      '/v1/authoring/items/{itemId}/versions/{itemVersionId}',
    ];
    for (const path of keyBearing) {
      const item = document.paths[path]!;
      const reached = new Set<string>();
      for (const method of METHODS) {
        if (item[method] === undefined) continue;
        for (const name of schemasReachedFrom(item[method])) reached.add(name);
      }
      const fields = [...reached].flatMap((name) => fieldNamesIn(name));
      expect(
        KEY_BEARING_FIELDS.some((field) => fields.includes(field)),
        `${path} carries no key`,
      ).toBe(true);
    }
  });

  it('keeps the matching pairing off the delivery item — a pairing is the key', () => {
    const delivery = fieldNamesIn('DeliveryItem');
    expect(delivery).toContain('matchingLeft');
    expect(delivery).toContain('matchingRight');
    expect(delivery).not.toContain('pairs');
  });

  it('keeps the final-answer assertion off the delivery solution', () => {
    const delivery = reachableFieldNames('DeliverySolution');
    expect(delivery).toContain('steps');
    expect(delivery).not.toContain('finalAnswerAssertion');
  });

  it('would catch a delivery schema that gained a key — the scan is not vacuous', () => {
    // The same walk, pointed at a schema that does carry one.
    const authoring = reachableFieldNames('AuthoringItem');
    expect(KEY_BEARING_FIELDS.some((field) => authoring.includes(field))).toBe(true);
  });
});

describe('ADR-0009 condition 3 — no Authoring schema is reachable from a delivery route', () => {
  it('holds for every non-authoring operation in the document', () => {
    for (const { path, method, operation } of operations()) {
      if (isAuthoringPath(path)) continue;
      const reached = schemasReachedFrom({ ...operation.responses, request: operation.requestBody });
      for (const schemaName of reached) {
        expect(schemaName.startsWith('Authoring'), `${method} ${path} reaches ${schemaName}`).toBe(false);
      }
    }
  });

  it('records that the import-graph half arrives with the controllers (M3-34, M3-44)', () => {
    // Stated rather than assumed: the structural half of condition 3 needs a
    // controller layer to assert over, and the ADR says so in its own text.
    const adr = readFileSync(
      fileURLToPath(new URL('../../../../docs/adr/ADR-0009-authoring-dtos-carry-the-answer-key.md', import.meta.url)),
      'utf8',
    );
    expect(adr).toContain('import graph');
    expect(adr).toContain('M3-44');
  });
});

describe('§8 — every error is RFC 9457 with an explicit retryable flag', () => {
  it('declares a Problem Details response on every error status', () => {
    for (const { path, method, operation } of operations()) {
      const responses = operation.responses ?? {};
      const errorStatuses = Object.keys(responses).filter((status) => /^[45]\d\d$/u.test(status));
      expect(errorStatuses.length, `${method} ${path}`).toBeGreaterThan(0);
      for (const status of errorStatuses) {
        expect(responses[status], `${method} ${path} ${status}`).toEqual({
          $ref: '#/components/responses/Problem',
        });
      }
    }
  });

  it('requires code, retryable and correlationId on the schema', () => {
    const problem = document.components.schemas['ProblemDetails']!;
    expect(problem['required']).toEqual([
      'type',
      'title',
      'status',
      'code',
      'retryable',
      'correlationId',
    ]);
  });

  it('declares the closed error taxonomy and nothing else', () => {
    expect(document.components.schemas['ErrorCode']!['enum']).toEqual([
      'Validation',
      'Authentication',
      'Authorization',
      'Entitlement',
      'NotFound',
      'Conflict',
      'PreconditionFailed',
      'RuleViolation',
      'RateLimited',
      'Unavailable',
    ]);
  });

  it('serves Problem Details under the RFC 9457 media type', () => {
    expect(SPEC_TEXT).toContain('application/problem+json');
  });

  it('declares a correlation-id header component to echo (§8)', () => {
    expect(SPEC_TEXT).toContain('X-Correlation-Id');
    expect(SPEC_TEXT).toContain('CorrelationId:');
  });
});

describe('the decimal literal never becomes a double', () => {
  it('types every numeric key field as a string (ADR-0007)', () => {
    const numeric = document.components.schemas['NumericAnswerSpec']!['properties'] as Record<
      string,
      { readonly type?: string }
    >;
    for (const field of ['expectedValue', 'toleranceValue', 'rangeMin', 'rangeMax']) {
      expect(numeric[field]?.type, field).toBe('string');
    }
  });
});

describe('API conventions (§2)', () => {
  it('uses plural kebab-case path segments', () => {
    for (const path of Object.keys(document.paths)) {
      const segments = path.replaceAll(/\{[^}]+\}/gu, '');
      expect(segments, path).not.toMatch(/[A-Z_]/u);
    }
  });

  it('declares OpenAPI 3.1', () => {
    expect(document.openapi).toBe('3.1.0');
  });
});

describe('D18 — the Zod schemas are generated, not hand-written', () => {
  const GENERATED = join(CONTRACTS, 'src/content-schemas.ts');

  it('matches what the generator produces from the current document', () => {
    const scratch = join(mkdtempSync(join(tmpdir(), 'content-zod-')), 'content-schemas.ts');
    execFileSync(
      process.execPath,
      [join(CONTRACTS, 'scripts/generate-zod.mjs'), SPEC_PATH, scratch],
      { cwd: CONTRACTS },
    );

    // Regenerated rather than compared field by field: the check that matters
    // is that the checked-in file *is* the document's output, so an edit to
    // either one alone fails here.
    expect(readFileSync(scratch, 'utf8')).toBe(readFileSync(GENERATED, 'utf8'));
  });

  it('says in its own header that it is generated', () => {
    expect(readFileSync(GENERATED, 'utf8')).toContain('GENERATED FILE — do not edit');
  });
});

/**
 * **D7 is not closed by this spec, and the deviation is recorded rather than
 * papered over.** The acceptance asks for validation against the official
 * OpenAPI 3.1 meta-schema; that document is not present in the dependency tree
 * and cannot be fetched here. What follows is a structural check written
 * against the parts of 3.1 this document uses — strictly weaker, and named as
 * such so nobody reads a green suite as meta-schema conformance.
 */
describe('structural validity (D7 remains open — this is not the meta-schema)', () => {
  it('declares the required top-level fields', () => {
    expect(document.openapi).toMatch(/^3\.1\.\d+$/u);
    expect(document.info.title).toBeTruthy();
    expect(document.info.version).toBeTruthy();
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it('resolves every $ref it declares', () => {
    const unresolved: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') {
          const [, section, name] = /^#\/components\/(\w+)\/(.+)$/u.exec(value) ?? [];
          const bucket = (document.components as unknown as Record<string, Record<string, unknown>>)[
            section ?? ''
          ];
          if (bucket === undefined || name === undefined || bucket[name] === undefined) {
            unresolved.push(value);
          }
        } else {
          walk(value);
        }
      }
    };
    walk(document);
    expect(unresolved).toEqual([]);
  });

  it('gives every response a description, which 3.1 requires', () => {
    for (const { path, method, operation } of operations()) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (typeof response === 'object' && response !== null && '$ref' in response) continue;
        expect((response as { description?: string }).description, `${method} ${path} ${status}`).toBeTruthy();
      }
    }
  });

  it('leaves no schema unreferenced, which would be a contract nobody serves', () => {
    const reachable = new Set<string>();
    for (const { operation } of operations()) {
      for (const name of schemasReachedFrom(operation)) reachable.add(name);
    }
    for (const name of schemasReachedFrom(document.components.responses)) reachable.add(name);
    expect([...Object.keys(document.components.schemas)].filter((name) => !reachable.has(name))).toEqual([]);
  });
});
