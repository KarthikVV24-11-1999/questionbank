import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { ErrorCode, ProblemDetails, TaxonomyVersionPage } from '@questionbank/contracts';
import { HandlerRegistry, type Handler } from '../contexts/curriculum/application/handler-registry.js';
import { taxonomyHandlers } from '../contexts/curriculum/application/handlers/taxonomy-handlers.js';
import { examProfileHandlers } from '../contexts/curriculum/application/handlers/exam-profile-handlers.js';
import { migrationHandlers } from '../contexts/curriculum/application/handlers/migration-handlers.js';
import { curriculumQueries } from '../contexts/curriculum/application/queries/curriculum-queries.js';

const SPEC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/contracts/openapi/curriculum.yaml',
);

interface OpenApiOperation {
  readonly operationId?: string;
  readonly 'x-handler'?: string;
  readonly parameters?: ReadonlyArray<{ readonly $ref?: string; readonly name?: string; readonly in?: string }>;
  readonly responses?: Record<string, { readonly content?: Record<string, unknown> }>;
}

type PathItem = Record<string, OpenApiOperation | unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, PathItem>;
  components: {
    parameters: Record<string, { name: string; in: string; schema?: { enum?: string[] } }>;
    schemas: Record<string, Record<string, unknown>>;
    responses: Record<string, unknown>;
  };
};

function operations(): Array<{ path: string; method: string; operation: OpenApiOperation }> {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method] !== undefined).map((method) => ({
      path,
      method,
      operation: item[method] as OpenApiOperation,
    })),
  );
}

/** Every handler the application layer actually registers. */
function registeredHandlerNames(): string[] {
  const deps = {} as never;
  const all: readonly Handler<never, unknown>[] = [
    ...taxonomyHandlers(deps),
    ...examProfileHandlers(deps),
    ...migrationHandlers(deps),
    ...curriculumQueries(deps),
  ];
  return HandlerRegistry.of(all).names.slice().sort();
}

function collectPropertyNames(node: unknown, found: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return found;

  const record = node as Record<string, unknown>;
  if (record['properties'] !== undefined && typeof record['properties'] === 'object') {
    found.push(...Object.keys(record['properties'] as Record<string, unknown>));
  }
  for (const value of Object.values(record)) collectPropertyNames(value, found);
  return found;
}

