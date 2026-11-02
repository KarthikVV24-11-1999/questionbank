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

import { parseRouteLimits, type RouteLimits } from '../rate-limit/rate-limiter.js';

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
  'reviewWarnAfterHours',
  'reviewEscalateAfterHours',
  'reviewLeaseHours',
  'reviewSampleRate',
  'generationPrecheckConfig',
  'formPackageSigningKey',
  'timeOnItemIntervalCapMs',
  'backgroundJobsEnabled',
  'maxSessionsPerUser',
  'rateLimitLogin',
  'rateLimitRegister',
  'rateLimitRecovery',
  'rateLimitReset',
  'rateLimitVerification',
  'rateLimitPasswordChange',
  'passwordHashConcurrency',
  'passwordHashQueue',
  'passwordHashWaitMs',
  'trustProxyHops',
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
  /**
   * `ReviewPolicy`'s four thresholds (DEC-M4-1, DEC-M4-14), read here and
   * constructed into a `ReviewPolicy` value by the caller — the domain
   * (`domain/review/review-policy.ts`) owns no default and reads no config,
   * so a policy with these defaults is a value this module hands it, not a
   * fallback the domain reaches for.
   */
  readonly reviewWarnAfterHours: number;
  readonly reviewEscalateAfterHours: number;
  readonly reviewLeaseHours: number;
  readonly reviewSampleRate: number;
  /**
   * Which registry rows each judged pre-check runs under (M5-37): a model version
   * and a prompt version per check, keyed by check id. **Absent unless the deployment
   * supplied it** — versions are pinned data (ARCHITECTURE §8, AI-ARCHITECTURE §15),
   * so there is no default to fall back on, and a deployment without it composes
   * generation with every check declared blocked: nothing can then be accepted, which
   * is the honest state of a battery that has not been configured. Only the *shape*
   * is checked here; whether the ids are registry rows, and whether each check has its
   * own prompt (F29), is checked by generation when it builds the battery, and a
   * configuration that fails there refuses boot.
   */
  readonly generationPrecheckConfig?: GenerationPrecheckConfig;
  /**
   * The Ed25519 seed form packages are signed with (M6-26): 32 random bytes, base64.
   * **Absent unless the deployment supplied it, and no default** (DEC-M0-7) — a key
   * the deployment never chose is not one to sign with. Without it the package
   * routes answer as unavailable; the rest of the application boots. Set but not a
   * 32-byte base64 value, and the application refuses to start. Never the auth or
   * audit key: a signature scheme of its own is the point.
   */
  readonly formPackageSigningKey?: string;
  /**
   * The longest one visit → leave interval may count towards an item's time (ASSESSMENT-ENGINE §4, §14 item 5): a
   * learner who backgrounds the app mid-question produces a long interval that was not spent on the item, and the cap
   * discards the excess. **The one source of the value** (M6-37). It is pinned onto each attempt when the attempt is
   * created and told to the device in the attempt response, so a device and the server project one log with one cap
   * and a later change here cannot make them disagree about an attempt already begun.
   */
  readonly timeOnItemIntervalCapMs: number;
  /** The most live sessions one user may hold (M8-03); a login beyond it ends the oldest. */
  readonly maxSessionsPerUser: number;
  /**
   * What each authentication route class allows (M8-07, NFR SEC-09): by where a request came from, and by whom it is about. The numbers are in `DEFAULT_ABUSE_LIMITS` below, with
   * the reasoning. Parsed from `source=100/10s,1000/1h;subject=5/1m,30/15m`; a policy that does not parse refuses boot.
   */
  readonly rateLimitLogin: RouteLimits;
  readonly rateLimitRegister: RouteLimits;
  readonly rateLimitRecovery: RouteLimits;
  /** Resetting a password with a code: by source only, since the person is not yet known. */
  readonly rateLimitReset: RouteLimits;
  /** Submitting a verification code is limited by source; asking for a new one by source and by user. */
  readonly rateLimitVerification: RouteLimits;
  readonly rateLimitPasswordChange: RouteLimits;
  /** How many password derives may run at once, how many may wait, and how long one waits for a slot (M8-08). */
  readonly passwordHashConcurrency: number;
  readonly passwordHashQueue: number;
  readonly passwordHashWaitMs: number;
  /** How many proxies sit in front of the application and may be believed about a client's address (M8-07). Zero: the connection's own address. */
  readonly trustProxyHops: number;
  /**
   * Whether this process runs the background jobs — the outbox relay and the sweeps (M6-38, M6-42). On by default: every instance of
   * the application drains the outbox and sweeps, which is safe because the jobs claim or are idempotent. Off for a process that should
   * serve requests and do nothing else, or while something else is known to be doing the work.
   */
  readonly backgroundJobsEnabled: boolean;
}

