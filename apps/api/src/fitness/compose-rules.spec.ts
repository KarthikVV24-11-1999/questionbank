import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCompose, parseCompose, REQUIRED_SERVICES } from './compose-rules.js';

const COMPOSE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/compose/docker-compose.yml',
);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('the real Compose file', () => {
  const compose = parseCompose(COMPOSE_PATH);

  it('parses, and names a non-zero number of services', () => {
    expect(Object.keys(compose.services ?? {}).length).toBeGreaterThan(0);
  });

  it('passes every check', () => {
    expect(checkCompose(compose)).toEqual([]);
  });

  it('names exactly the required service set', () => {
    expect(Object.keys(compose.services ?? {}).sort()).toEqual([...REQUIRED_SERVICES].sort());
  });
});

describe('planted mutations — one per assertion', () => {
  const real = parseCompose(COMPOSE_PATH);

  it('a bare depends_on list is a violation', () => {
    const mutated = clone(real);
    mutated.services!['api']!.depends_on = ['postgres'] as never;
    expect(checkCompose(mutated).some((v) => v.rule === 'DEPENDS_ON_BARE_LIST')).toBe(true);
  });

  it('a latest tag is a violation', () => {
    const mutated = clone(real);
    mutated.services!['postgres']!.image = 'postgres:latest';
    expect(checkCompose(mutated).some((v) => v.rule === 'IMAGE_NOT_PINNED')).toBe(true);
  });

  it('a duplicate host port is a violation', () => {
    const mutated = clone(real);
    mutated.services!['studio']!.ports = ['5432:5432'];
    expect(checkCompose(mutated).some((v) => v.rule === 'DUPLICATE_HOST_PORT')).toBe(true);
  });

  it('a missing start_period is a violation', () => {
    const mutated = clone(real);
    delete (mutated.services!['postgres']!.healthcheck as Record<string, unknown>)['start_period'];
    expect(checkCompose(mutated).some((v) => v.rule === 'HEALTHCHECK_INCOMPLETE')).toBe(true);
  });

  it('an added, unlisted service is a violation', () => {
    const mutated = clone(real);
    mutated.services!['extra-service'] = { image: 'busybox:1' };
    expect(checkCompose(mutated).some((v) => v.rule === 'SERVICE_SET')).toBe(true);
  });

  it('a missing service is a violation', () => {
    const mutated = clone(real);
    delete mutated.services!['valkey'];
    expect(checkCompose(mutated).some((v) => v.rule === 'SERVICE_SET')).toBe(true);
  });

  it('a key-shaped environment variable is a violation, even outside ai-fixture', () => {
    const mutated = clone(real);
    (mutated.services!['api']!.environment as Record<string, string>)['CLAUDE_API_KEY'] = 'sk-fake';
    expect(checkCompose(mutated).some((v) => v.rule === 'KEY_SHAPED_ENV_VAR')).toBe(true);
  });

  it('postgres not publishing 5432 is a violation', () => {
    const mutated = clone(real);
    mutated.services!['postgres']!.ports = ['5433:5432'];
    expect(checkCompose(mutated).some((v) => v.rule === 'POSTGRES_PORT')).toBe(true);
  });

  it('a dependency cycle is a violation', () => {
    const mutated = clone(real);
    mutated.services!['postgres']!.depends_on = { api: { condition: 'service_healthy' } };
    expect(checkCompose(mutated).some((v) => v.rule === 'DEPENDENCY_CYCLE')).toBe(true);
  });

  it('a depends_on entry with no service_healthy condition is a violation', () => {
    const mutated = clone(real);
    mutated.services!['api']!.depends_on = { postgres: { condition: 'service_started' } };
    expect(checkCompose(mutated).some((v) => v.rule === 'DEPENDS_ON_NO_HEALTH_CONDITION')).toBe(true);
  });
});

describe("the successor command this Tier-2 spec cannot run itself", () => {
  it('is named verbatim in the compose file', () => {
    const source = readFileSync(COMPOSE_PATH, 'utf8');
    expect(source).toContain('docker compose -f infra/compose/docker-compose.yml up --wait');
  });
});
