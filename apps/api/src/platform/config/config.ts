/**
 * The one place a secret enters the process (ENGINEERING-HANDBOOK §9 rule 17
 * / F16). `main.ts` is the only caller that turns a load failure into a
 * process exit — this module only ever returns.
 *
 * `platform/` is infrastructure, not a bounded context, so the domain rule
 * that forbids importing another context's `Result` (content's, curriculum's,
 * scoring's) does not apply here by the letter of §9 rule 2 — but the
 * argument that put a `Result` in each context anyway still holds for a
 * one-file module: pulling in a context's copy for this alone would be the
 * first thread by which `platform/` reaches into `contexts/`, which is
 * backwards for a module every context's boot depends on.
 */

export type ConfigResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ConfigError };

export interface ConfigError {
  readonly key: ConfigKey;
  readonly message: string;
}

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The closed set of configuration keys this application reads. Adding one edits this list. */
export const CONFIG_KEYS = [
  'databaseUrl',
  'port',
  'nodeEnv',
  'authSigningKey',
  'auditAnchorKey',
  'authIssuer',
  'authTokenTtlSeconds',
  'mediaStorageRoot',
  'logLevel',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly nodeEnv: NodeEnv;
  /** No default, deliberately (DEC-M0-7) — a signing key an app never chose to set is not a safe one. */
  readonly authSigningKey: string;
  /**
   * The audit anchor's HMAC key (M4-24, DEC-M4-4 → ADR-0020). No default, for
   * DEC-M0-7's reason, and **required to differ from `authSigningKey`** — the
   * whole argument for a second key is that one key compromised should not
   * forge both sessions and history, which a config that accepts the same
   * value for both silently gives away.
   */
  readonly auditAnchorKey: string;
  readonly authIssuer: string;
  readonly authTokenTtlSeconds: number;
  readonly mediaStorageRoot: string;
  readonly logLevel: LogLevel;
}

/** The minimum key length the auth stub (M0-05) accepts — matched here so config fails first. */
const MIN_SIGNING_KEY_BYTES = 32;

const DEFAULTS = {
  port: '3000',
  nodeEnv: 'development',
  authIssuer: 'questionbank',
  authTokenTtlSeconds: '3600',
  mediaStorageRoot: './var/media',
  logLevel: 'info',
} as const;

/** Environment variable name for each config key — the only mapping this module needs. */
/** Exported so F39 (secret-rules.ts, M0-23) can assert `.env.example` names exactly this set. */
export const ENV_VAR_NAMES: Record<ConfigKey, string> = {
  databaseUrl: 'DATABASE_URL',
  port: 'PORT',
  nodeEnv: 'NODE_ENV',
  authSigningKey: 'AUTH_SIGNING_KEY',
  auditAnchorKey: 'AUDIT_ANCHOR_KEY',
  authIssuer: 'AUTH_ISSUER',
  authTokenTtlSeconds: 'AUTH_TOKEN_TTL_SECONDS',
  mediaStorageRoot: 'MEDIA_STORAGE_ROOT',
  logLevel: 'LOG_LEVEL',
};

function fail(key: ConfigKey, message: string): ConfigResult<never> {
  return { ok: false, error: { key, message } };
}

function requireValue(env: Readonly<Record<string, string | undefined>>, key: ConfigKey): ConfigResult<string> {
  const raw = env[ENV_VAR_NAMES[key]];
  if (raw === undefined || raw.length === 0) {
    return fail(key, `${ENV_VAR_NAMES[key]} is required and was not set`);
  }
  return { ok: true, value: raw };
}

function withDefault(env: Readonly<Record<string, string | undefined>>, key: ConfigKey, fallback: string): string {
  const raw = env[ENV_VAR_NAMES[key]];
  return raw === undefined || raw.length === 0 ? fallback : raw;
}

function parseDatabaseUrl(env: Readonly<Record<string, string | undefined>>): ConfigResult<string> {
  const required = requireValue(env, 'databaseUrl');
  if (!required.ok) return required;
  try {
    void new URL(required.value);
  } catch {
    return fail('databaseUrl', 'DATABASE_URL is not a valid URL');
  }
  return required;
}

function parsePort(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  const raw = withDefault(env, 'port', DEFAULTS.port);
  if (!/^\d+$/u.test(raw)) {
    return fail('port', 'PORT must be a positive integer');
  }
  const value = Number(raw);
  if (value < 1 || value > 65_535) {
    return fail('port', 'PORT must be between 1 and 65535');
  }
  return { ok: true, value };
}

function parseNodeEnv(env: Readonly<Record<string, string | undefined>>): ConfigResult<NodeEnv> {
  const raw = withDefault(env, 'nodeEnv', DEFAULTS.nodeEnv);
  if (!(NODE_ENVS as readonly string[]).includes(raw)) {
    return fail('nodeEnv', `NODE_ENV must be one of ${NODE_ENVS.join(', ')} — got an unrecognised value`);
  }
  return { ok: true, value: raw as NodeEnv };
}