/**
 * The cap's default, exported because it is the only literal of the value in the tree: tests that need one take it from here. It is a guess,
 * and recorded as one (D61).
 */
export const DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS = 120_000;

export interface PrecheckPairing {
  readonly modelVersionId: string;
  readonly promptVersionId: string;
}

export type GenerationPrecheckConfig = Readonly<Record<string, PrecheckPairing>>;

/** The minimum key length the auth stub (M0-05) accepts — matched here so config fails first. */
const MIN_SIGNING_KEY_BYTES = 32;

const DEFAULTS = {
  port: '3000',
  nodeEnv: 'development',
  authIssuer: 'questionbank',
  authTokenTtlSeconds: '3600',
  mediaStorageRoot: './var/media',
  logLevel: 'info',
  // DEC-M4-1's own defaults, mirrored here as strings — DEC_M4_1_DEFAULT_POLICY
  // in the domain carries the same four numbers as the fallback a caller who
  // builds a ReviewPolicy without reading config would use; this module's
  // defaults exist independently because config never imports the domain.
  reviewWarnAfterHours: '48',
  reviewEscalateAfterHours: '72',
  reviewLeaseHours: '4',
  reviewSampleRate: '0.05',
  timeOnItemIntervalCapMs: String(DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS),
  backgroundJobsEnabled: 'true',
  maxSessionsPerUser: '5',
  rateLimitLogin: 'source=100/10s,1000/1h;subject=5/1m,30/15m',
  rateLimitRegister: 'source=30/10s,300/1h;subject=3/1m,10/1h',
  rateLimitRecovery: 'source=20/1m,100/1h;subject=2/1m,5/1h',
  rateLimitReset: 'source=30/1m,200/1h',
  rateLimitVerification: 'source=60/1m,600/1h;subject=2/1m,5/1h',
  rateLimitPasswordChange: 'source=20/1m,200/1h;subject=5/1m,20/15m',
  passwordHashConcurrency: '2',
  passwordHashQueue: '256',
  passwordHashWaitMs: '15000',
  trustProxyHops: '0',
} as const;

