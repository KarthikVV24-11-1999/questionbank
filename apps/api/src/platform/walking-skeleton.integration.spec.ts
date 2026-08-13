import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { withMigratedDatabase, type TestDatabase } from '../testing/database.js';
import { expectValue } from '../testing/expect-result.js';
import { AUTHOR, itemVersionProps, PROVENANCE_CONTEXT } from '../testing/content-fixtures.js';
import { createItem, publishVersion, transitionItem } from '../contexts/content/domain/item.js';
import { createItemVersion } from '../contexts/content/domain/item-version.js';
import { PostgresItemRepository } from '../contexts/content/infrastructure/item.repository.js';
import { register as registerContent } from '../contexts/content/public/composition.js';
import { issue } from './auth/token.js';
import { createRecordingTelemetry, type RecordingTelemetry } from './observability/recording-telemetry.js';
import { createApplication } from './composition/app-factory.js';

/**
 * The milestone's name, as one test (M0-14). A bearer token issued by the
 * M0-05 stub carries all the way through the real composed application —
 * resolver, controller, handler with its declared policy, repository, real
 * Postgres — to a delivery response, with a full span tree and the existing
 * no-answer-key guarantee proven over live output.
 *
 * **What this file does not prove**: that any of this runs anywhere but this
 * machine (DEC-M0-1) — no Compose boot, no CI run, no deployed process. It
 * also does not prove anything about a PII-scrubbed *log line*, because
 * nothing in the composed application writes one on this request path today
 * — `createPrincipalResolver` is wired here with no `logger`, so a refusal
 * is silent rather than logged, and there is nothing for a PII scan to
 * examine. The span tree (`RecordingTelemetry`) is the one observability
 * surface this test can and does assert against.
 */

const SIGNING_KEY = 'a'.repeat(32);
const ISSUER = 'questionbank';
const ITEM_ID = '00000000-0000-4000-8000-00000000e2e0';

let database: TestDatabase;
let app: INestApplication;
let telemetry: RecordingTelemetry;

