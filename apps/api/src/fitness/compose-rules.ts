import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * What can be asserted of the Compose file without running it (ADR-0013). Everything here is over the **parsed** file and the disk it names, never a runtime property: that the
 * build contexts and Dockerfiles it names exist, that the three secrets are references and not values, that a service that starts by default does not depend on one that does not. Whether
 * the stack boots is not asserted here and is not claimed by this module: the `compose` job in `.github/workflows/ci.yml` brings it up, and F8 in docs/ARCHITECTURE.md carries what that measured.
 *
 * Until M8 Track I this module checked the properties of three services whose build contexts did not exist (debt D38), because a parse sees a `build:` key and never whether it resolves.
 * The disk is read now; `ai-fixture`, which nothing called, is gone from the file and from this list.
 */
export const REQUIRED_SERVICES = ['postgres', 'valkey', 'minio', 'api', 'learn', 'studio'] as const;

/** The secrets the API reads: each is named in the file and its value is the runner's to supply, so each must be a `${NAME}` reference. */
export const SECRET_ENV = ['AUTH_SIGNING_KEY', 'AUDIT_ANCHOR_KEY', 'FORM_PACKAGE_SIGNING_KEY'] as const;

const HEALTHCHECK_KEYS = ['test', 'interval', 'timeout', 'retries', 'start_period'] as const;
const KEY_SHAPED_ENV_PATTERN = /_?(API_?KEY|SECRET|TOKEN)$/iu;

/**
 * The services that hold something worth taking, which must publish only on the loopback address (D123). Postgres is the superuser's to whoever reaches it, the API and Studio are
 * the unproxied way past the learner app's nginx, and minio holds a fixed password. The learner app's port is the one that is meant to be reached, by the TLS proxy on the same host.
 */
export const LOOPBACK_ONLY_SERVICES = ['postgres', 'api', 'studio', 'minio'] as const;
export const LOOPBACK = '127.0.0.1';

/** A published port as Compose reads it: `[ip:]host:container[/protocol]`. The host port is the second from last field, and the address, if there is one, is the one before it. */
export function parsePublished(mapping: string): { readonly address: string | null; readonly hostPort: string } {
  const fields = mapping.split('/')[0]!.split(':');
  const hostPort = fields.at(-2) ?? fields[0] ?? mapping;
  return { address: fields.length >= 3 ? (fields.at(-3) as string) : null, hostPort };
}

export interface ComposeViolation {
  readonly rule: string;
  readonly detail: string;
}

interface ComposeService {
  image?: string;
  build?: { context?: string; dockerfile?: string } | string;
  profiles?: string[];
  ports?: string[];
  healthcheck?: Record<string, unknown>;
  depends_on?: unknown;
  environment?: Record<string, string> | string[];
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

/** The directory a Compose file's relative paths are read from. */
export const baseDirOf = (path: string): string => dirname(path);

export function parseCompose(path: string): ComposeFile {
  return parse(readFileSync(path, 'utf8')) as ComposeFile;
}

function serviceEnvEntries(service: ComposeService): readonly [string, string][] {
  if (service.environment === undefined) return [];
  if (Array.isArray(service.environment)) {
    return service.environment.map((entry) => {
      const [key, ...rest] = entry.split('=');
      return [key ?? '', rest.join('=')] as [string, string];
    });
  }
  return Object.entries(service.environment as Record<string, string>);
}

/** The full check set, run over an already-parsed Compose file. `baseDir` is the directory the file is in; given, the build contexts and Dockerfiles it names are looked for on disk. */
export function checkCompose(compose: ComposeFile, baseDir?: string): ComposeViolation[] {
  const violations: ComposeViolation[] = [];
  const services = compose.services ?? {};
  const names = Object.keys(services);

  // Set equality against the closed constant, both directions.
  const missing = REQUIRED_SERVICES.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !(REQUIRED_SERVICES as readonly string[]).includes(name));
  for (const name of missing) violations.push({ rule: 'SERVICE_SET', detail: `missing service: ${name}` });
  for (const name of extra) violations.push({ rule: 'SERVICE_SET', detail: `unlisted service: ${name}` });

  const publishedPorts = new Map<string, string[]>();

