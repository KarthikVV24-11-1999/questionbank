import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createLiveItemBrowserApi } from '@questionbank/studio/src/features/item-browser/item-browser-api.js';
import { withMigratedDatabase, type TestDatabase } from '../../testing/database.js';
import { issue } from '../../platform/auth/token.js';
import { createApplication } from '../../platform/composition/app-factory.js';

/**
 * M0-19's own criterion: "the browser's query executes against the composed
 * application and returns a draft the seed created." Studio's live
 * `ItemBrowserApi` (`item-browser-api.ts`) is plain TypeScript with no React
 * import at all — it is imported directly here rather than proxied through a
 * subprocess, which is the one dependency in this repository that runs from
 * `apps/api` toward `apps/studio` (a `devDependency`, test-only). The
 * alternative — reaching the other way, `apps/studio` importing
 * `createApplication` to boot the API in-process — was tried first and
 * rejected: `apps/api`'s NestJS decorators need `experimentalDecorators` /
 * `emitDecoratorMetadata`, which `apps/studio`'s tsconfig does not (and
 * should not) carry, and a single `tsc` program cannot type-check the same
 * file two different ways. This direction has no such conflict, because
 * `item-browser-api.ts` needs nothing from React or JSX.
 */

const SIGNING_KEY = 'a'.repeat(32);
const ISSUER = 'questionbank';
const AUTHOR_ID = '00000000-0000-4000-8000-0000000a1234';
const PORT = 34_789;

let database: TestDatabase;
let app: INestApplication;

function tokenFor(roles: readonly string[], sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return issue(
    { sub, kind: 'human', roles: [...roles], iat: now, exp: now + 3600, iss: ISSUER, jti: 'jti-item-browser-live' },
    { signingKey: SIGNING_KEY, issuer: ISSUER },
  );
}

beforeAll(async () => {
  database = await withMigratedDatabase();
  app = await createApplication(
    {
      databaseUrl: 'unused-because-pool-is-overridden',
      port: PORT,
      nodeEnv: 'test',
      authSigningKey: SIGNING_KEY,
      auditAnchorKey: `anchor-${SIGNING_KEY}`,
      reviewWarnAfterHours: 48,
      reviewEscalateAfterHours: 72,
      reviewLeaseHours: 4,
      reviewSampleRate: 0.05,
      authIssuer: ISSUER,
      authTokenTtlSeconds: 3600,
      mediaStorageRoot: './var/media-test',
      logLevel: 'info',
    },
    { pool: database.pool },
  );
  await app.listen(PORT);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('the Item Browser, wired to the real composed API (M0-19)', () => {
  it("lists a draft the seed created — Studio's own live client, against real Postgres", async () => {
    // A real, independent finding while wiring this test: CreateItemDraftHandler
    // (application/handlers/authoring-handlers.ts) returns the raw domain `Item`
    // aggregate, not `toAuthoringItemView(item)` — so its wire response carries
    // `authoredBy` (a full PrincipalRef) instead of the documented
    // `AuthoringItemVersion.authoredById` (a string), plus an undocumented
    // `aggregateVersion` field the `.strict()` schema rejects. `GetItemDraftHandler`
    // and `ListMyDraftsHandler` both go through the view and are unaffected — this
    // is scoped to the command handlers that echo what they just wrote. Confirmed
    // by hand against a raw request; out of scope to fix here (it touches every
    // authoring command handler, not just this one), so setup below uses a plain
    // `fetch` rather than the strict typed client, and the divergence is recorded
    // as new debt: **D34**, trigger: the next authoring command handler this
    // divergence is found to affect, or a client that actually needs the create
    // response's shape (this one only needs the created `itemId`).
    const setupResponse = await fetch(`http://127.0.0.1:${PORT}/v1/authoring/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(['author', 'subject:physics'], AUTHOR_ID)}` },
      body: JSON.stringify({
        itemType: 'SINGLE_CORRECT_MCQ',
        content: {
          stem: {
            schemaVersion: 1,
            blocks: [{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'A live-wired stem.', marks: [] }] }],
          },
          responseSpec: {
            itemType: 'SINGLE_CORRECT_MCQ',
            options: [
              { optionId: 'a', ordinal: 1, body: { schemaVersion: 1, blocks: [] } },
              { optionId: 'b', ordinal: 2, body: { schemaVersion: 1, blocks: [] } },
            ],
            correctOptionId: 'a',
          },
          taxonomyTags: [
            {
              conceptIdentityId: '00000000-0000-4000-8000-0000000c0001',
              taxonomyVersionId: '00000000-0000-4000-8000-0000000d0001',
              weight: 1,
              isPrimary: true,
            },
          ],
          difficultyEstimate: 'moderate',
          provenance: { sourceType: 'original', authorRef: AUTHOR_ID },
        },
      }),
    });
    const created = (await setupResponse.json()) as { itemId: string };
    expect(setupResponse.status).toBe(201);

    const browserApi = createLiveItemBrowserApi({
      baseUrl: `http://127.0.0.1:${PORT}`,
      getToken: () => tokenFor(['author', 'subject:physics'], AUTHOR_ID),
      myPrincipalId: AUTHOR_ID,
    });

    const rows = await browserApi.list({
      lifecycleStates: [],
      subject: null,
      conceptIdentityId: null,
      authorPrincipalId: AUTHOR_ID,
    });

    expect(rows.map((row) => row.itemId)).toContain(created.itemId);
    const row = rows.find((candidate) => candidate.itemId === created.itemId);
    expect(row?.lifecycleState).toBe('draft');
    expect(row?.label).toBe('A live-wired stem.');
  });
});