function tokenFor(roles: readonly string[], overrides: { readonly exp?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return issue(
    {
      sub: 'learner-1',
      kind: 'human',
      roles: [...roles],
      iat: now,
      exp: overrides.exp ?? now + 3600,
      iss: ISSUER,
      jti: 'jti-walking-skeleton',
    },
    { signingKey: SIGNING_KEY, issuer: ISSUER },
  );
}

async function seedPublishedItem(): Promise<void> {
  const repository = new PostgresItemRepository(database.pool);
  // The database columns are `uuid` (P6); the shared fixtures use readable
  // ids like `author-1`, which is right for a unit spec and impossible here.
  const initial = expectValue(
    createItemVersion(
      itemVersionProps({
        versionId: '00000000-0000-4000-8000-00000000e2e1',
        authoredBy: { ...AUTHOR, id: '00000000-0000-4000-8000-00000000a000' },
        taxonomyTags: [
          {
            conceptIdentityId: '00000000-0000-4000-8000-00000000c000',
            taxonomyVersionId: '00000000-0000-4000-8000-00000000d000',
            weight: 1,
            isPrimary: true,
          },
        ],
      }),
      PROVENANCE_CONTEXT,
    ),
  );
  const draft = expectValue(createItem({ itemId: ITEM_ID, itemType: initial.itemType, initialVersion: initial }));
  expectValue(await repository.save(draft));

  const approved = expectValue(
    transitionItem(expectValue(transitionItem(draft, { transition: 'submit_for_review' })), { transition: 'approve' }),
  );
  const published = expectValue(
    publishVersion(approved, { versionId: initial.versionId, preconditionsSatisfied: true }),
  );
  expectValue(await repository.save(published));
}

beforeAll(async () => {
  database = await withMigratedDatabase();
  await seedPublishedItem();

  telemetry = createRecordingTelemetry();
  app = await createApplication(
    {
      databaseUrl: 'unused-because-pool-is-overridden',
      port: 3000,
      nodeEnv: 'test',
      authSigningKey: SIGNING_KEY,
      authIssuer: ISSUER,
      authTokenTtlSeconds: 3600,
      mediaStorageRoot: './var/media-test',
      logLevel: 'info',
    },
    { pool: database.pool, telemetry },
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

beforeEach(() => {
  telemetry.reset();
});

describe('the walking skeleton — one authenticated request, end to end', () => {
  it('reaches a real, published item through the composed application, with a full span tree', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/items/${ITEM_ID}`)
      .set('Authorization', `Bearer ${tokenFor(['learner'])}`);

    expect(response.status).toBe(200);
    expect(response.body.itemId).toBe(ITEM_ID);

    const correlationId = response.headers['x-correlation-id'] as string | undefined;
    expect(typeof correlationId).toBe('string');
    expect(correlationId?.length).toBeGreaterThan(0);

    // Every span in the tree carries the same id the response carried.
    const spans = telemetry.spans;
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((span) => span.traceId === correlationId)).toBe(true);

    const root = spans.find((span) => span.parentSpanId === undefined);
    expect(root?.name).toBe('GET /v1/items/:itemId');

    const handlerChild = spans.find((span) => span.parentSpanId === root?.spanId);
    expect(handlerChild?.name).toBe('getPublishedItem');

    const dbGrandchild = spans.find((span) => span.parentSpanId === handlerChild?.spanId && span.name === 'db.query');
    expect(dbGrandchild).toBeDefined();
  });

  it('carries no answer-key field — the delivery route, live output, not the document', async () => {
    const KEY_FIELDS = [
      'correctOptionId',
      'correctOptionIds',
      'isCorrect',
      'answerKey',
      'expectedValue',
      'toleranceValue',
      'responseSpec',
    ] as const;

    const response = await request(app.getHttpServer())
      .get(`/v1/items/${ITEM_ID}`)
      .set('Authorization', `Bearer ${tokenFor(['learner'])}`);

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    for (const field of KEY_FIELDS) {
      expect(serialized, field).not.toContain(`"${field}"`);
    }
  });

  it('an unauthenticated request is refused — 401, and nothing about the attempted path leaks into a span', async () => {
    const response = await request(app.getHttpServer()).get(`/v1/items/${ITEM_ID}`);

    expect(response.status).toBe(401);
    for (const span of telemetry.spans) {
      expect(JSON.stringify(span.attributes)).not.toContain(ITEM_ID);
    }
  });

  it('an expired token is refused — 401, not treated as live', async () => {
    const now = Math.floor(Date.now() / 1000);
    const response = await request(app.getHttpServer())
      .get(`/v1/items/${ITEM_ID}`)
      .set('Authorization', `Bearer ${tokenFor(['learner'], { exp: now - 1 })}`);

    expect(response.status).toBe(401);
  });

  it('the 401 assertion is not vacuous — proven able to fail against a planted resolver bypass', async () => {
    // A resolver that authenticates everyone, regardless of the request, is
    // what "the resolver was silently removed from composition" looks like
    // at runtime. If the two tests above ever ran against an application
    // wired this way, they would not catch it on their own — this is what
    // proves they still could.
    const bypassed = await createApplication(
      {
        databaseUrl: 'unused-because-pool-is-overridden',
        port: 3000,
        nodeEnv: 'test',
        authSigningKey: SIGNING_KEY,
        authIssuer: ISSUER,
        authTokenTtlSeconds: 3600,
        mediaStorageRoot: './var/media-test',
        logLevel: 'info',
      },
      {
        pool: database.pool,
        contentRegister: (deps) =>
          registerContent({
            ...deps,
            principals: { resolve: () => ({ kind: 'human', id: 'anyone', roleContext: ['learner'] }) },
          }),
      },
    );
    await bypassed.init();

    const response = await request(bypassed.getHttpServer()).get(`/v1/items/${ITEM_ID}`);
    expect(response.status).toBe(200);

    await bypassed.close();
  });
});