  for (const [name, service] of Object.entries(services)) {
    // Healthcheck completeness.
    const healthcheck = service.healthcheck;
    if (healthcheck === undefined) {
      violations.push({ rule: 'HEALTHCHECK_MISSING', detail: name });
    } else {
      for (const key of HEALTHCHECK_KEYS) {
        if (!(key in healthcheck)) {
          violations.push({ rule: 'HEALTHCHECK_INCOMPLETE', detail: `${name}: missing ${key}` });
        }
      }
    }

    // depends_on must use the map form with an explicit condition — a bare
    // list is exactly the mistake that makes an unproven boot-time claim
    // look correct.
    const dependsOn = service.depends_on;
    if (dependsOn !== undefined) {
      if (Array.isArray(dependsOn)) {
        violations.push({ rule: 'DEPENDS_ON_BARE_LIST', detail: name });
      } else if (typeof dependsOn === 'object' && dependsOn !== null) {
        for (const [dep, spec] of Object.entries(dependsOn as Record<string, unknown>)) {
          const condition = (spec as { condition?: unknown } | null)?.condition;
          if (condition !== 'service_healthy') {
            violations.push({ rule: 'DEPENDS_ON_NO_HEALTH_CONDITION', detail: `${name} -> ${dep}` });
          }
        }
      }
    }

    // Image pinning — no `latest`, ever, and a tag is required when an
    // image is named at all (a `build:` service is exempt: it has no tag).
    if (service.image !== undefined) {
      const tag = service.image.split(':')[1];
      if (tag === undefined || tag === 'latest') {
        violations.push({ rule: 'IMAGE_NOT_PINNED', detail: `${name}: ${service.image}` });
      }
    }

    // A build that names a context or a Dockerfile that is not there cannot be built (D38 was exactly this, for three services, for eight milestones).
    if (baseDir !== undefined && service.build !== undefined) {
      const build = typeof service.build === 'string' ? { context: service.build } : service.build;
      const context = resolve(baseDir, build.context ?? '.');
      if (!existsSync(context)) violations.push({ rule: 'BUILD_CONTEXT_MISSING', detail: `${name}: ${build.context ?? '.'}` });
      else if (!existsSync(resolve(context, build.dockerfile ?? 'Dockerfile'))) violations.push({ rule: 'DOCKERFILE_MISSING', detail: `${name}: ${build.dockerfile ?? 'Dockerfile'}` });
    }

    // Port collisions.
    for (const mapping of service.ports ?? []) {
      const { address, hostPort } = parsePublished(mapping);
      if ((LOOPBACK_ONLY_SERVICES as readonly string[]).includes(name) && address !== LOOPBACK) {
        violations.push({ rule: 'PORT_NOT_LOOPBACK', detail: `${name}: ${mapping}` });
      }
      const existing = publishedPorts.get(hostPort) ?? [];
      publishedPorts.set(hostPort, [...existing, name]);
    }

    // The database asks for a password, and the password is whoever runs the stack's to supply (D123): `trust` makes the port's reachability the only protection there is.
    if (name === 'postgres') {
      const env = Object.fromEntries(serviceEnvEntries(service));
      if (env['POSTGRES_HOST_AUTH_METHOD'] === 'trust') violations.push({ rule: 'POSTGRES_TRUST', detail: 'POSTGRES_HOST_AUTH_METHOD is trust' });
      if (!/^\$\{[A-Z0-9_]+\}$/u.test(env['POSTGRES_PASSWORD'] ?? '')) violations.push({ rule: 'POSTGRES_PASSWORD_NOT_A_REFERENCE', detail: 'POSTGRES_PASSWORD is not a ${NAME} reference' });
    }

    // No key-shaped environment variable, anywhere — the stack must boot
    // with no API key (TECH-STACK §8).
    for (const [key, value] of serviceEnvEntries(service)) {
      if (KEY_SHAPED_ENV_PATTERN.test(key)) {
        violations.push({ rule: 'KEY_SHAPED_ENV_VAR', detail: `${name}: ${key}` });
      }
      // a secret is whoever runs the stack's to supply: a reference to the environment, never a value written into the file
      if ((SECRET_ENV as readonly string[]).includes(key) && !/^\$\{[A-Z0-9_]+\}$/u.test(value)) {
        violations.push({ rule: 'SECRET_NOT_A_REFERENCE', detail: `${name}: ${key}` });
      }
    }
  }

  // A service that starts by default must not wait on one that does not (a profile keeps a service out of `up`), or `up --wait` would wait on something that is never started.
  for (const [name, service] of Object.entries(services)) {
    if (service.profiles !== undefined && service.profiles.length > 0) continue;
    const deps = service.depends_on === undefined || Array.isArray(service.depends_on) ? [] : Object.keys(service.depends_on as Record<string, unknown>);
    for (const dep of deps) {
      if ((services[dep]?.profiles ?? []).length > 0) violations.push({ rule: 'DEPENDS_ON_OPTIONAL_SERVICE', detail: `${name} -> ${dep}` });
    }
  }

  for (const [port, owners] of publishedPorts) {
    if (owners.length > 1) {
      violations.push({ rule: 'DUPLICATE_HOST_PORT', detail: `${port}: ${owners.join(', ')}` });
    }
  }

  // postgres publishes 5432 (DEC-M0-8).
  const postgresPorts = (services['postgres']?.ports ?? []).map((mapping) => parsePublished(mapping).hostPort);
  if (!postgresPorts.includes('5432')) {
    violations.push({ rule: 'POSTGRES_PORT', detail: 'postgres does not publish 5432' });
  }

  // Dependency graph is acyclic — a straightforward DFS over depends_on.
  const graph = new Map<string, string[]>();
  for (const [name, service] of Object.entries(services)) {
    const dependsOn = service.depends_on;
    const deps =
      dependsOn === undefined
        ? []
        : Array.isArray(dependsOn)
          ? dependsOn
          : Object.keys(dependsOn as Record<string, unknown>);
    graph.set(name, deps);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  function visit(node: string, stack: readonly string[]): void {
    if (state.get(node) === 'done') return;
    if (stack.includes(node)) {
      violations.push({ rule: 'DEPENDENCY_CYCLE', detail: [...stack, node].join(' -> ') });
      return;
    }
    state.set(node, 'visiting');
    for (const dep of graph.get(node) ?? []) visit(dep, [...stack, node]);
    state.set(node, 'done');
  }
  for (const name of graph.keys()) visit(name, []);

  return violations;
}