describe('OpenAPI 3.1 document', () => {
  it('declares OpenAPI 3.1 and a versioned title', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toContain('Curriculum');
    expect(spec.info.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('gives every operation an operationId and a handler', () => {
    for (const { path, method, operation } of operations()) {
      expect(operation.operationId, `${method} ${path}`).toBeTruthy();
      expect(operation['x-handler'], `${method} ${path}`).toBeTruthy();
    }
  });

  it('uses a unique operationId per operation', () => {
    const ids = operations().map((entry) => entry.operation.operationId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('versions every path and keeps paths plural and kebab-case', () => {
    for (const path of Object.keys(spec.paths)) {
      expect(path.startsWith('/v1/'), path).toBe(true);
      const literals = path.split('/').filter((segment) => segment !== '' && !segment.startsWith('{'));
      for (const segment of literals.slice(1)) {
        expect(segment, path).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
      }
    }
  });
});

describe('F15 — every public endpoint appears in the spec', () => {
  it('maps every registered handler to exactly one operation', () => {
    const declared = operations()
      .map((entry) => entry.operation['x-handler'] as string)
      .sort();

    expect(declared).toEqual(registeredHandlerNames());
  });

  it('names no handler the application layer does not register', () => {
    const registered = new Set(registeredHandlerNames());

    for (const { path, method, operation } of operations()) {
      expect(registered.has(operation['x-handler'] as string), `${method} ${path}`).toBe(true);
    }
  });

  it('covers all fifteen commands and all seven queries', () => {
    expect(operations()).toHaveLength(22);
  });
});

describe('pagination', () => {
  const listOperations = operations().filter((entry) =>
    entry.operation.operationId?.startsWith('list') === true,
  );

  it('offers cursor pagination on every list endpoint', () => {
    expect(listOperations.length).toBeGreaterThan(0);

    for (const { operation, path } of listOperations) {
      const refs = (operation.parameters ?? []).map((parameter) => parameter.$ref);
      expect(refs, path).toContain('#/components/parameters/Cursor');
      expect(refs, path).toContain('#/components/parameters/Limit');
    }
  });

  it('declares no offset parameter anywhere', () => {
    const document = readFileSync(SPEC_PATH, 'utf8');

    expect(document).not.toMatch(/name:\s*offset/u);
    expect(Object.values(spec.components.parameters).map((parameter) => parameter.name)).not.toContain(
      'offset',
    );
  });

  it('returns a page envelope with pageInfo from every list endpoint', () => {
    for (const name of ['TaxonomyVersionPage', 'ExamPage']) {
      const schema = spec.components.schemas[name] as { required: string[] };
      expect(schema.required, name).toEqual(['items', 'pageInfo']);
    }
  });
});

describe('allowlisted filter and sort fields', () => {
  it('constrains every sort parameter to an enum', () => {
    const sorts = Object.entries(spec.components.parameters).filter(([, parameter]) => parameter.name === 'sort');

    expect(sorts.length).toBeGreaterThan(0);
    for (const [name, parameter] of sorts) {
      expect(parameter.schema?.enum, name).toBeDefined();
      expect((parameter.schema?.enum ?? []).length, name).toBeGreaterThan(0);
    }
  });

  it('constrains enumerable filters to an enum', () => {
    const state = spec.components.parameters['TaxonomyVersionFilterState'];

    expect(state?.in).toBe('query');
    expect(state?.schema?.enum).toEqual(['draft', 'published', 'superseded']);
  });

  it('declares no free-form filter parameter', () => {
    const freeForm = Object.values(spec.components.parameters).filter(
      (parameter) => parameter.name === 'filter' || parameter.name === 'q',
    );

    expect(freeForm).toEqual([]);
  });
});

describe('RFC 9457 problem details', () => {
  it('declares the closed error-code taxonomy', () => {
    const errorCode = spec.components.schemas['ErrorCode'] as { enum: string[] };

    expect(errorCode.enum).toEqual([
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

  it('requires code, retryable and correlationId on every problem', () => {
    const problem = spec.components.schemas['ProblemDetails'] as { required: string[] };

    expect(problem.required).toEqual(
      expect.arrayContaining(['type', 'title', 'status', 'code', 'retryable', 'correlationId']),
    );
  });

  it('serves errors as application/problem+json', () => {
    for (const [name, response] of Object.entries(spec.components.responses)) {
      const content = (response as { content: Record<string, unknown> }).content;
      expect(Object.keys(content), name).toEqual(['application/problem+json']);
    }
  });

  it('gives every mutating operation an authorization and a conflict or validation response', () => {
    const mutations = operations().filter((entry) => entry.method !== 'get');

    for (const { path, method, operation } of mutations) {
      const codes = Object.keys(operation.responses ?? {});
      expect(codes, `${method} ${path}`).toContain('403');
      expect(codes.some((code) => code === '400' || code === '409'), `${method} ${path}`).toBe(true);
    }
  });
});

describe('concurrency and idempotency headers', () => {
  it('requires If-Match on every mutating operation that changes existing state', () => {
    const mutations = operations().filter(
      (entry) =>
        entry.method !== 'get' &&
        !['createTaxonomyDraft', 'createExam', 'createProfileDraft', 'createMigration'].includes(
          entry.operation.operationId ?? '',
        ),
    );

    for (const { path, method, operation } of mutations) {
      const refs = (operation.parameters ?? []).map((parameter) => parameter.$ref);
      expect(refs, `${method} ${path}`).toContain('#/components/parameters/IfMatch');
    }
  });

  it('requires an Idempotency-Key on publication and execution', () => {
    const idempotent = ['publishTaxonomyVersion', 'publishProfileVersion', 'supersedeProfileVersion', 'executeMigration'];

    for (const operationId of idempotent) {
      const entry = operations().find((candidate) => candidate.operation.operationId === operationId);
      const refs = (entry?.operation.parameters ?? []).map((parameter) => parameter.$ref);
      expect(refs, operationId).toContain('#/components/parameters/IdempotencyKey');
    }
  });

  it('maps If-Match to the aggregate version', () => {
    expect(spec.components.parameters['IfMatch']?.in).toBe('header');
    expect(JSON.stringify(spec.components.schemas['TaxonomyWriteResult'])).toContain('aggregateVersion');
  });
});

describe('camelCase JSON', () => {
  it('names every schema property in camelCase', () => {
    const names = new Set(collectPropertyNames(spec.components.schemas));

    expect(names.size).toBeGreaterThan(30);
    for (const name of names) {
      expect(name, name).toMatch(/^[a-z][A-Za-z0-9]*$/u);
    }
  });

  it('leaks no snake_case anywhere in the document', () => {
    const document = readFileSync(SPEC_PATH, 'utf8');
    const snakeCaseProperty = /^\s{6,}[a-z]+_[a-z]+:/mu;

    expect(document).not.toMatch(snakeCaseProperty);
  });
});

describe('generated types', () => {
  it('compiles and models the problem details shape', () => {
    const problem: ProblemDetails = {
      type: 'https://questionbank.example/problems/conflict',
      title: 'Conflict',
      status: 409,
      code: 'Conflict',
      retryable: false,
      correlationId: 'corr_1',
    };

    expect(problem.code satisfies ErrorCode).toBe('Conflict');
  });

  it('models a cursor-paginated list response', () => {
    const page: TaxonomyVersionPage = {
      items: [
        {
          taxonomyVersionId: '019fd4bc-0000-7000-8000-000000000001',
          examFamily: 'JEE',
          academicYear: '2026',
          state: 'published',
          publishedAt: '2026-08-05T08:00:00.000Z',
          nodeCount: 600,
          prerequisiteCount: 598,
          aggregateVersion: 3,
        },
      ],
      pageInfo: { hasNextPage: true, nextCursor: 'opaque' },
    };

    expect(page.items[0]?.state).toBe('published');
    expect(page.pageInfo.hasNextPage).toBe(true);
  });
});