/**
 * The abuse limits as a deployment gets them when it sets none, parsed once and exported so a test that builds an `AppConfig` by hand takes them from here and not from a copy.
 *
 * **Why these numbers.** The limits must hold an attacker and let a school through. A class of a hundred logging in at nine arrives from one network address inside a minute or
 * two, so a login source allows 100 in ten seconds and 1000 in an hour; one source can then attempt at most 1000 passwords an hour in total. An address is the opposite case: one
 * person, who mistypes a few times. It allows 5 a minute and 30 in fifteen minutes, so guessing at one account is held to a few dozen tries a quarter-hour from the whole world.
 *
 * **Lockout, and why there isn't one.** After repeated failure an address could be locked for longer and longer. That lets anyone who knows an address keep its owner out for
 * as long as they like by failing on purpose, which hands the attacker a denial of service on every student. A fixed window has a ceiling built in: the longest an address
 * can be held is the end of the longest window (fifteen minutes at login), and the owner is let in again when the attacker pauses. What is given up is that a patient attacker
 * is slowed, not stopped: 30 guesses a quarter-hour is 2880 a day at one address, against a password policy that makes a guess expensive to win. A per-address account lockout
 * with unlock by mail is the stronger answer and a product decision; it is not taken here.
 *
 * **Bounding the work.** One derive holds 64 MiB (128 x N x r bytes at N=65536, r=8) for about 150 ms. libuv's pool has four threads by default and also carries file, DNS and
 * compression work, so two derives at once (128 MiB) leave half of it free; four would not. Two slots serve about 13 logins a second, so a hundred students logging in in the same
 * instant are all through in about eight seconds and the last of them waits that long, inside the fifteen seconds a request may wait. The queue holds 256, more than a school's
 * worth, and a request beyond it is refused at once, not queued to wait out its time. If a deployment raises `UV_THREADPOOL_SIZE`, raise the concurrency with it, never above it.
 *
 * Registration and recovery send mail, so their per-address limits are the small ones: three registrations a minute and ten an hour for one address, two recoveries a minute and
 * five an hour, which is also what stops the routes being used to fill a stranger's inbox.
 */
/** For the built-in defaults, which are code and must parse; exported so the check that they do is itself tested. */
export function parseRouteLimitsOrThrow(text: string, subject: boolean): RouteLimits {
  const parsed = parseRouteLimits(text, { subject });
  if (!parsed.ok) throw new Error(`built-in rate limit "${text}" does not parse: ${parsed.message}`);
  return parsed.value;
}

export const DEFAULT_ABUSE_LIMITS = {
  rateLimitLogin: parseRouteLimitsOrThrow(DEFAULTS.rateLimitLogin, true),
  rateLimitRegister: parseRouteLimitsOrThrow(DEFAULTS.rateLimitRegister, true),
  rateLimitRecovery: parseRouteLimitsOrThrow(DEFAULTS.rateLimitRecovery, true),
  rateLimitReset: parseRouteLimitsOrThrow(DEFAULTS.rateLimitReset, false),
  rateLimitVerification: parseRouteLimitsOrThrow(DEFAULTS.rateLimitVerification, true),
  rateLimitPasswordChange: parseRouteLimitsOrThrow(DEFAULTS.rateLimitPasswordChange, true),
  passwordHashConcurrency: Number(DEFAULTS.passwordHashConcurrency),
  passwordHashQueue: Number(DEFAULTS.passwordHashQueue),
  passwordHashWaitMs: Number(DEFAULTS.passwordHashWaitMs),
  trustProxyHops: Number(DEFAULTS.trustProxyHops),
} as const satisfies Pick<AppConfig, 'rateLimitLogin' | 'rateLimitRegister' | 'rateLimitRecovery' | 'rateLimitReset' | 'rateLimitVerification' | 'rateLimitPasswordChange' | 'passwordHashConcurrency' | 'passwordHashQueue' | 'passwordHashWaitMs' | 'trustProxyHops'>;


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
  reviewWarnAfterHours: 'REVIEW_WARN_AFTER_HOURS',
  reviewEscalateAfterHours: 'REVIEW_ESCALATE_AFTER_HOURS',
  reviewLeaseHours: 'REVIEW_LEASE_HOURS',
  reviewSampleRate: 'REVIEW_SAMPLE_RATE',
  generationPrecheckConfig: 'GENERATION_PRECHECK_CONFIG',
  formPackageSigningKey: 'FORM_PACKAGE_SIGNING_KEY',
  timeOnItemIntervalCapMs: 'TIME_ON_ITEM_INTERVAL_CAP_MS',
  backgroundJobsEnabled: 'BACKGROUND_JOBS_ENABLED',
  maxSessionsPerUser: 'MAX_SESSIONS_PER_USER',
  rateLimitLogin: 'RATE_LIMIT_LOGIN',
  rateLimitRegister: 'RATE_LIMIT_REGISTER',
  rateLimitRecovery: 'RATE_LIMIT_RECOVERY',
  rateLimitReset: 'RATE_LIMIT_RESET',
  rateLimitVerification: 'RATE_LIMIT_VERIFICATION',
  rateLimitPasswordChange: 'RATE_LIMIT_PASSWORD_CHANGE',
  passwordHashConcurrency: 'PASSWORD_HASH_CONCURRENCY',
  passwordHashQueue: 'PASSWORD_HASH_QUEUE',
  passwordHashWaitMs: 'PASSWORD_HASH_WAIT_MS',
  trustProxyHops: 'TRUST_PROXY_HOPS',
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

