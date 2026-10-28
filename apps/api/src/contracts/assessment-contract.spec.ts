import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../platform/config/config.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { toProblemDetails, validationProblem } from '../contexts/assessment/api/problem-details.js';
import { assembleDraftFormSchema, attemptIdSchema, createAttemptSchema, formIdSchema, ingestEventsSchema, scheduleFormSchema, submitAttemptSchema } from '../contexts/assessment/api/dto/assessment-schemas.js';
import { composeAssessmentHandlers } from '../contexts/assessment/application/compose-handlers.js';
import { HandlerRegistry, type Handler } from '../contexts/assessment/application/handler-registry.js';
import {
  ASSEMBLE_DRAFT_FORM_POLICY,
  GET_FORM_PACKAGE_POLICY,
  GET_PACKAGE_SIGNING_KEY_POLICY,
  CREATE_ATTEMPT_POLICY,
  GET_ATTEMPT_RESULT_POLICY,
  SUBMIT_EXPIRED_ATTEMPTS_POLICY,
  START_ATTEMPT_POLICY,
  GET_ATTEMPT_POLICY,
  GET_SLOT_SOLUTION_POLICY,
  INGEST_RESPONSE_EVENTS_POLICY,
  SUBMIT_ATTEMPT_POLICY,
  GET_FORM_POLICY,
  PUBLISH_FORM_POLICY,
  SCHEDULE_FORM_POLICY,
  SWEEP_WINDOWS_POLICY,
} from '../contexts/assessment/application/policies.js';
import { BLUEPRINT_DIFFICULTY_BANDS, BLUEPRINT_ITEM_TYPES } from '../contexts/assessment/domain/blueprint.js';
import { FORM_STATES } from '../contexts/assessment/domain/form-state.js';
import { InMemoryAttempts, InMemoryContent, InMemoryForms, InMemoryResponses, InMemorySolutionReleases, StubCorpus, StubJudge, StubPins, StubSolutions, StubScoreRecords, aSigner } from '../testing/assessment-fakes.js';
import { ROLES } from '../platform/auth/roles.js';

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const SPEC_TEXT = read('../../../../packages/contracts/openapi/assessment.yaml');
const CONTROLLER = read('../contexts/assessment/api/assessment.controller.ts');

interface Schema {
  readonly enum?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: Record<string, unknown>;
}
interface OpenApi {
  readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>>;
  readonly 'x-assessment-routes'?: readonly string[];
  readonly components: { readonly schemas: Record<string, Schema> };
}
const SPEC = parse(SPEC_TEXT) as OpenApi;
const document = (name: string): OpenApi => parse(read(`../../../../packages/contracts/openapi/${name}.yaml`)) as OpenApi;

const declaredHandlers = Object.values(SPEC.paths).flatMap((item) => Object.values(item).map((operation) => operation['x-handler'] as string));
const OPERATOR_HANDLERS = ['AssembleDraftForm', 'GetForm', 'PublishForm', 'ScheduleForm'];
const STUDENT_HANDLERS = ['GetFormPackage', 'GetPackageSigningKey', 'CreateAttempt', 'StartAttempt', 'GetAttempt', 'GetAttemptResult', 'GetSlotSolution', 'IngestResponseEvents', 'SubmitAttempt'];
const POLICIES = [GET_ATTEMPT_RESULT_POLICY, GET_SLOT_SOLUTION_POLICY, SUBMIT_EXPIRED_ATTEMPTS_POLICY, CREATE_ATTEMPT_POLICY, START_ATTEMPT_POLICY, GET_ATTEMPT_POLICY, INGEST_RESPONSE_EVENTS_POLICY, SUBMIT_ATTEMPT_POLICY, ASSEMBLE_DRAFT_FORM_POLICY, GET_FORM_PACKAGE_POLICY, GET_PACKAGE_SIGNING_KEY_POLICY, GET_FORM_POLICY, PUBLISH_FORM_POLICY, SCHEDULE_FORM_POLICY, SWEEP_WINDOWS_POLICY];
const POLICY_BY_NAME = Object.fromEntries(POLICIES.map((entry) => [entry.name, entry]));

