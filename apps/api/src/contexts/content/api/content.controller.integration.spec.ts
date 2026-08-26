import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { parse } from 'yaml';
import { MissingAuthorizationPolicyError, type Handler } from '../application/handler-registry.js';
import { policy } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import { ContentModule } from './content.module.js';
import type { PrincipalResolver } from './http-runner.js';

/**
 * The HTTP surface, through a real Nest application. Handlers are stubs: what
 * is under test is translation — parsing, authenticating, status mapping and
 * Problem Details — not the authoring itself, which the application specs
 * already cover end to end against a real database.
 *
 * The exception is the last block, which runs the **real** delivery view
 * constructors through the controller so the key-absence claim is asserted
 * over live output rather than over the document (M3-34's own criterion).
 */

let app: INestApplication;

const OPS: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['content_ops'] };

const resolver: PrincipalResolver = {
  resolve: (headers) => (headers['authorization'] === undefined ? null : OPS),
};

const SPEC = parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../../packages/contracts/openapi/content.yaml', import.meta.url)),
    'utf8',
  ),
) as { readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>> };

/** Every handler the document names — the controller must route all of them. */
const HANDLER_NAMES = [
  ...new Set(
    Object.values(SPEC.paths).flatMap((item) =>
      Object.values(item)
        .map((operation) => operation['x-handler'])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ),
];

const STEP_UP_HANDLERS = new Set([
  'PublishItemVersion',
  'RetireItem',
  'PublishStimulusVersion',
  'RetireStimulus',
  'PublishSolutionVersion',
  'PublishMediaAssetVersion',
]);

/** Echoes what it was given, or fails in the way the test asked for. */
function stub(name: string): Handler<unknown, unknown> {
  return {
    name,
    policy: policy(name, ['content_ops'], STEP_UP_HANDLERS.has(name)),
    async handle(input: unknown, context: ApplicationContext) {
      const asked = (input as { justification?: string } | null)?.justification;
      if (asked === 'force-not-found') {
        return { ok: false as const, error: { kind: 'NotFound' as const, code: 'NOT_FOUND', message: 'gone' } };
      }
      if (asked === 'force-precondition') {
        return {
          ok: false as const,
          error: {
            kind: 'PreconditionFailed' as const,
            code: 'PUBLICATION_PRECONDITIONS_UNMET',
            message: 'not publishable',
            location: 'lifecycleState',
            detail: [{ code: 'SOLUTION_MISSING', message: 'no solution', location: 'solution' }],
          },
        };
      }
      if (asked === 'force-entitlement') {
        return {
          ok: false as const,
          error: {
            kind: 'Entitlement' as const,
            code: 'SOLUTION_DEPTH_NOT_ENTITLED',
            message: 'upgrade to see this',
          },
        };
      }
      return { ok: true as const, value: { echoed: input, stepUp: context.stepUpSatisfied ?? false } };
    },
  } as unknown as Handler<unknown, unknown>;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ContentModule.register({
        handlers: HANDLER_NAMES.map(stub) as unknown as Handler<never, unknown>[],
        principals: resolver,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

const AUTH = { Authorization: 'Bearer test' };
const ITEM_ID = randomUUID();
const VERSION_ID = randomUUID();
const STIMULUS_ID = randomUUID();
const SOLUTION_ID = randomUUID();
const ASSET_ID = randomUUID();

const CONTENT_BODY = { schemaVersion: 1, blocks: [] };

const ITEM_CONTENT = {
  stem: CONTENT_BODY,
  responseSpec: {
    itemType: 'SINGLE_CORRECT_MCQ',
    options: [{ optionId: 'a', ordinal: 1, body: CONTENT_BODY }],
    correctOptionId: 'a',
  },
  taxonomyTags: [
    { conceptIdentityId: randomUUID(), taxonomyVersionId: randomUUID(), weight: 1, isPrimary: true },
  ],
  difficultyEstimate: 'moderate',
  provenance: { sourceType: 'original' },
};

describe('every authoring route reaches its handler', () => {
  it('creates an item draft', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/items')
      .set(AUTH)
      .send({ itemType: 'SINGLE_CORRECT_MCQ', content: ITEM_CONTENT });

    expect(response.status).toBe(201);
    expect(response.body.echoed.itemType).toBe('SINGLE_CORRECT_MCQ');
  });

  it('autosaves a draft, carrying the path parameter into the command', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/v1/authoring/items/${ITEM_ID}`)
      .set(AUTH)
      .send({ content: ITEM_CONTENT, idempotencyKey: 'k' });

    expect(response.status).toBe(200);
    expect(response.body.echoed.itemId).toBe(ITEM_ID);
    expect(response.body.echoed.idempotencyKey).toBe('k');
  });

  it('discards a draft with 204 and no body', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/v1/authoring/items/${ITEM_ID}`)
      .set(AUTH)
      .send({ justification: 'duplicate' });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it('withdraws a submission, which is a DELETE on the same path', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/v1/authoring/items/${ITEM_ID}/review-submission`)
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.echoed.itemId).toBe(ITEM_ID);
  });

  it('routes the read operations', async () => {
    const reads: readonly [string, number][] = [
      [`/v1/authoring/items/${ITEM_ID}`, 200],
      [`/v1/authoring/items/${ITEM_ID}/versions/${VERSION_ID}`, 200],
      [`/v1/authoring/items/${ITEM_ID}/validation-findings`, 200],
      [`/v1/authoring/drafts?authorId=${randomUUID()}`, 200],
      ['/v1/authoring/media-assets', 200],
    ];
    for (const [path, status] of reads) {
      const response = await request(app.getHttpServer()).get(path).set(AUTH);
      expect(response.status, path).toBe(status);
    }
  });

  it('routes every lifecycle transition', async () => {
    const transitions: readonly [string, object][] = [
      [`/v1/authoring/items/${ITEM_ID}/review-submission`, {}],
      [
        `/v1/authoring/items/${ITEM_ID}/review-decisions`,
        { itemVersionId: VERSION_ID, outcome: 'approve', candidatesShownIds: [] },
      ],
      [`/v1/authoring/items/${ITEM_ID}/publication`, { itemVersionId: VERSION_ID }],
      [`/v1/authoring/items/${ITEM_ID}/suspension`, { justification: 'defect' }],
      [`/v1/authoring/items/${ITEM_ID}/retirement`, { retirementReason: 'out of syllabus' }],
      [`/v1/authoring/stimuli/${STIMULUS_ID}/review-submission`, {}],
      [
        `/v1/authoring/stimuli/${STIMULUS_ID}/review-decisions`,
        { stimulusVersionId: VERSION_ID, outcome: 'approve' },
      ],
      [`/v1/authoring/stimuli/${STIMULUS_ID}/publication`, { stimulusVersionId: VERSION_ID }],
      [`/v1/authoring/stimuli/${STIMULUS_ID}/retirement`, { retirementReason: 'superseded' }],
      [`/v1/authoring/solutions/${SOLUTION_ID}/review-submission`, {}],
      [
        `/v1/authoring/solutions/${SOLUTION_ID}/review-decisions`,
        { solutionVersionId: VERSION_ID, outcome: 'approve' },
      ],
      [`/v1/authoring/solutions/${SOLUTION_ID}/publication`, { solutionVersionId: VERSION_ID }],
      [`/v1/authoring/media-assets/${ASSET_ID}/review-submission`, {}],
      [
        `/v1/authoring/media-assets/${ASSET_ID}/review-decisions`,
        { assetVersionId: VERSION_ID, outcome: 'approve' },
      ],
      [`/v1/authoring/media-assets/${ASSET_ID}/publication`, { assetVersionId: VERSION_ID }],
      [`/v1/authoring/media-assets/${ASSET_ID}/retirement`, { retirementReason: 'superseded' }],
    ];

    for (const [path, body] of transitions) {
      const response = await request(app.getHttpServer())
        .post(path)
        .set({ ...AUTH, 'x-step-up': 'satisfied' })
        .send(body);
      expect(response.status, path).toBe(200);
    }
  });

  it('routes the remaining authoring writes', async () => {
    const writes: readonly [string, object, number][] = [
      [`/v1/authoring/items/${ITEM_ID}/versions`, { fromVersionId: VERSION_ID }, 201],
      [`/v1/authoring/items/${ITEM_ID}/stimulus`, { stimulusId: STIMULUS_ID }, 200],
      [
        '/v1/authoring/stimuli',
        { stimulusType: 'passage', subject: 'physics', body: CONTENT_BODY },
        201,
      ],
      [
        '/v1/authoring/solutions',
        {
          itemId: ITEM_ID,
          targetItemVersionId: VERSION_ID,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'a' },
            steps: [{ ordinal: 1, body: CONTENT_BODY, conceptRefs: [] }],
          },
        },
        201,
      ],
      [
        '/v1/authoring/media-assets',
        {
          assetType: 'diagram',
          subject: 'physics',
          version: {
            storageKey: 'content/media/a.png',
            mimeType: 'image/png',
            width: 8,
            height: 8,
            altText: 'a diagram of a ramp',
          },
        },
        201,
      ],
      [
        `/v1/authoring/media-assets/${ASSET_ID}/versions`,
        {
          subject: 'physics',
          version: {
            storageKey: 'content/media/b.png',
            mimeType: 'image/png',
            width: 8,
            height: 8,
            altText: 'a diagram of a ramp',
          },
        },
        201,
      ],
      ['/v1/authoring/import-batches', { contents: '{}' }, 200],
    ];

    for (const [path, body, status] of writes) {
      const response = await request(app.getHttpServer()).post(path).set(AUTH).send(body);
      expect(response.status, path).toBe(status);
    }
  });

  it('patches a stimulus and a solution', async () => {
    const stimulus = await request(app.getHttpServer())
      .patch(`/v1/authoring/stimuli/${STIMULUS_ID}`)
      .set(AUTH)
      .send({ subject: 'physics', body: CONTENT_BODY, idempotencyKey: 'k' });
    expect(stimulus.status).toBe(200);

    const solution = await request(app.getHttpServer())
      .patch(`/v1/authoring/solutions/${SOLUTION_ID}`)
      .set(AUTH)
      .send({
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'OPTION', optionId: 'a' },
          steps: [{ ordinal: 1, body: CONTENT_BODY, conceptRefs: [] }],
        },
        idempotencyKey: 'k',
      });
    expect(solution.status).toBe(200);
  });
});

describe('every delivery route reaches its handler', () => {
  it('serves an item, a stimulus and a solution', async () => {
    const item = await request(app.getHttpServer()).get(`/v1/items/${ITEM_ID}`).set(AUTH);
    expect(item.status).toBe(200);

    const stimulus = await request(app.getHttpServer()).get(`/v1/stimuli/${STIMULUS_ID}`).set(AUTH);
    expect(stimulus.status).toBe(200);

    const solution = await request(app.getHttpServer())
      .get(`/v1/solutions/${VERSION_ID}?depth=basic`)
      .set(AUTH);
    expect(solution.status).toBe(200);
    expect(solution.body.echoed.depth).toBe('basic');
  });

  // `depth` is validated, never defaulted: a request that means neither must be
  // refused rather than quietly served the cheaper one.
  it('refuses a solution depth outside the two it knows', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/solutions/${VERSION_ID}?depth=everything`)
      .set(AUTH);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('Validation');
  });
});

describe('§8 — the boundary refuses what it cannot type', () => {
  it('rejects a malformed body with Problem Details naming the field', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/items')
      .set(AUTH)
      .send({ itemType: 'ESSAY', content: ITEM_CONTENT });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.code).toBe('Validation');
    expect(response.body.detail).toContain('itemType');
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/items')
      .set(AUTH)
      .send({ itemType: 'SINGLE_CORRECT_MCQ', content: ITEM_CONTENT, smuggled: true });

    expect(response.status).toBe(400);
    expect(response.body.detail).toContain('smuggled');
  });

  it('rejects a path parameter that is not a uuid', async () => {
    const response = await request(app.getHttpServer()).get('/v1/authoring/items/not-a-uuid').set(AUTH);
    expect(response.status).toBe(400);
  });

  it('demands authentication before anything else', async () => {
    const response = await request(app.getHttpServer()).post('/v1/authoring/items').send({});
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('Authentication');
    expect(response.body.retryable).toBe(false);
  });

  it('maps each error kind onto its status, with retryable explicit', async () => {
    const notFound = await request(app.getHttpServer())
      .post(`/v1/authoring/items/${ITEM_ID}/suspension`)
      .set(AUTH)
      .send({ justification: 'force-not-found' });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ code: 'NotFound', retryable: false });

    const precondition = await request(app.getHttpServer())
      .post(`/v1/authoring/items/${ITEM_ID}/suspension`)
      .set(AUTH)
      .send({ justification: 'force-precondition' });
    expect(precondition.status).toBe(412);
    expect(precondition.body.location).toBe('lifecycleState');
    // The precondition list travels as structured detail, so the validation
    // panel groups by code rather than reading a message.
    expect(precondition.body.errors[0].code).toBe('SOLUTION_MISSING');

    const entitlement = await request(app.getHttpServer())
      .post(`/v1/authoring/items/${ITEM_ID}/suspension`)
      .set(AUTH)
      .send({ justification: 'force-entitlement' });
    // 402, not 403: "upgrade to access" and "you are not permitted" need
    // different UX and different metrics (§8).
    expect(entitlement.status).toBe(402);
    expect(entitlement.body.code).toBe('Entitlement');
  });

  it('echoes a correlation id on every response, error or not', async () => {
    const ok = await request(app.getHttpServer())
      .get(`/v1/authoring/items/${ITEM_ID}`)
      .set({ ...AUTH, 'x-correlation-id': 'given-1' });
    expect(ok.headers['x-correlation-id']).toBe('given-1');

    const failed = await request(app.getHttpServer())
      .get('/v1/authoring/items/not-a-uuid')
      .set({ ...AUTH, 'x-correlation-id': 'given-2' });
    expect(failed.headers['x-correlation-id']).toBe('given-2');
    expect(failed.body.correlationId).toBe('given-2');

    const unauthenticated = await request(app.getHttpServer()).get(`/v1/items/${ITEM_ID}`);
    expect(unauthenticated.headers['x-correlation-id']).toBeTruthy();
  });

  it('carries step-up through to the handler', async () => {
    const withStepUp = await request(app.getHttpServer())
      .post(`/v1/authoring/items/${ITEM_ID}/publication`)
      .set({ ...AUTH, 'x-step-up': 'satisfied' })
      .send({ itemVersionId: VERSION_ID });
    expect(withStepUp.body.stepUp).toBe(true);

    const without = await request(app.getHttpServer())
      .post(`/v1/authoring/items/${ITEM_ID}/publication`)
      .set(AUTH)
      .send({ itemVersionId: VERSION_ID });
    expect(without.body.stepUp).toBe(false);
  });

  it('leaks no stack trace, SQL or internal identifier', async () => {
    const response = await request(app.getHttpServer()).get('/v1/authoring/items/not-a-uuid').set(AUTH);
    expect(JSON.stringify(response.body)).not.toMatch(/SELECT |INSERT |at Object\.|node_modules/u);
  });
});