/** A positive, finite hour count — the shape every one of `ReviewPolicy`'s four thresholds shares. */
function parsePositiveHours(
  env: Readonly<Record<string, string | undefined>>,
  key: 'reviewWarnAfterHours' | 'reviewEscalateAfterHours' | 'reviewLeaseHours',
  fallback: string,
): ConfigResult<number> {
  const raw = withDefault(env, key, fallback);
  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(value) || value <= 0) {
    return fail(key, `${ENV_VAR_NAMES[key]} must be a positive number of hours`);
  }
  return { ok: true, value };
}

function parseReviewWarnAfterHours(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  return parsePositiveHours(env, 'reviewWarnAfterHours', DEFAULTS.reviewWarnAfterHours);
}

/**
 * Individually valid is not enough: DEC-M4-1 states `warn` before `escalate`,
 * and a config that let the escalation threshold arrive before the warning
 * one would silently invert the two bands `domain/review/ageing.ts` computes.
 * Checked here, at config, rather than left for `createReviewPolicy` to catch
 * later — the same "fail first, fail close" discipline `parseAuditAnchorKey`
 * already applies to its own cross-field rule.
 */
function parseReviewEscalateAfterHours(
  env: Readonly<Record<string, string | undefined>>,
  warnAfterHours: number,
): ConfigResult<number> {
  const parsed = parsePositiveHours(env, 'reviewEscalateAfterHours', DEFAULTS.reviewEscalateAfterHours);
  if (!parsed.ok) return parsed;
  if (parsed.value < warnAfterHours) {
    return fail(
      'reviewEscalateAfterHours',
      `${ENV_VAR_NAMES['reviewEscalateAfterHours']} (${parsed.value}) must not be before ${ENV_VAR_NAMES['reviewWarnAfterHours']} (${warnAfterHours})`,
    );
  }
  return parsed;
}

function parseReviewLeaseHours(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  return parsePositiveHours(env, 'reviewLeaseHours', DEFAULTS.reviewLeaseHours);
}

function parseReviewSampleRate(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  const raw = withDefault(env, 'reviewSampleRate', DEFAULTS.reviewSampleRate);
  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isFinite(value) || value < 0 || value > 1) {
    return fail('reviewSampleRate', 'REVIEW_SAMPLE_RATE must be a number within [0, 1]');
  }
  return { ok: true, value };
}

function isPairing(value: unknown): value is PrecheckPairing {
  if (typeof value !== 'object' || value === null) return false;
  const pairing = value as Record<string, unknown>;
  return typeof pairing['modelVersionId'] === 'string' && typeof pairing['promptVersionId'] === 'string';
}

function parseGenerationPrecheckConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult<GenerationPrecheckConfig | undefined> {
  const raw = env[ENV_VAR_NAMES.generationPrecheckConfig];
  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: undefined };
  const message = `${ENV_VAR_NAMES.generationPrecheckConfig} must be a JSON object mapping each check id to { modelVersionId, promptVersionId }`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('generationPrecheckConfig', message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every(isPairing)) {
    return fail('generationPrecheckConfig', message);
  }
  return { ok: true, value: parsed as GenerationPrecheckConfig };
}

