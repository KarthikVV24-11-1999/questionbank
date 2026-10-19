import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { toProblemDetails } from '../contexts/generation/api/problem-details.js';
import { startGenerationRunSchema, runIdSchema, candidateIdSchema } from '../contexts/generation/api/dto/generation-schemas.js';
import { GENERATION_POLICIES } from '../contexts/generation/application/policies.js';
import { HandlerRegistry, type Handler } from '../contexts/generation/application/handler-registry.js';
import { CANDIDATE_STATES, VERDICT_OUTCOMES } from '../contexts/generation/domain/generation-candidate.js';
import { PRECHECK_IDS } from '../contexts/generation/domain/precheck-vocabulary.js';
import { ROLES } from '../platform/auth/roles.js';

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const SPEC_TEXT = read('../../../../packages/contracts/openapi/generation.yaml');
const CONTROLLER = read('../contexts/generation/api/generation.controller.ts');

interface OpenApi {
  readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>>;
  readonly 'x-authoring-routes'?: readonly string[];
  readonly components: { readonly schemas: Record<string, { readonly enum?: readonly string[]; readonly required?: readonly string[]; readonly properties?: Record<string, unknown> }> };
}

const SPEC = parse(SPEC_TEXT) as OpenApi;
const document = (name: string): OpenApi => parse(read(`../../../../packages/contracts/openapi/${name}.yaml`)) as OpenApi;

const declaredHandlers = Object.values(SPEC.paths).flatMap((item) =>
  Object.values(item).map((operation) => operation['x-handler'] as string),
);

const POLICY_BY_NAME = Object.fromEntries(GENERATION_POLICIES.map((entry) => [entry.name, entry]));

/** The set difference both ways: what the document lists that it lacks, and what it has that the list lacks. */
function authoringRouteDrift(spec: Pick<OpenApi, 'paths' | 'x-authoring-routes'>): { readonly unlisted: string[]; readonly missing: string[] } {
  const listed = spec['x-authoring-routes'] ?? [];
  const paths = Object.keys(spec.paths);
  return { unlisted: paths.filter((path) => !listed.includes(path)), missing: listed.filter((route) => !paths.includes(route)) };
}