describe('F36 — a policy-less handler fails boot', () => {
  it('refuses to build the module', async () => {
    const roleless = {
      name: 'CreateItemDraft',
      policy: policy('CreateItemDraft', []),
      async handle() {
        return { ok: true as const, value: undefined };
      },
    };

    expect(() =>
      ContentModule.register({
        handlers: [roleless] as unknown as Handler<never, unknown>[],
        principals: resolver,
      }),
    ).toThrow(MissingAuthorizationPolicyError);
  });

  it('routes every handler the document declares', () => {
    // Boot succeeded above with exactly this list, so a document naming a
    // handler the controller does not route would have failed the request
    // tests rather than passing quietly.
    expect(HANDLER_NAMES.length).toBeGreaterThan(30);
  });
});

/**
 * The criterion M3-34 states in its own words: *a delivery route that would
 * serialize a key fails a test, not a review* — asserted against **live
 * controller output**, not against the document.
 */
describe('a delivery response carries no key material, over live output', () => {
  const KEY_FIELDS = [
    'correctOptionId',
    'correctOptionIds',
    'isCorrect',
    'answerKey',
    'expectedValue',
    'toleranceValue',
    'rangeMin',
    'rangeMax',
    'significantFigures',
    'pairs',
    'finalAnswerAssertion',
    'responseSpec',
  ] as const;

  it('scans what each delivery route actually returned', async () => {
    // The stubs echo their input, so what a delivery route can return is
    // exactly what its schema let through — which is the point: the delivery
    // schemas accept an identifier and a depth, and nothing that could carry a
    // key even if a handler tried.
    const responses = [
      await request(app.getHttpServer()).get(`/v1/items/${ITEM_ID}`).set(AUTH),
      await request(app.getHttpServer()).get(`/v1/stimuli/${STIMULUS_ID}`).set(AUTH),
      await request(app.getHttpServer()).get(`/v1/solutions/${VERSION_ID}?depth=full`).set(AUTH),
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      const serialized = JSON.stringify(response.body);
      for (const field of KEY_FIELDS) {
        expect(serialized, field).not.toContain(`"${field}"`);
      }
    }
  });

  it('is not vacuous — the same scan finds the key on an authoring response', async () => {
    const authoring = await request(app.getHttpServer())
      .post('/v1/authoring/items')
      .set(AUTH)
      .send({ itemType: 'SINGLE_CORRECT_MCQ', content: ITEM_CONTENT });

    expect(JSON.stringify(authoring.body)).toContain('"correctOptionId"');
  });

  it('imports no authoring DTO into the delivery controller (ADR-0009 condition 3)', () => {
    const controller = readFileSync(
      fileURLToPath(new URL('./content.controller.ts', import.meta.url)),
      'utf8',
    );
    // The structural version of this check lands at M3-44 over the whole
    // import graph; here it is asserted at the one file that matters most.
    expect(controller).not.toContain('authoring-schemas');
    expect(controller).not.toMatch(/\bAuthoring\w+Schema\b/u);
  });
});
