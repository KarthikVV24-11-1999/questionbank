import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { baseDirOf, checkCompose, LOOPBACK_ONLY_SERVICES, parseCompose, parsePublished, REQUIRED_SERVICES, SECRET_ENV } from './compose-rules.js';

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
    expect(checkCompose(compose, baseDirOf(COMPOSE_PATH))).toEqual([]);
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
    mutated.services!['studio']!.ports = ['127.0.0.1:5432:5432'];
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
    (mutated.services!['api']!.environment as Record<string, string>)['AI_PROVIDER_API_KEY'] = 'sk-fake';
    expect(checkCompose(mutated).some((v) => v.rule === 'KEY_SHAPED_ENV_VAR')).toBe(true);
  });

  it('postgres not publishing 5432 is a violation', () => {
    const mutated = clone(real);
    mutated.services!['postgres']!.ports = ['127.0.0.1:5433:5432'];
    expect(checkCompose(mutated).some((v) => v.rule === 'POSTGRES_PORT')).toBe(true);
  });

  it('a dependency cycle is a violation', () => {
    const mutated = clone(real);
    mutated.services!['postgres']!.depends_on = { api: { condition: 'service_healthy' } };
    expect(checkCompose(mutated).some((v) => v.rule === 'DEPENDENCY_CYCLE')).toBe(true);
  });

  it('a build context that is not on disk is a violation, and so is a Dockerfile that is not in it', () => {
    const base = baseDirOf(COMPOSE_PATH);
    const noContext = clone(real);
    noContext.services!['api']!.build = { context: '../nowhere', dockerfile: 'apps/api/Dockerfile' };
    expect(checkCompose(noContext, base).some((v) => v.rule === 'BUILD_CONTEXT_MISSING')).toBe(true);
    const noFile = clone(real);
    noFile.services!['learn']!.build = { context: '../..', dockerfile: 'apps/learn/Dockerfile.missing' };
    expect(checkCompose(noFile, base).some((v) => v.rule === 'DOCKERFILE_MISSING' && v.detail.startsWith('learn'))).toBe(true);
    // a shorthand build names a context only, and its Dockerfile is the one called Dockerfile in it
    const shorthand = clone(real);
    shorthand.services!['studio']!.build = '../..';
    expect(checkCompose(shorthand, base).some((v) => v.rule === 'DOCKERFILE_MISSING' && v.detail.startsWith('studio'))).toBe(true);
    // and without the directory to read from, the disk is not looked at: the parse alone is Tier 2
    expect(checkCompose(noContext).some((v) => v.rule === 'BUILD_CONTEXT_MISSING')).toBe(false);
  });

  it('a secret written into the file as a value is a violation, for each of the three', () => {
    for (const key of SECRET_ENV) {
      const mutated = clone(real);
      (mutated.services!['api']!.environment as Record<string, string>)[key] = 'written-here';
      expect(checkCompose(mutated).some((v) => v.rule === 'SECRET_NOT_A_REFERENCE' && v.detail.endsWith(key)), key).toBe(true);
    }
    const real_ = clone(real);
    expect(checkCompose(real_).filter((v) => v.rule === 'SECRET_NOT_A_REFERENCE')).toEqual([]);
  });

  it('a service that starts by default waiting on one that does not is a violation', () => {
    const mutated = clone(real);
    mutated.services!['api']!.depends_on = { postgres: { condition: 'service_healthy' }, minio: { condition: 'service_healthy' } };
    expect(checkCompose(mutated).some((v) => v.rule === 'DEPENDS_ON_OPTIONAL_SERVICE' && v.detail === 'api -> minio')).toBe(true);
    // two services outside the default set waiting on one another is not that
    const optional = clone(real);
    optional.services!['valkey']!.depends_on = { minio: { condition: 'service_healthy' } };
    expect(checkCompose(optional).some((v) => v.rule === 'DEPENDS_ON_OPTIONAL_SERVICE')).toBe(false);
  });

  it('the learner app is in the stack, behind the API, with its own healthcheck', () => {
    const learn = real.services!['learn']!;
    expect(learn.depends_on).toEqual({ api: { condition: 'service_healthy' } });
    expect(learn.healthcheck).toBeDefined();
    expect(Object.keys(real.services!)).not.toContain('ai-fixture');
  });

  it('a depends_on entry with no service_healthy condition is a violation', () => {
    const mutated = clone(real);
    mutated.services!['api']!.depends_on = { postgres: { condition: 'service_started' } };
    expect(checkCompose(mutated).some((v) => v.rule === 'DEPENDS_ON_NO_HEALTH_CONDITION')).toBe(true);
  });
});