function parseTimeOnItemIntervalCapMs(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  const raw = withDefault(env, 'timeOnItemIntervalCapMs', DEFAULTS.timeOnItemIntervalCapMs);
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || !Number.isSafeInteger(Number(raw))) {
    return fail('timeOnItemIntervalCapMs', 'TIME_ON_ITEM_INTERVAL_CAP_MS must be a positive whole number of milliseconds');
  }
  return { ok: true, value: Number(raw) };
}

function parseMaxSessionsPerUser(env: Readonly<Record<string, string | undefined>>): ConfigResult<number> {
  const raw = withDefault(env, 'maxSessionsPerUser', DEFAULTS.maxSessionsPerUser);
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
    return fail('maxSessionsPerUser', 'MAX_SESSIONS_PER_USER must be a whole number from 1 to 50');
  }
  return { ok: true, value: Number(raw) };
}

function parseRouteLimitKey(env: Readonly<Record<string, string | undefined>>, key: ConfigKey, subject: boolean): ConfigResult<RouteLimits> {
  const parsed = parseRouteLimits(withDefault(env, key, DEFAULTS[key as keyof typeof DEFAULTS] as string), { subject });
  return parsed.ok ? { ok: true, value: parsed.value } : fail(key, `${ENV_VAR_NAMES[key]}: ${parsed.message}`);
}

function parseBoundedInteger(env: Readonly<Record<string, string | undefined>>, key: ConfigKey, low: number, high: number, what: string): ConfigResult<number> {
  const raw = withDefault(env, key, DEFAULTS[key as keyof typeof DEFAULTS] as string);
  if (!/^\d+$/u.test(raw) || Number(raw) < low || Number(raw) > high) {
    return fail(key, `${ENV_VAR_NAMES[key]} must be ${what}`);
  }
  return { ok: true, value: Number(raw) };
}

function parseBackgroundJobsEnabled(env: Readonly<Record<string, string | undefined>>): ConfigResult<boolean> {
  const raw = withDefault(env, 'backgroundJobsEnabled', DEFAULTS.backgroundJobsEnabled);
  if (raw !== 'true' && raw !== 'false') return fail('backgroundJobsEnabled', 'BACKGROUND_JOBS_ENABLED must be true or false');
  return { ok: true, value: raw === 'true' };
}

const SIGNING_SEED_BYTES = 32;