/** The set difference both ways: what the document lists that it lacks, and what it has that the list lacks. */
function routeDrift(spec: Pick<OpenApi, 'paths' | 'x-assessment-routes'>): { readonly unlisted: string[]; readonly missing: string[] } {
  const listed = spec['x-assessment-routes'] ?? [];
  const paths = Object.keys(spec.paths);
  return { unlisted: paths.filter((path) => !listed.includes(path)), missing: listed.filter((route) => !paths.includes(route)) };
}

describe('F15 — every endpoint reconciles with a real handler', () => {
  it('names a handler on every operation, and exactly these thirteen: four an operator calls, nine a student does', () => {
    expect(Object.values(SPEC.paths).flatMap((item) => Object.keys(item))).toHaveLength(13);
    expect([...declaredHandlers].sort()).toEqual([...OPERATOR_HANDLERS, ...STUDENT_HANDLERS].sort());
  });

  it('names only handlers that exist and declare a policy (F36)', () => {
    for (const name of declaredHandlers) {
      expect(Object.keys(POLICY_BY_NAME), name).toContain(name);
      expect(POLICY_BY_NAME[name]!.allowedRoles.length, name).toBeGreaterThan(0);
    }
  });

  it('routes each declared handler from the controller, and routes no other', () => {
    const routed = [...CONTROLLER.matchAll(/this\.run\(response, headers, '(\w+)'/gu)].map((match) => match[1]);
    expect(routed.sort()).toEqual([...declaredHandlers].sort());
  });

  it('serves exactly the document’s paths and methods', () => {
    const served = [...CONTROLLER.matchAll(/@(Get|Post)\('([^']+)'\)/gu)].map(
      (match) => `${(match[1] as string).toLowerCase()} ${(match[2] as string).replaceAll(/:(\w+)/gu, '{$1}')}`,
    );
    const documented = Object.entries(SPEC.paths).flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`));
    expect(served.sort()).toEqual(documented.sort());
  });

  it('registers every declared handler without boot failing', () => {
    const handlers = declaredHandlers.map((name) => ({ name, policy: POLICY_BY_NAME[name]!, async handle() { return { ok: true as const, value: undefined }; } }));
    expect(HandlerRegistry.of(handlers as unknown as Handler<never, unknown>[]).names).toHaveLength(13);
  });
});

describe('the scheduler\'s commands have no route (D36)', () => {
  it('leaves the composed handlers without a route named, as a set', () => {
    const registry = composeAssessmentHandlers({
      forms: new InMemoryForms(),
      attempts: new InMemoryAttempts(),
      responses: new InMemoryResponses(),
      content: new InMemoryContent(),
      corpus: new StubCorpus({ candidates: [], exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] }),
      clock: { now: () => new Date() },
      identifiers: { next: () => 'id' },
      audit: { record: async () => undefined },
      signer: aSigner(),
      pins: new StubPins(),
      practicePins: new StubPins(),
      judge: new StubJudge(),
      releases: new InMemorySolutionReleases(),
      solutions: new StubSolutions(),
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    scoreRecord: new StubScoreRecords(),
    });
    const unrouted = registry.names.filter((name) => !declaredHandlers.includes(name));
    // The practice commands have no route yet (D78): the learner surfaces are Track H's. They are a learner's, not the scheduler's.
    expect([...unrouted].sort()).toEqual(['CreatePracticeAttempt', 'GetPracticeFeedback', 'GrowPracticeAttempt', 'SubmitExpiredAttempts', 'SweepWindows']);
    expect([...POLICY_BY_NAME['SubmitExpiredAttempts']!.allowedRoles]).toEqual([ROLES.system]);
    expect(CONTROLLER.replace(/\/\*\*[\s\S]*?\*\//gu, '')).not.toContain('SubmitExpiredAttempts');
    expect([...POLICY_BY_NAME['SweepWindows']!.allowedRoles]).toEqual([ROLES.system]);
    expect(SPEC_TEXT.replace(/^ {4}.*$/gmu, '')).not.toContain('x-handler: SweepWindows');
    expect(CONTROLLER.replace(/\/\*\*[\s\S]*?\*\//gu, '')).not.toContain('SweepWindows');
  });
});

describe('INV-01 — who may reach what', () => {
  it('admits no learner or guest to any operator route', () => {
    for (const name of OPERATOR_HANDLERS) {
      expect(POLICY_BY_NAME[name]!.allowedRoles, name).not.toContain(ROLES.learner);
      expect(POLICY_BY_NAME[name]!.allowedRoles, name).not.toContain(ROLES.guest);
    }
  });

  it('admits a learner to exactly the student routes, and no guest to either', () => {
    for (const name of STUDENT_HANDLERS) {
      expect(POLICY_BY_NAME[name]!.allowedRoles, name).toContain(ROLES.learner);
      expect(POLICY_BY_NAME[name]!.allowedRoles, name).not.toContain(ROLES.guest);
    }
    expect(declaredHandlers.filter((name) => POLICY_BY_NAME[name]!.allowedRoles.includes(ROLES.learner)).sort()).toEqual([...STUDENT_HANDLERS].sort());
  });

  it('keeps what changes what students are offered a person\'s: system cannot publish or schedule', () => {
    expect([...POLICY_BY_NAME['PublishForm']!.allowedRoles]).toEqual([ROLES.contentOps]);
    expect([...POLICY_BY_NAME['ScheduleForm']!.allowedRoles]).toEqual([ROLES.contentOps]);
    expect(POLICY_BY_NAME['PublishForm']!.requiresStepUp).toBe(true);
  });
});

describe('ADR-0009 / ADR-0033 — these routes are not the authoring family, and carry no key', () => {
  it('mounts every path under /v1/assessment/ and none under /v1/authoring/', () => {
    for (const path of Object.keys(SPEC.paths)) {
      expect(path.startsWith('/v1/assessment/'), path).toBe(true);
      expect(path.startsWith('/v1/authoring/'), path).toBe(false);
    }
  });

  it('lists exactly the document’s paths, in both directions', () => {
    expect(routeDrift(SPEC)).toEqual({ unlisted: [], missing: [] });
  });

  describe('is red on a planted drift', () => {
    it('a path the list does not name', () => {
      const drift = routeDrift({ paths: { ...SPEC.paths, '/v1/assessment/forms/planted': {} }, 'x-assessment-routes': SPEC['x-assessment-routes'] as string[] });
      expect(drift).toEqual({ unlisted: ['/v1/assessment/forms/planted'], missing: [] });
    });

    it('a listed path the document lost', () => {
      expect(routeDrift({ paths: {}, 'x-assessment-routes': ['/v1/assessment/forms'] })).toEqual({ unlisted: [], missing: ['/v1/assessment/forms'] });
    });
  });

  it('no other document declares an assessment path, and this one declares no authoring path', () => {
    for (const name of ['content', 'curriculum', 'scoring', 'generation']) {
      expect(Object.keys(document(name).paths).filter((path) => path.startsWith('/v1/assessment/')), name).toEqual([]);
    }
    expect(Object.keys(SPEC.paths).filter((path) => path.startsWith('/v1/authoring'))).toEqual([]);
  });

  const KEY_NAMES = ['correctOptionId', 'correctOptionIds', 'isCorrect', 'answerKey', 'expectedValue', 'finalAnswerAssertion', 'responseSpec', 'pairs', 'stem', 'options', 'solution'];
  const keyNamesIn = (schemas: unknown): string[] => {
    const names = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          names.add(key);
          collect(inner);
        }
      }
    };
    collect(schemas);
    return KEY_NAMES.filter((field) => names.has(field));
  };

  it('declares no schema field that names key material', () => {
    expect(keyNamesIn(SPEC.components.schemas)).toEqual([]);
  });

  it('and that scan is not vacuous: it finds a key field planted in a schema, however deep', () => {
    expect(keyNamesIn({ Planted: { type: 'object', properties: { nested: { items: { properties: { correctOptionId: { type: 'string' }, solution: {} } } } } } })).toEqual(['correctOptionId', 'solution']);
  });
});

describe('the document and the validators agree', () => {
  it('names the item types, bands and states the domain has', () => {
    const schemas = SPEC.components.schemas;
    expect([...(schemas['ItemType']!.enum ?? [])]).toEqual([...BLUEPRINT_ITEM_TYPES]);
    expect([...(schemas['DifficultyBand']!.enum ?? [])]).toEqual([...BLUEPRINT_DIFFICULTY_BANDS]);
    const form = schemas['Form']!.properties as Record<string, { enum?: string[] }>;
    expect(form['state']!.enum).toEqual([...FORM_STATES]);
  });

  it('requires what the validator requires of an assembly request', () => {
    const required = SPEC.components.schemas['AssembleDraftFormRequest']!.required ?? [];
    expect([...required].sort()).toEqual(['blueprint', 'sessionRefs']);
    const good = {
      blueprint: { examProfileVersionId: '00000000-0000-4000-8000-000000000001', formType: 'mock', totalMarks: 4, difficultyTolerance: 0, sections: [{ ordinal: 1, sectionSpecRef: 's', itemCount: 1, typeMix: { NUMERIC: 1 }, marksPerItem: 4, difficultyTarget: { advanced: 1 } }] },
      sessionRefs: ['a'],
    };
    expect(assembleDraftFormSchema.safeParse(good).success).toBe(true);
    for (const field of required) expect(assembleDraftFormSchema.safeParse({ ...good, [field]: undefined }).success, field).toBe(false);
    expect(assembleDraftFormSchema.safeParse({ ...good, formId: 'x' }).success).toBe(false);
    expect(assembleDraftFormSchema.safeParse({ ...good, subject: 'physics', maxSteps: 5 }).success).toBe(true);
  });

  it('requires what the validators require of an id and a window', () => {
    expect(formIdSchema.safeParse({ formId: '00000000-0000-4000-8000-000000000001' }).success).toBe(true);
    expect(formIdSchema.safeParse({ formId: 'nope' }).success).toBe(false);
    expect([...(SPEC.components.schemas['ScheduleFormRequest']!.required ?? [])].sort()).toEqual(['closesAt', 'opensAt']);
    const window = { formId: '00000000-0000-4000-8000-000000000001', opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' };
    expect(scheduleFormSchema.safeParse(window).success).toBe(true);
    expect(scheduleFormSchema.safeParse({ ...window, opensAt: '2026-10-21T08:00:00+05:30' }).success).toBe(false);
  });
});

describe('Problem Details', () => {
  it('maps every kind to the status the platform fixes, and says whether it is retryable', () => {
    const expected: Record<string, [number, boolean]> = {
      Validation: [400, false],
      Authentication: [401, false],
      Authorization: [403, false],
      Entitlement: [402, false],
      NotFound: [404, false],
      Conflict: [409, false],
      PreconditionFailed: [412, false],
      RuleViolation: [422, false],
      RateLimited: [429, true],
      Unavailable: [503, true],
    };
    for (const [kind, [status, retryable]] of Object.entries(expected)) {
      const body = toProblemDetails({ kind: kind as never, code: 'X', message: 'm' }, 'corr');
      expect([body.status, body.retryable, body.correlationId, body.reason], kind).toEqual([status, retryable, 'corr', 'X']);
    }
  });

  it('carries the blocking constraint when there is one, and the specific refusal always', () => {
    const body = toProblemDetails({ kind: 'RuleViolation', code: 'ASSEMBLY_INFEASIBLE', message: 'm', detail: { constraint: 'TYPE_MIX' } }, 'corr');
    expect(body).toMatchObject({ reason: 'ASSEMBLY_INFEASIBLE', constraint: 'TYPE_MIX' });
    expect('constraint' in toProblemDetails({ kind: 'RuleViolation', code: 'X', message: 'm' }, 'corr')).toBe(false);
    expect('constraint' in toProblemDetails({ kind: 'RuleViolation', code: 'X', message: 'm', detail: { constraint: 5 } }, 'corr')).toBe(false);
    expect('constraint' in toProblemDetails({ kind: 'RuleViolation', code: 'X', message: 'm', detail: 'text' }, 'corr')).toBe(false);
  });

  it('falls back to a generic title and a 500 for a kind it does not know', () => {
    const body = toProblemDetails({ kind: 'Bizarre' as never, code: 'X', message: 'm' }, 'corr');
    expect([body.status, body.title]).toEqual([500, 'Unexpected error']);
  });

  it('builds a validation problem', () => {
    expect(validationProblem('bad', 'corr')).toMatchObject({ status: 400, code: 'Validation', detail: 'bad' });
  });
});

describe('the attempt routes\' validators', () => {
  const attempt = '00000000-0000-4000-8000-000000000001';
  const event = { eventId: 'e1', slot: 's1', sequence: 1, monotonicMs: 10, kind: 'select', answer: 'a' };

  it('maps a device\'s events into drafts, defaulting the attempt and the answer', () => {
    const parsed = ingestEventsSchema.parse({ attemptId: attempt, deviceRef: 'd', events: [event, { eventId: 'e2', attemptId: 'other', slot: 's1', sequence: 2, monotonicMs: 20, kind: 'visit' }] });
    expect(parsed.events).toEqual([
      { eventId: 'e1', attemptId: attempt, slotId: 's1', sequence: 1, kind: 'select', answer: 'a', clientMonotonicMs: 10, deviceRef: 'd' },
      { eventId: 'e2', attemptId: 'other', slotId: 's1', sequence: 2, kind: 'visit', answer: null, clientMonotonicMs: 20, deviceRef: 'd' },
    ]);
  });

  it('checks the envelope and leaves each event to the domain: an event with nonsense in it still passes through', () => {
    expect(ingestEventsSchema.safeParse({ attemptId: attempt, deviceRef: 'd', events: [{ kind: 'ponder' }] }).success).toBe(true);
    for (const bad of [{ events: [] }, { deviceRef: '' }, { events: [event], extra: 1 }, { events: Array.from({ length: 201 }, () => event) }]) {
      expect(ingestEventsSchema.safeParse({ attemptId: attempt, deviceRef: 'd', events: [event], ...bad }).success).toBe(false);
    }
  });

  it('ignores what a client sends that it cannot set, rather than refusing it', () => {
    const parsed = createAttemptSchema.parse({ formId: attempt, sessionRef: 's', idempotencyKey: 'k', deadline: 'x', durationMs: 1, state: 'in_progress' });
    expect(Object.keys(parsed).sort()).toEqual(['formId', 'idempotencyKey', 'sessionRef']);
    expect(createAttemptSchema.safeParse({ formId: attempt, sessionRef: 's' }).success).toBe(false);
  });

  it('requires a reason from the three, and a key', () => {
    expect(submitAttemptSchema.safeParse({ attemptId: attempt, reason: 'manual', idempotencyKey: 'k' }).success).toBe(true);
    for (const bad of [{ reason: 'whenever' }, { idempotencyKey: '' }, { surprise: 1 }]) {
      expect(submitAttemptSchema.safeParse({ attemptId: attempt, reason: 'manual', idempotencyKey: 'k', ...bad }).success).toBe(false);
    }
    expect(attemptIdSchema.safeParse({ attemptId: 'nope' }).success).toBe(false);
  });
});