describe('F15 — every endpoint reconciles with a real handler', () => {
  it('names a handler on every operation, and exactly these five', () => {
    expect(Object.values(SPEC.paths).flatMap((item) => Object.keys(item))).toHaveLength(5);
    expect([...declaredHandlers].sort()).toEqual(['AcceptCandidate', 'GetCandidate', 'ListRunCandidates', 'RejectCandidate', 'StartGenerationRun']);
  });

  it('names only handlers that exist and declare a policy (F36)', () => {
    for (const name of declaredHandlers) {
      expect(Object.keys(POLICY_BY_NAME), name).toContain(name);
      expect(POLICY_BY_NAME[name]!.allowedRoles.length, name).toBeGreaterThan(0);
    }
  });

  it('routes each declared handler from the controller, and routes no other', () => {
    for (const name of declaredHandlers) expect(CONTROLLER, name).toContain(`'${name}'`);
    const routed = [...CONTROLLER.matchAll(/this\.run\(response, headers, '(\w+)'/gu)].map((match) => match[1]);
    expect(routed.sort()).toEqual([...declaredHandlers].sort());
  });

  it('serves exactly the document’s paths and methods: the controller’s routes, set against the document’s', () => {
    const served = [...CONTROLLER.matchAll(/@(Get|Post)\('([^']+)'\)/gu)].map(
      (match) => `${(match[1] as string).toLowerCase()} ${(match[2] as string).replaceAll(/:(\w+)/gu, '{$1}')}`,
    );
    const documented = Object.entries(SPEC.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`));
    expect(served.sort()).toEqual(documented.sort());
  });

  it('registers every declared handler without boot failing', () => {
    const handlers = declaredHandlers.map((name) => ({
      name,
      policy: POLICY_BY_NAME[name]!,
      async handle() {
        return { ok: true as const, value: undefined };
      },
    }));
    expect(HandlerRegistry.of(handlers as unknown as Handler<never, unknown>[]).names).toHaveLength(5);
  });
});

describe('F33 — no live inference behind a request path', () => {
  // The handlers the context declares that have no route, asserted as a set: a tenth handler
  // with no routing decision fails here, so every handler is routed or deliberately not.
  it('leaves exactly the six handlers that call a model, write a verdict, set a budget, record an evaluation, or act on the battery, without a route', () => {
    const unrouted = GENERATION_POLICIES.map((entry) => entry.name).filter((name) => !declaredHandlers.includes(name));
    expect(unrouted.sort()).toEqual(['DeclareAIBudget', 'DisposeCandidate', 'ProposeCandidate', 'RecordEvaluationRun', 'RecordPrecheckVerdict', 'RunPrecheckBattery']);
  });

  it('names neither of the two handlers that reach a provider, in the document or the controller', () => {
    for (const name of ['ProposeCandidate', 'RunPrecheckBattery']) {
      expect(SPEC_TEXT, name).not.toContain(name);
      expect(CONTROLLER.replace(/\/\*\*[\s\S]*?\*\//gu, ''), name).not.toContain(name);
    }
  });
});

describe('INV-01 — what the pipeline may and may not reach over HTTP', () => {
  it('admits no learner or guest role to any handler a route reaches', () => {
    for (const name of declaredHandlers) {
      const roles = POLICY_BY_NAME[name]!.allowedRoles;
      expect(roles, name).not.toContain(ROLES.learner);
      expect(roles, name).not.toContain(ROLES.guest);
    }
  });

  it('lets only Content Ops read a candidate, because it carries the answer key', () => {
    expect([...POLICY_BY_NAME['GetCandidate']!.allowedRoles]).toEqual([ROLES.contentOps]);
    expect([...POLICY_BY_NAME['ListRunCandidates']!.allowedRoles]).toEqual([ROLES.contentOps]);
  });

  it('puts the manual override with Content Ops alone, and the pipeline’s disposition with the pipeline alone (ADR-0029)', () => {
    expect([...POLICY_BY_NAME['AcceptCandidate']!.allowedRoles]).toEqual([ROLES.contentOps]);
    expect([...POLICY_BY_NAME['RejectCandidate']!.allowedRoles]).toEqual([ROLES.contentOps]);
    expect([...POLICY_BY_NAME['DisposeCandidate']!.allowedRoles]).toEqual([ROLES.generationPipeline]);
  });

  it('lets the machine and Content Ops start a run, and nobody else', () => {
    expect([...POLICY_BY_NAME['StartGenerationRun']!.allowedRoles].sort()).toEqual([ROLES.contentOps, ROLES.generationPipeline].sort());
  });
});

describe('ADR-0009 / ADR-0028 — the routes are the enumerated authoring family', () => {
  it('mounts every path under /v1/authoring/', () => {
    for (const path of Object.keys(SPEC.paths)) expect(path.startsWith('/v1/authoring/'), path).toBe(true);
  });

  it('lists exactly the document’s paths, in both directions', () => {
    expect(authoringRouteDrift(SPEC)).toEqual({ unlisted: [], missing: [] });
    expect([...(SPEC['x-authoring-routes'] ?? [])].sort()).toEqual(Object.keys(SPEC.paths).sort());
  });

  describe('is red on a planted drift', () => {
    it('a path added without being listed', () => {
      const drift = authoringRouteDrift({ paths: { ...SPEC.paths, '/v1/authoring/generation-runs/planted': {} }, 'x-authoring-routes': SPEC['x-authoring-routes'] as string[] });
      expect(drift).toEqual({ unlisted: ['/v1/authoring/generation-runs/planted'], missing: [] });
    });

    it('a listed path that no longer exists', () => {
      const drift = authoringRouteDrift({ paths: {}, 'x-authoring-routes': ['/v1/authoring/generation-runs'] });
      expect(drift).toEqual({ unlisted: [], missing: ['/v1/authoring/generation-runs'] });
    });

    it('a path that only looks like the family: a prefix check would admit it, the list does not', () => {
      const lookalike = '/v1/authoring-preview/generation-runs';
      expect(lookalike.startsWith('/v1/authoring')).toBe(true);
      expect(lookalike.startsWith('/v1/authoring/')).toBe(false);
      expect(authoringRouteDrift({ paths: { [lookalike]: {} }, 'x-authoring-routes': [] }).unlisted).toEqual([lookalike]);
    });
  });

  it('is the only document besides content’s to declare an authoring path, and shares no path with content’s list', () => {
    expect(Object.keys(document('curriculum').paths).filter((path) => path.startsWith('/v1/authoring'))).toEqual([]);
    expect(Object.keys(document('scoring').paths).filter((path) => path.startsWith('/v1/authoring'))).toEqual([]);
    const contentList = document('content')['x-authoring-routes'] ?? [];
    expect(Object.keys(SPEC.paths).filter((path) => contentList.includes(path))).toEqual([]);
  });
});

describe('the document’s vocabulary is the code’s, as sets in both directions', () => {
  const enumOf = (schema: string): string[] => [...((SPEC.components.schemas[schema] as { enum: readonly string[] }).enum)].sort();

  it('candidate states', () => expect(enumOf('CandidateState')).toEqual([...CANDIDATE_STATES].sort()));
  it('verdict outcomes', () => expect(enumOf('VerdictOutcome')).toEqual([...VERDICT_OUTCOMES].sort()));
  it('the twelve checks', () => {
    expect(enumOf('PrecheckId')).toEqual([...PRECHECK_IDS].sort());
    expect(enumOf('PrecheckId')).toHaveLength(12);
  });

  it('the pin is the three registry references and nothing the caller can choose beyond two of them', () => {
    expect([...(SPEC.components.schemas['ModelPin']!.required ?? [])].sort()).toEqual(['modelVersionId', 'promptVersionId', 'runId']);
    expect(Object.keys(SPEC.components.schemas['StartGenerationRunRequest']!.properties ?? {}).sort()).toEqual(['budgetTokens', 'modelVersionId', 'promptVersionId', 'request']);
  });
});

describe('boundary validation accepts what the document says and refuses what it does not', () => {
  const ID = '00000000-0000-4000-8000-000000000001';

  it('a run request carries the two registry ids, an object and a reservation in tokens, and nothing else', () => {
    expect(startGenerationRunSchema.safeParse({ modelVersionId: ID, promptVersionId: ID, request: { itemType: 'x' }, budgetTokens: 5000 }).success).toBe(true);
    for (const bad of [
      { promptVersionId: ID, request: {}, budgetTokens: 1 },
      { modelVersionId: ID, promptVersionId: 'not-a-uuid', request: {}, budgetTokens: 1 },
      { modelVersionId: ID, promptVersionId: ID, request: 'a string', budgetTokens: 1 },
      { modelVersionId: ID, promptVersionId: ID, request: {}, runId: ID, budgetTokens: 1 },
      { modelVersionId: ID, promptVersionId: ID, request: {}, requestedAt: '2026-01-01T00:00:00.000Z', budgetTokens: 1 },
      // The reservation is required, and is a positive whole number of tokens.
      { modelVersionId: ID, promptVersionId: ID, request: {} },
      { modelVersionId: ID, promptVersionId: ID, request: {}, budgetTokens: 0 },
      { modelVersionId: ID, promptVersionId: ID, request: {}, budgetTokens: -1 },
      { modelVersionId: ID, promptVersionId: ID, request: {}, budgetTokens: 1.5 },
      { modelVersionId: ID, promptVersionId: ID, request: {}, budgetTokens: '5000' },
    ]) {
      expect(startGenerationRunSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a path identifier is a UUID', () => {
    expect(runIdSchema.safeParse({ runId: ID }).success).toBe(true);
    expect(runIdSchema.safeParse({ runId: 'nope' }).success).toBe(false);
    expect(candidateIdSchema.safeParse({ candidateId: ID }).success).toBe(true);
    expect(candidateIdSchema.safeParse({ candidateId: 'nope' }).success).toBe(false);
  });
});

describe('§8 — every error is RFC 9457 with an explicit retryable flag', () => {
  it('declares Problem Details on every error response in the document', () => {
    expect([...SPEC_TEXT.matchAll(/'(4\d\d|5\d\d)':\s*\{ \$ref: '#\/components\/responses\/Problem' \}/gu)].length).toBeGreaterThan(0);
  });

  it('requires code, retryable and correlationId on the schema, and declares the closed taxonomy', () => {
    expect(SPEC_TEXT).toContain('required: [type, title, status, code, retryable, correlationId]');
    expect(SPEC_TEXT).toContain('Validation,\n          Authentication,');
    expect(SPEC_TEXT).toContain('Unavailable,\n        ]');
  });

  it('sets retryable explicitly for every kind, and marks only transient ones retryable', () => {
    const kinds = ['Validation', 'Authentication', 'Authorization', 'Entitlement', 'NotFound', 'Conflict', 'PreconditionFailed', 'RuleViolation', 'RateLimited', 'Unavailable'] as const;
    for (const kind of kinds) {
      const problem = toProblemDetails({ kind, code: kind, message: 'x' }, 'c-1');
      expect(typeof problem.retryable, kind).toBe('boolean');
      expect(problem.correlationId, kind).toBe('c-1');
    }
    expect(toProblemDetails({ kind: 'Unavailable', code: 'x', message: 'x' }, 'c').retryable).toBe(true);
    expect(toProblemDetails({ kind: 'RateLimited', code: 'x', message: 'x' }, 'c').retryable).toBe(true);
    expect(toProblemDetails({ kind: 'Validation', code: 'x', message: 'x' }, 'c').retryable).toBe(false);
    expect(toProblemDetails({ kind: 'PreconditionFailed', code: 'x', message: 'x' }, 'c').retryable).toBe(false);
  });

  it('leaks no stack trace, SQL or internal identifier', () => {
    expect(JSON.stringify(toProblemDetails({ kind: 'Conflict', code: 'x', message: 'a conflict' }, 'c-1'))).not.toMatch(/SELECT |INSERT |at Object\./u);
  });
});

describe('API conventions (§2)', () => {
  it('uses plural kebab-case path segments', () => {
    for (const path of Object.keys(SPEC.paths)) expect(path.replaceAll(/\{[^}]+\}/gu, ''), path).not.toMatch(/[A-Z_]/u);
  });
});
