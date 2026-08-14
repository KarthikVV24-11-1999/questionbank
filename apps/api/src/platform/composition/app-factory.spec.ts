import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { MissingAuthorizationPolicyError } from '../../contexts/content/application/handler-registry.js';
import { ContentModule } from '../../contexts/content/api/content.module.js';
import { policy } from '../../contexts/content/application/authorization.js';
import { checkBoundaries } from '../../fitness/boundary-rules.js';
import { createApplication, type CreateApplicationOverrides } from './app-factory.js';
import type { AppConfig } from '../config/config.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Unit-speed: every assertion here runs against `createApplication` without
 * a listening socket, and without a real database connection — `pg.Pool`
 * never dials out at construction, only on the first query, and nothing here
 * issues one.
 */
const CONFIG: AppConfig = {
  databaseUrl: 'postgres://postgres@127.0.0.1:5433/questionbank_test',
  port: 3000,
  nodeEnv: 'test',
  authSigningKey: 'a'.repeat(32),
  authIssuer: 'questionbank',
  authTokenTtlSeconds: 3600,
  mediaStorageRoot: './var/media-test',
  logLevel: 'info',
};

/** A `Pool` that is never queried in this file — only ever passed around and instrumented. */
function fakePool(): Pool {
  return { query: async () => ({ rows: [] }) } as unknown as Pool;
}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('createApplication — unit speed', () => {
  it('builds the application from real registers and fake platform adapters, no socket required', async () => {
    app = await createApplication(CONFIG, { pool: fakePool() });
    expect(app).toBeDefined();
    expect(typeof app.listen).toBe('function');
  });

  it('passes no overrides on the production path', async () => {
    // The production path is `main.ts` calling `createApplication(config)`
    // with no second argument. This proves that call succeeds on its own —
    // every default resolves without a caller supplying anything.
    app = await createApplication(CONFIG);
    expect(app).toBeDefined();
  });

  it('closes the pool it built itself when app.close() is called — the production path only', async () => {
    const built = await createApplication(CONFIG);
    await expect(built.close()).resolves.toBeUndefined();
    app = undefined;
  });

  it('rejects a planted policy-less handler across the composed set, naming the handler', async () => {
    const policyLessHandler = {
      name: 'PlantedPolicyLessHandler',
      policy: policy('PlantedPolicyLessHandler', []),
      async handle() {
        return { ok: true as const, value: undefined };
      },
    };

    const overrides: CreateApplicationOverrides = {
      pool: fakePool(),
      contentRegister: () =>
        ContentModule.register({
          handlers: [policyLessHandler] as never,
          principals: { resolve: () => null },
        }),
    };

    await expect(createApplication(CONFIG, overrides)).rejects.toThrow(MissingAuthorizationPolicyError);
    await expect(createApplication(CONFIG, overrides)).rejects.toThrow(/PlantedPolicyLessHandler/u);
  });

  it('refuses to boot in production with the filesystem media store — closes the M0-10 integration criterion', async () => {
    await expect(
      createApplication({ ...CONFIG, nodeEnv: 'production' }, { pool: fakePool() }),
    ).rejects.toThrow(/production/iu);
  });
});

describe('F1 extended to platform/ (DEC-M0-5 condition 2, M0-12)', () => {
  it('finds no violation in the real platform/ tree', () => {
    const violations = checkBoundaries(API_ROOT, { include: ['src/platform'] }).filter(
      (violation) => violation.rule === 'F1_CONTEXT_BOUNDARY',
    );
    expect(violations).toEqual([]);
  });

  it('the scan is not vacuous — platform/ actually has files in it', () => {
    // Guards against the check above passing only because it scanned nothing
    // (DEC-M0-1's standing instruction against a vacuous green).
    expect(readdirSync(resolve(API_ROOT, 'src/platform')).length).toBeGreaterThan(0);
  });

  it('fires on a planted deep import of contexts/content/infrastructure/item.repository.js', () => {
    const violations = checkBoundaries(API_ROOT, {
      include: ['src/fitness-fixtures/as-platform-composition'],
      excludePatterns: [],
    }).filter((violation) => violation.rule === 'F1_CONTEXT_BOUNDARY');

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain('planted-platform-boundary-violation.ts');
    expect(violations[0]?.message).toContain('public/ barrel');
  });
});