describe('the commands to boot it', () => {
  it('are named in the file, in the order the stack is brought up: build, the database, the migrations, the rest', () => {
    const source = readFileSync(COMPOSE_PATH, 'utf8');
    const order = ['compose -f infra/compose/docker-compose.yml build', 'up -d --wait postgres', 'run --rm --no-deps api node migrate.js', 'up -d --wait\n'].map((command) => source.indexOf(command));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('published ports (D123)', () => {
  const real = parseCompose(COMPOSE_PATH);

  it('reads the two-field and the three-field forms, and a protocol', () => {
    expect(parsePublished('5432:5432')).toEqual({ address: null, hostPort: '5432' });
    expect(parsePublished('127.0.0.1:5432:5432')).toEqual({ address: '127.0.0.1', hostPort: '5432' });
    expect(parsePublished('0.0.0.0:3000:3000/tcp')).toEqual({ address: '0.0.0.0', hostPort: '3000' });
  });

  it('holds the database, the API, Studio and minio to the loopback address, and says which port', () => {
    expect([...LOOPBACK_ONLY_SERVICES]).toEqual(['postgres', 'api', 'studio', 'minio']);
    for (const name of LOOPBACK_ONLY_SERVICES) {
      for (const published of real.services![name]!.ports ?? []) expect(parsePublished(published).address, `${name}: ${published}`).toBe('127.0.0.1');
    }
    for (const widened of ['5432:5432', '0.0.0.0:5432:5432', '[::]:5432:5432']) {
      const mutated = clone(real);
      mutated.services!['postgres']!.ports = [widened];
      expect(checkCompose(mutated), widened).toContainEqual({ rule: 'PORT_NOT_LOOPBACK', detail: `postgres: ${widened}` });
    }
  });

  it('leaves the learner app\'s port to be reached', () => {
    const mutated = clone(real);
    mutated.services!['learn']!.ports = ['8080:8080'];
    expect(checkCompose(mutated).filter((v) => v.rule === 'PORT_NOT_LOOPBACK')).toEqual([]);
  });

  it('still sees a collision between two published ports on one address', () => {
    const mutated = clone(real);
    mutated.services!['studio']!.ports = ['127.0.0.1:5432:4173'];
    expect(checkCompose(mutated).some((v) => v.rule === 'DUPLICATE_HOST_PORT')).toBe(true);
  });
});

describe('the database asks for a password (D123)', () => {
  const real = parseCompose(COMPOSE_PATH);

  it('is refused when it trusts whoever connects', () => {
    const mutated = clone(real);
    (mutated.services!['postgres']!.environment as Record<string, string>)['POSTGRES_HOST_AUTH_METHOD'] = 'trust';
    expect(checkCompose(mutated).map((v) => v.rule)).toContain('POSTGRES_TRUST');
  });

  it('is refused when the password is written into the file, or absent', () => {
    const written = clone(real);
    (written.services!['postgres']!.environment as Record<string, string>)['POSTGRES_PASSWORD'] = 'hunter2';
    expect(checkCompose(written).map((v) => v.rule)).toContain('POSTGRES_PASSWORD_NOT_A_REFERENCE');
    const absent = clone(real);
    delete (absent.services!['postgres']!.environment as Record<string, string>)['POSTGRES_PASSWORD'];
    expect(checkCompose(absent).map((v) => v.rule)).toContain('POSTGRES_PASSWORD_NOT_A_REFERENCE');
  });
});

