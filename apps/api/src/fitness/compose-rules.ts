import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * Tier 2 (ADR-0013): every assertion here is over the **parsed** Compose
 * file, never a runtime property. Nothing in this module claims a boot
 * time or that any container started — F8 stays `Fail — blocked` until
 * `docker compose -f infra/compose/docker-compose.yml up --wait` has
 * actually been run on a machine with Docker, which no assertion here can
 * substitute for.
 */

export const REQUIRED_SERVICES = ['postgres', 'valkey', 'minio', 'ai-fixture', 'api', 'studio'] as const;

const HEALTHCHECK_KEYS = ['test', 'interval', 'timeout', 'retries', 'start_period'] as const;
const KEY_SHAPED_ENV_PATTERN = /_?(API_?KEY|SECRET|TOKEN)$/iu;

export interface ComposeViolation {
  readonly rule: string;
  readonly detail: string;
}

interface ComposeService {
  image?: string;
  build?: unknown;
  ports?: string[];
  healthcheck?: Record<string, unknown>;
  depends_on?: unknown;
  environment?: Record<string, string> | string[];
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

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

/** The full check set, run over an already-parsed Compose file. */
export function checkCompose(compose: ComposeFile): ComposeViolation[] {
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

    // Port collisions.
    for (const mapping of service.ports ?? []) {
      const hostPort = mapping.split(':')[0] ?? mapping;
      const existing = publishedPorts.get(hostPort) ?? [];
      publishedPorts.set(hostPort, [...existing, name]);
    }

    // No key-shaped environment variable, anywhere — the stack must boot
    // with no API key (TECH-STACK §8).
    for (const [key, value] of serviceEnvEntries(service)) {
      if (KEY_SHAPED_ENV_PATTERN.test(key)) {
        violations.push({ rule: 'KEY_SHAPED_ENV_VAR', detail: `${name}: ${key}` });
      }
      void value;
    }
  }

  for (const [port, owners] of publishedPorts) {
    if (owners.length > 1) {
      violations.push({ rule: 'DUPLICATE_HOST_PORT', detail: `${port}: ${owners.join(', ')}` });
    }
  }

  // postgres publishes 5432 (DEC-M0-8).
  const postgresPorts = (services['postgres']?.ports ?? []).map((mapping) => mapping.split(':')[0]);
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
