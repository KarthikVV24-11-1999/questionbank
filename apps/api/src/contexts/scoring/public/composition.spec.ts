import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { readCode } from '../../../fitness/source-scan.js';
import { SCORING_REGISTRY } from '../api/scoring.controller.js';
import type { HandlerRegistry } from '../application/handler-registry.js';
import { PostgresEventPublisher, register, type ScoringCompositionDeps } from './composition.js';

const CONTEXT_DIR = fileURLToPath(new URL('../', import.meta.url));

const fakePool = {} as Pool;

function validDeps(overrides: Partial<ScoringCompositionDeps> = {}): ScoringCompositionDeps {
  return {
    pool: fakePool,
    clock: { now: () => new Date('2026-08-13T00:00:00.000Z') },
    identifiers: { next: () => 'id-1' },
    audit: { record: async () => undefined },
    principals: { resolve: () => null },
    ...overrides,
  };
}

const SPEC = parse(
  readFileSync(resolve(CONTEXT_DIR, '../../../../../packages/contracts/openapi/scoring.yaml'), 'utf8'),
) as { readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>> };

const DOCUMENT_HANDLER_NAMES = [
  ...new Set(
    Object.values(SPEC.paths).flatMap((item) =>
      Object.values(item)
        .map((operation) => operation['x-handler'])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ),
];

describe('scoring composition — register resolves every handler', () => {
  it('builds a module whose registry resolves every handler the OpenAPI document names', async () => {
    expect(DOCUMENT_HANDLER_NAMES.length).toBeGreaterThan(5);

    const moduleRef = await Test.createTestingModule({ imports: [register(validDeps())] }).compile();
    const registry = moduleRef.get<HandlerRegistry>(SCORING_REGISTRY);

    const missing = DOCUMENT_HANDLER_NAMES.filter((name) => registry.get(name) === undefined);
    expect(missing).toEqual([]);
  });
});

type MutableDeps = { -readonly [K in keyof ScoringCompositionDeps]?: ScoringCompositionDeps[K] };

describe('scoring composition — missing a required dependency is refused at runtime', () => {
  it('refuses for each required key, one at a time', () => {
    for (const key of ['pool', 'clock', 'identifiers', 'audit', 'principals'] as const) {
      const broken: MutableDeps = { ...validDeps() };
      delete broken[key];
      expect(() => register(broken as ScoringCompositionDeps), key).toThrow(key);
    }
  });

  it('does not reject a fully-supplied deps object', () => {
    expect(() => register(validDeps())).not.toThrow();
  });
});

function importsComposition(source: string): boolean {
  return /from\s+['"]\.\/composition(\.js)?['"]/u.test(source);
}

describe('the public barrel does not import the composition module', () => {
  it('index.ts contains no import of composition.js', () => {
    const code = readCode(resolve(CONTEXT_DIR, 'public/index.ts'));
    expect(importsComposition(code)).toBe(false);
  });

  it('the check itself fires on a planted re-export', () => {
    expect(importsComposition(`export * from './composition.js';\n`)).toBe(true);
  });
});

describe('PostgresEventPublisher — durable, one transaction per publish', () => {
  function fakeClient() {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text);
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    return { client, calls };
  }

  it('wraps the emit in BEGIN/COMMIT and releases the client', async () => {
    const { client, calls } = fakeClient();
    const pool = { connect: async () => client } as unknown as Pool;
    const publisher = new PostgresEventPublisher(pool);

    await publisher.publish({
      eventId: 'evt-1',
      eventType: 'AttemptScored',
      schemaVersion: 1,
      correlationId: 'corr-1',
      occurredAt: new Date('2026-08-13T00:00:00.000Z'),
      principal: { kind: 'system', id: 'sys-1', roleContext: [] },
      payload: {
        scoreRecordId: 'sr-1',
        attemptId: 'a-1',
        generation: 1,
        markingRuleSetHash: 'hash-1',
        ruleSchemaVersion: 1,
        totalRaw: '4',
        totalMaxAvailable: '4',
      },
    });

    expect(calls[0]).toBe('BEGIN');
    expect(calls.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases when the emit fails, and rethrows', async () => {
    // Everything except the transaction control statements fails — the
    // emitter's own INSERT is the thing under test, not its exact text.
    const client = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
        throw new Error('boom');
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const publisher = new PostgresEventPublisher(pool);

    await expect(
      publisher.publish({
        eventId: 'evt-2',
        eventType: 'AttemptScored',
        schemaVersion: 1,
        correlationId: 'corr-1',
        occurredAt: new Date('2026-08-13T00:00:00.000Z'),
        principal: { kind: 'system', id: 'sys-1', roleContext: [] },
        payload: {
          scoreRecordId: 'sr-1',
          attemptId: 'a-1',
          generation: 1,
          markingRuleSetHash: 'hash-1',
          ruleSchemaVersion: 1,
          totalRaw: '4',
          totalMaxAvailable: '4',
        },
      }),
    ).rejects.toThrow('boom');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