function parseFormPackageSigningKey(
  env: Readonly<Record<string, string | undefined>>,
  authSigningKey: string,
  auditAnchorKey: string,
): ConfigResult<string | undefined> {
  const raw = env[ENV_VAR_NAMES.formPackageSigningKey];
  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: undefined };
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(raw) || Buffer.from(raw, 'base64').length !== SIGNING_SEED_BYTES) {
    // Names the requirement, never the value.
    return fail('formPackageSigningKey', `${ENV_VAR_NAMES.formPackageSigningKey} must be ${SIGNING_SEED_BYTES} random bytes, base64-encoded`);
  }
  if (raw === authSigningKey || raw === auditAnchorKey) {
    return fail('formPackageSigningKey', `${ENV_VAR_NAMES.formPackageSigningKey} must not equal ${ENV_VAR_NAMES.authSigningKey} or ${ENV_VAR_NAMES.auditAnchorKey}`);
  }
  return { ok: true, value: raw };
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

  const reviewWarnAfterHours = parseReviewWarnAfterHours(env);
  if (!reviewWarnAfterHours.ok) return reviewWarnAfterHours;

  const reviewEscalateAfterHours = parseReviewEscalateAfterHours(env, reviewWarnAfterHours.value);
  if (!reviewEscalateAfterHours.ok) return reviewEscalateAfterHours;

  const reviewLeaseHours = parseReviewLeaseHours(env);
  if (!reviewLeaseHours.ok) return reviewLeaseHours;

  const reviewSampleRate = parseReviewSampleRate(env);
  if (!reviewSampleRate.ok) return reviewSampleRate;

  const generationPrecheckConfig = parseGenerationPrecheckConfig(env);
  if (!generationPrecheckConfig.ok) return generationPrecheckConfig;

  const formPackageSigningKey = parseFormPackageSigningKey(env, authSigningKey.value, auditAnchorKey.value);
  if (!formPackageSigningKey.ok) return formPackageSigningKey;

  const timeOnItemIntervalCapMs = parseTimeOnItemIntervalCapMs(env);
  if (!timeOnItemIntervalCapMs.ok) return timeOnItemIntervalCapMs;
  const maxSessionsPerUser = parseMaxSessionsPerUser(env);
  if (!maxSessionsPerUser.ok) return maxSessionsPerUser;

  const rateLimitLogin = parseRouteLimitKey(env, 'rateLimitLogin', true);
  if (!rateLimitLogin.ok) return rateLimitLogin;
  const rateLimitRegister = parseRouteLimitKey(env, 'rateLimitRegister', true);
  if (!rateLimitRegister.ok) return rateLimitRegister;
  const rateLimitRecovery = parseRouteLimitKey(env, 'rateLimitRecovery', true);
  if (!rateLimitRecovery.ok) return rateLimitRecovery;
  const rateLimitReset = parseRouteLimitKey(env, 'rateLimitReset', false);
  if (!rateLimitReset.ok) return rateLimitReset;
  const rateLimitVerification = parseRouteLimitKey(env, 'rateLimitVerification', true);
  if (!rateLimitVerification.ok) return rateLimitVerification;
  const rateLimitPasswordChange = parseRouteLimitKey(env, 'rateLimitPasswordChange', true);
  if (!rateLimitPasswordChange.ok) return rateLimitPasswordChange;
  const passwordHashConcurrency = parseBoundedInteger(env, 'passwordHashConcurrency', 1, 16, 'a whole number from 1 to 16');
  if (!passwordHashConcurrency.ok) return passwordHashConcurrency;
  const passwordHashQueue = parseBoundedInteger(env, 'passwordHashQueue', 0, 10_000, 'a whole number from 0 to 10000');
  if (!passwordHashQueue.ok) return passwordHashQueue;
  const passwordHashWaitMs = parseBoundedInteger(env, 'passwordHashWaitMs', 100, 120_000, 'a whole number of milliseconds from 100 to 120000');
  if (!passwordHashWaitMs.ok) return passwordHashWaitMs;
  const trustProxyHops = parseBoundedInteger(env, 'trustProxyHops', 0, 10, 'a whole number from 0 to 10');
  if (!trustProxyHops.ok) return trustProxyHops;

  const backgroundJobsEnabled = parseBackgroundJobsEnabled(env);
  if (!backgroundJobsEnabled.ok) return backgroundJobsEnabled;

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
      reviewWarnAfterHours: reviewWarnAfterHours.value,
      reviewEscalateAfterHours: reviewEscalateAfterHours.value,
      reviewLeaseHours: reviewLeaseHours.value,
      reviewSampleRate: reviewSampleRate.value,
      timeOnItemIntervalCapMs: timeOnItemIntervalCapMs.value,
      maxSessionsPerUser: maxSessionsPerUser.value,
      rateLimitLogin: rateLimitLogin.value,
      rateLimitRegister: rateLimitRegister.value,
      rateLimitRecovery: rateLimitRecovery.value,
      rateLimitReset: rateLimitReset.value,
      rateLimitVerification: rateLimitVerification.value,
      rateLimitPasswordChange: rateLimitPasswordChange.value,
      passwordHashConcurrency: passwordHashConcurrency.value,
      passwordHashQueue: passwordHashQueue.value,
      passwordHashWaitMs: passwordHashWaitMs.value,
      trustProxyHops: trustProxyHops.value,
      backgroundJobsEnabled: backgroundJobsEnabled.value,
      ...(generationPrecheckConfig.value === undefined ? {} : { generationPrecheckConfig: generationPrecheckConfig.value }),
      ...(formPackageSigningKey.value === undefined ? {} : { formPackageSigningKey: formPackageSigningKey.value }),
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
