import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HandlerRegistry, type Handler } from '../contexts/scoring/application/handler-registry.js';
import {
  SCORE_ATTEMPT_POLICY,
} from '../contexts/scoring/application/handlers/scoring-handlers.js';
import {
  APPROVE_RESCORING_POLICY,
  DRAFT_RESCORING_POLICY,
  EXECUTE_RESCORING_POLICY,
  RUN_RESCORING_DRY_RUN_POLICY,
} from '../contexts/scoring/application/handlers/rescoring-handlers.js';
import {
  GET_DRY_RUN_POLICY,
  GET_SCORE_RECORD_POLICY,
  LIST_GENERATIONS_POLICY,
} from '../contexts/scoring/application/queries/scoring-queries.js';
import { toProblemDetails } from '../contexts/scoring/api/problem-details.js';

const SPEC = readFileSync(
  fileURLToPath(new URL('../../../../packages/contracts/openapi/scoring.yaml', import.meta.url)),
  'utf8',
);
const CONTROLLER = readFileSync(
  fileURLToPath(new URL('../contexts/scoring/api/scoring.controller.ts', import.meta.url)),
  'utf8',
);

const declaredHandlers = [...SPEC.matchAll(/x-handler:\s*(\w+)/gu)].map((match) => match[1] as string);

const HANDLER_POLICIES = {
  ScoreAttempt: SCORE_ATTEMPT_POLICY,
  DraftRescoring: DRAFT_RESCORING_POLICY,
  RunRescoringDryRun: RUN_RESCORING_DRY_RUN_POLICY,
  ApproveRescoring: APPROVE_RESCORING_POLICY,
  ExecuteRescoring: EXECUTE_RESCORING_POLICY,
  GetScoreRecord: GET_SCORE_RECORD_POLICY,
  ListScoreRecordGenerations: LIST_GENERATIONS_POLICY,
  GetRescoringDryRun: GET_DRY_RUN_POLICY,
} as const;

describe('F15 — every endpoint reconciles with a real handler', () => {
  it('names a handler on every operation', () => {
    const operations = [...SPEC.matchAll(/operationId:\s*\w+/gu)];
    expect(declaredHandlers).toHaveLength(operations.length);
  });

  it('names only handlers that exist and declare a policy', () => {
    for (const name of declaredHandlers) {
      expect(Object.keys(HANDLER_POLICIES), name).toContain(name);
      const policy = HANDLER_POLICIES[name as keyof typeof HANDLER_POLICIES];
      expect(policy.allowedRoles.length, name).toBeGreaterThan(0);
    }
  });

  it('routes each declared handler from the controller', () => {
    for (const name of declaredHandlers) {
      expect(CONTROLLER, name).toContain(`'${name}'`);
    }
  });

  it('registers every declared handler without boot failing', () => {
    const handlers = declaredHandlers.map((name) => ({
      name,
      policy: HANDLER_POLICIES[name as keyof typeof HANDLER_POLICIES],
      async handle() {
        return { ok: true as const, value: undefined };
      },
    }));
    expect(HandlerRegistry.of(handlers as unknown as Handler<never, unknown>[]).names).toHaveLength(
      declaredHandlers.length,
    );
  });
});

describe('consequential operations are guarded', () => {
  it('requires step-up for approval and execution', () => {
    expect(APPROVE_RESCORING_POLICY.requiresStepUp).toBe(true);
    expect(EXECUTE_RESCORING_POLICY.requiresStepUp).toBe(true);
  });

  it('restricts approval and execution to admin', () => {
    expect([...APPROVE_RESCORING_POLICY.allowedRoles]).toEqual(['admin']);
    expect([...EXECUTE_RESCORING_POLICY.allowedRoles]).toEqual(['admin']);
  });

  it('does not require step-up merely to read a score', () => {
    expect(GET_SCORE_RECORD_POLICY.requiresStepUp).toBe(false);
  });
});

describe('§8 — every error is RFC 9457 with an explicit retryable flag', () => {
  it('declares Problem Details on every error response in the spec', () => {
    const errorResponses = [...SPEC.matchAll(/'(4\d\d|5\d\d)':\s*\{ \$ref: '#\/components\/responses\/Problem' \}/gu)];
    expect(errorResponses.length).toBeGreaterThan(0);
  });

  it('requires code, retryable and correlationId on the schema', () => {
    expect(SPEC).toContain('required: [type, title, status, code, retryable, correlationId]');
  });

  it('sets retryable explicitly for every error kind', () => {
    const kinds = [
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
    ] as const;
    for (const kind of kinds) {
      const problem = toProblemDetails({ kind, code: kind, message: 'x' }, 'c-1');
      expect(typeof problem.retryable, kind).toBe('boolean');
      expect(problem.correlationId, kind).toBe('c-1');
    }
  });

  it('marks only transient failures retryable', () => {
    expect(toProblemDetails({ kind: 'Unavailable', code: 'x', message: 'x' }, 'c').retryable).toBe(true);
    expect(toProblemDetails({ kind: 'RateLimited', code: 'x', message: 'x' }, 'c').retryable).toBe(true);
    expect(toProblemDetails({ kind: 'Validation', code: 'x', message: 'x' }, 'c').retryable).toBe(false);
    expect(toProblemDetails({ kind: 'RuleViolation', code: 'x', message: 'x' }, 'c').retryable).toBe(false);
  });

  it('leaks no stack trace, SQL or internal identifier', () => {
    const problem = toProblemDetails(
      { kind: 'Conflict', code: 'x', message: 'a conflict' },
      'c-1',
    );
    expect(JSON.stringify(problem)).not.toMatch(/SELECT |INSERT |at Object\./u);
  });
});

describe('§9 rule 10 — the contract exposes no answer key', () => {
  const FORBIDDEN = ['answerKey', 'answer_key', 'correctOptionId', 'correctOptionIds', 'expectedValue', 'responseSnapshot', 'solution'];

  it('names none of them anywhere in the document', () => {
    for (const field of FORBIDDEN) {
      expect(SPEC, field).not.toContain(field);
    }
  });

  it('names none of them in the controller or its DTOs', () => {
    const dtos = readFileSync(
      fileURLToPath(new URL('../contexts/scoring/api/dto/scoring-schemas.ts', import.meta.url)),
      'utf8',
    );
    for (const field of FORBIDDEN) {
      expect(CONTROLLER, field).not.toContain(field);
      expect(dtos, field).not.toContain(field);
    }
  });
});

describe('marks cross the wire as exact decimals', () => {
  it('types every mark as a string, never a number', () => {
    expect(SPEC).toContain("Marks:\n      type: string");
    // If any mark field were a number, a client would parse it as a double.
    const markFields = [...SPEC.matchAll(/(marksAwarded|marksAvailable|totalRaw|totalMaxAvailable|raw|maxAvailable|delta|before|after|largestGain|largestLoss):\s*\{[^}]*\}/gu)];
    for (const [declaration] of markFields) {
      expect(declaration).toContain('Marks');
    }
  });
});

describe('API conventions (§2)', () => {
  it('uses plural kebab-case paths', () => {
    const paths = [...SPEC.matchAll(/^ {2}(\/v1\/[^:\n]+):/gmu)].map((match) => match[1] as string);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      // Parameters are camelCase by §2; the convention governs the segments.
      const segments = path.replaceAll(/\{[^}]+\}/gu, '');
      expect(segments, path).not.toMatch(/[A-Z_]/u);
    }
  });

  it('declares the closed error taxonomy and nothing else', () => {
    expect(SPEC).toContain('Validation,\n          Authentication,');
    expect(SPEC).toContain('Unavailable,\n        ]');
  });
});