function parseAuthSigningKey(env: Readonly<Record<string, string | undefined>>): ConfigResult<string> {
  const required = requireValue(env, 'authSigningKey');
  if (!required.ok) return required;
  if (Buffer.byteLength(required.value, 'utf8') < MIN_SIGNING_KEY_BYTES) {
    // The message names the requirement, never the value or its length in a way that narrows a guess.
    return fail('authSigningKey', `AUTH_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes`);
  }
  return required;
}

/**
 * The audit anchor's key (M4-24). Same minimum as the auth key and the same
 * no-default rule, plus one more: it may not *be* the auth key. ADR-0020's
 * reason for a separate key is that a single compromise should not forge both
 * sessions and history; two keys with the same value are one key wearing two
 * names, and nothing else in the system would notice.
 */
function parseAuditAnchorKey(
  env: Readonly<Record<string, string | undefined>>,
  authSigningKey: string,
): ConfigResult<string> {
  const required = requireValue(env, 'auditAnchorKey');
  if (!required.ok) return required;
  if (Buffer.byteLength(required.value, 'utf8') < MIN_SIGNING_KEY_BYTES) {
    // Names the requirement, never the value or a length that narrows a guess.
    return fail('auditAnchorKey', `AUDIT_ANCHOR_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes`);
  }
  if (required.value === authSigningKey) {
    return fail('auditAnchorKey', 'AUDIT_ANCHOR_KEY must not equal AUTH_SIGNING_KEY (ADR-0020)');
  }
  return required;
}

function parseAuthIssuer(env: Readonly<Record<string, string | undefined>>): ConfigResult<string> {
  const raw = withDefault(env, 'authIssuer', DEFAULTS.authIssuer);
  if (raw.trim().length === 0) {
    return fail('authIssuer', 'AUTH_ISSUER must not be blank');
  }
  return { ok: true, value: raw };
}

function parseAuthTokenTtlSeconds(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  const raw = withDefault(env, 'authTokenTtlSeconds', DEFAULTS.authTokenTtlSeconds);
  if (!/^\d+$/u.test(raw) || Number(raw) < 1) {
    return fail('authTokenTtlSeconds', 'AUTH_TOKEN_TTL_SECONDS must be a positive integer');
  }
  return { ok: true, value: Number(raw) };
}

function parseMediaStorageRoot(env: Readonly<Record<string, string | undefined>>): ConfigResult<string> {
  const raw = withDefault(env, 'mediaStorageRoot', DEFAULTS.mediaStorageRoot);
  if (raw.trim().length === 0) {
    return fail('mediaStorageRoot', 'MEDIA_STORAGE_ROOT must not be blank');
  }
  return { ok: true, value: raw };
}

function parseLogLevel(env: Readonly<Record<string, string | undefined>>): ConfigResult<LogLevel> {
  const raw = withDefault(env, 'logLevel', DEFAULTS.logLevel);
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    return fail('logLevel', `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} — got an unrecognised value`);
  }
  return { ok: true, value: raw as LogLevel };
}

/**
 * Total: never throws, and returns the first violated key's error rather
 * than collecting all of them — one bad value is enough to refuse boot, and
 * fixing it can surface the next.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult<AppConfig> {
  const databaseUrl = parseDatabaseUrl(env);
  if (!databaseUrl.ok) return databaseUrl;

  const port = parsePort(env);
  if (!port.ok) return port;

  const nodeEnv = parseNodeEnv(env);
  if (!nodeEnv.ok) return nodeEnv;

  const authSigningKey = parseAuthSigningKey(env);
  if (!authSigningKey.ok) return authSigningKey;

  const auditAnchorKey = parseAuditAnchorKey(env, authSigningKey.value);
  if (!auditAnchorKey.ok) return auditAnchorKey;

  const authIssuer = parseAuthIssuer(env);
  if (!authIssuer.ok) return authIssuer;

  const authTokenTtlSeconds = parseAuthTokenTtlSeconds(env);
  if (!authTokenTtlSeconds.ok) return authTokenTtlSeconds;

  const mediaStorageRoot = parseMediaStorageRoot(env);
  if (!mediaStorageRoot.ok) return mediaStorageRoot;

  const logLevel = parseLogLevel(env);
  if (!logLevel.ok) return logLevel;

  return {
    ok: true,
    value: {
      databaseUrl: databaseUrl.value,
      port: port.value,
      nodeEnv: nodeEnv.value,
      authSigningKey: authSigningKey.value,
      auditAnchorKey: auditAnchorKey.value,
      authIssuer: authIssuer.value,
      authTokenTtlSeconds: authTokenTtlSeconds.value,
      mediaStorageRoot: mediaStorageRoot.value,
      logLevel: logLevel.value,
    },
  };
}

/**
 * The one call site in the application that reads `process.env` (F16) — a
 * thin wrapper so `main.ts` calls `loadConfigFromProcessEnv()` and never
 * touches `process.env` itself. `loadConfig` stays pure and total for
 * testing; this is what makes that purity not just a convenience.
 */
export function loadConfigFromProcessEnv(): ConfigResult<AppConfig> {
  return loadConfig(process.env);
}
