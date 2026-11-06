import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ABUSE_LIMITS, DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS, loadConfig, loadConfigFromProcessEnv, parseRouteLimitsOrThrow } from './config.js';

const VALID_KEY = 'a'.repeat(32);
/** Distinct from VALID_KEY on purpose: config refuses the two being equal (M4-24, ADR-0020). */
const VALID_ANCHOR_KEY = 'an-audit-anchor-key-of-32-plus-bytes';

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/questionbank',
    PORT: '3000',
    NODE_ENV: 'development',
    AUTH_SIGNING_KEY: VALID_KEY,
    AUDIT_ANCHOR_KEY: VALID_ANCHOR_KEY,
    AUTH_ISSUER: 'questionbank',
    AUTH_TOKEN_TTL_SECONDS: '3600',
    MEDIA_STORAGE_ROOT: './var/media',
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

describe('loadConfig — every key loads', () => {
  it('loads a fully-specified valid environment', () => {
    const result = loadConfig(validEnv());
    expect(result).toEqual({
      ok: true,
      value: {
        databaseUrl: 'postgres://postgres@127.0.0.1:5432/questionbank',
        port: 3000,
        nodeEnv: 'development',
        authSigningKey: VALID_KEY,
        auditAnchorKey: VALID_ANCHOR_KEY,
        authIssuer: 'questionbank',
        authTokenTtlSeconds: 3600,
        mediaStorageRoot: './var/media',
        logLevel: 'info',
        reviewWarnAfterHours: 48,
        reviewEscalateAfterHours: 72,
        reviewLeaseHours: 4,
        reviewSampleRate: 0.05,
        timeOnItemIntervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
        maxSessionsPerUser: 5,
        ...DEFAULT_ABUSE_LIMITS,
        backgroundJobsEnabled: true,
      },
    });
  });

  it('applies documented defaults for every key but the signing key and the database URL', () => {
    const result = loadConfig({
      DATABASE_URL: validEnv().DATABASE_URL,
      AUTH_SIGNING_KEY: VALID_KEY,
      AUDIT_ANCHOR_KEY: VALID_ANCHOR_KEY,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        databaseUrl: 'postgres://postgres@127.0.0.1:5432/questionbank',
        port: 3000,
        nodeEnv: 'development',
        authSigningKey: VALID_KEY,
        auditAnchorKey: VALID_ANCHOR_KEY,
        authIssuer: 'questionbank',
        authTokenTtlSeconds: 3600,
        mediaStorageRoot: './var/media',
        logLevel: 'info',
        reviewWarnAfterHours: 48,
        reviewEscalateAfterHours: 72,
        reviewLeaseHours: 4,
        reviewSampleRate: 0.05,
        timeOnItemIntervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
        maxSessionsPerUser: 5,
        ...DEFAULT_ABUSE_LIMITS,
        backgroundJobsEnabled: true,
      },
    });
  });
});

describe('loadConfig — is total, never throws, and returns rather than throws', () => {
  it('returns an error result for a completely empty environment rather than throwing', () => {
    expect(() => loadConfig({})).not.toThrow();
    const result = loadConfig({});
    expect(result.ok).toBe(false);
  });
});

describe('loadConfig — the signing key has no default and its message carries no value', () => {
  it('is an error when unset, naming the key', () => {
    const result = loadConfig(validEnv({ AUTH_SIGNING_KEY: undefined }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'authSigningKey', message: 'AUTH_SIGNING_KEY is required and was not set' },
    });
  });

  it('the missing-key error message contains no signing key value', () => {
    const result = loadConfig(validEnv({ AUTH_SIGNING_KEY: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(VALID_KEY);
    }
  });

  it('rejects a signing key under 32 bytes, and the message contains no value', () => {
    const result = loadConfig(validEnv({ AUTH_SIGNING_KEY: 'too-short' }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'authSigningKey', message: 'AUTH_SIGNING_KEY must be at least 32 bytes' },
    });
    if (!result.ok) {
      expect(result.error.message).not.toContain('too-short');
    }
  });

  it('accepts a signing key at exactly the 32-byte boundary', () => {
    const result = loadConfig(validEnv({ AUTH_SIGNING_KEY: 'b'.repeat(32) }));
    expect(result.ok).toBe(true);
  });
});

describe('loadConfig — nodeEnv is a closed union, never coerced', () => {
  it('rejects an unrecognised value rather than coercing to development', () => {
    const result = loadConfig(validEnv({ NODE_ENV: 'staging' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.key).toBe('nodeEnv');
      expect(result.error.message).toContain('unrecognised');
    }
  });

  it('accepts each of the three declared environments', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      const result = loadConfig(validEnv({ NODE_ENV: nodeEnv }));
      expect(result.ok).toBe(true);
    }
  });

  it('defaults to development when NODE_ENV is unset', () => {
    const result = loadConfig(validEnv({ NODE_ENV: undefined }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nodeEnv).toBe('development');
  });
});

describe('loadConfig — every key validates individually', () => {
  it('requires DATABASE_URL', () => {
    const result = loadConfig(validEnv({ DATABASE_URL: undefined }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'databaseUrl', message: 'DATABASE_URL is required and was not set' },
    });
  });

  it('rejects a DATABASE_URL that is not a URL', () => {
    const result = loadConfig(validEnv({ DATABASE_URL: 'not-a-url' }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'databaseUrl', message: 'DATABASE_URL is not a valid URL' },
    });
  });

  it('rejects a non-numeric PORT', () => {
    const result = loadConfig(validEnv({ PORT: 'abc' }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'port', message: 'PORT must be a positive integer' },
    });
  });

  it('rejects a PORT out of range on both sides', () => {
    expect(loadConfig(validEnv({ PORT: '0' }))).toEqual({
      ok: false,
      error: { key: 'port', message: 'PORT must be between 1 and 65535' },
    });
    expect(loadConfig(validEnv({ PORT: '70000' }))).toEqual({
      ok: false,
      error: { key: 'port', message: 'PORT must be between 1 and 65535' },
    });
  });

  it('rejects a blank AUTH_ISSUER', () => {
    const result = loadConfig(validEnv({ AUTH_ISSUER: '   ' }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'authIssuer', message: 'AUTH_ISSUER must not be blank' },
    });
  });

  it('rejects a non-positive AUTH_TOKEN_TTL_SECONDS', () => {
    expect(loadConfig(validEnv({ AUTH_TOKEN_TTL_SECONDS: '0' }))).toEqual({
      ok: false,
      error: { key: 'authTokenTtlSeconds', message: 'AUTH_TOKEN_TTL_SECONDS must be a positive integer' },
    });
    expect(loadConfig(validEnv({ AUTH_TOKEN_TTL_SECONDS: 'nope' }))).toEqual({
      ok: false,
      error: { key: 'authTokenTtlSeconds', message: 'AUTH_TOKEN_TTL_SECONDS must be a positive integer' },
    });
  });

  it('an unset MEDIA_STORAGE_ROOT falls back to its default rather than erroring', () => {
    expect(loadConfig(validEnv({ MEDIA_STORAGE_ROOT: '' })).ok).toBe(true);
  });

  it('rejects a whitespace-only MEDIA_STORAGE_ROOT', () => {
    expect(loadConfig(validEnv({ MEDIA_STORAGE_ROOT: '   ' }))).toEqual({
      ok: false,
      error: { key: 'mediaStorageRoot', message: 'MEDIA_STORAGE_ROOT must not be blank' },
    });
  });

  it('rejects an unrecognised LOG_LEVEL', () => {
    const result = loadConfig(validEnv({ LOG_LEVEL: 'trace' }));
    expect(result).toEqual({
      ok: false,
      error: { key: 'logLevel', message: 'LOG_LEVEL must be one of debug, info, warn, error — got an unrecognised value' },
    });
  });

  it('accepts each of the four declared log levels', () => {
    for (const logLevel of ['debug', 'info', 'warn', 'error']) {
      const result = loadConfig(validEnv({ LOG_LEVEL: logLevel }));
      expect(result.ok).toBe(true);
    }
  });
});

describe('loadConfig — ReviewPolicy’s four thresholds (M4-26, DEC-M4-1)', () => {
  it('defaults to DEC-M4-1’s own numbers when unset', () => {
    const result = loadConfig(
      validEnv({
        REVIEW_WARN_AFTER_HOURS: undefined,
        REVIEW_ESCALATE_AFTER_HOURS: undefined,
        REVIEW_LEASE_HOURS: undefined,
        REVIEW_SAMPLE_RATE: undefined,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewWarnAfterHours).toBe(48);
    expect(result.value.reviewEscalateAfterHours).toBe(72);
    expect(result.value.reviewLeaseHours).toBe(4);
    expect(result.value.reviewSampleRate).toBe(0.05);
  });

  it('rejects a non-numeric REVIEW_WARN_AFTER_HOURS', () => {
    expect(loadConfig(validEnv({ REVIEW_WARN_AFTER_HOURS: 'soon' }))).toEqual({
      ok: false,
      error: { key: 'reviewWarnAfterHours', message: 'REVIEW_WARN_AFTER_HOURS must be a positive number of hours' },
    });
  });

  it('rejects a zero or negative REVIEW_WARN_AFTER_HOURS', () => {
    expect(loadConfig(validEnv({ REVIEW_WARN_AFTER_HOURS: '0' })).ok).toBe(false);
    expect(loadConfig(validEnv({ REVIEW_WARN_AFTER_HOURS: '-1' })).ok).toBe(false);
  });

  it('rejects a non-numeric REVIEW_ESCALATE_AFTER_HOURS', () => {
    expect(loadConfig(validEnv({ REVIEW_ESCALATE_AFTER_HOURS: 'late' }))).toEqual({
      ok: false,
      error: {
        key: 'reviewEscalateAfterHours',
        message: 'REVIEW_ESCALATE_AFTER_HOURS must be a positive number of hours',
      },
    });
  });

  it('rejects REVIEW_ESCALATE_AFTER_HOURS before REVIEW_WARN_AFTER_HOURS', () => {
    const result = loadConfig(validEnv({ REVIEW_WARN_AFTER_HOURS: '72', REVIEW_ESCALATE_AFTER_HOURS: '48' }));
    expect(result).toEqual({
      ok: false,
      error: {
        key: 'reviewEscalateAfterHours',
        message: 'REVIEW_ESCALATE_AFTER_HOURS (48) must not be before REVIEW_WARN_AFTER_HOURS (72)',
      },
    });
  });

  it('accepts REVIEW_ESCALATE_AFTER_HOURS exactly equal to REVIEW_WARN_AFTER_HOURS', () => {
    const result = loadConfig(validEnv({ REVIEW_WARN_AFTER_HOURS: '48', REVIEW_ESCALATE_AFTER_HOURS: '48' }));
    expect(result.ok).toBe(true);
  });

  it('rejects a non-numeric REVIEW_LEASE_HOURS', () => {
    expect(loadConfig(validEnv({ REVIEW_LEASE_HOURS: 'nope' }))).toEqual({
      ok: false,
      error: { key: 'reviewLeaseHours', message: 'REVIEW_LEASE_HOURS must be a positive number of hours' },
    });
  });

  it('rejects a zero or negative REVIEW_LEASE_HOURS', () => {
    expect(loadConfig(validEnv({ REVIEW_LEASE_HOURS: '0' })).ok).toBe(false);
    expect(loadConfig(validEnv({ REVIEW_LEASE_HOURS: '-4' })).ok).toBe(false);
  });

  it('rejects a non-numeric REVIEW_SAMPLE_RATE', () => {
    expect(loadConfig(validEnv({ REVIEW_SAMPLE_RATE: 'five-percent' }))).toEqual({
      ok: false,
      error: { key: 'reviewSampleRate', message: 'REVIEW_SAMPLE_RATE must be a number within [0, 1]' },
    });
  });

  it('rejects a REVIEW_SAMPLE_RATE outside [0, 1] on both sides', () => {
    expect(loadConfig(validEnv({ REVIEW_SAMPLE_RATE: '-0.01' })).ok).toBe(false);
    expect(loadConfig(validEnv({ REVIEW_SAMPLE_RATE: '1.01' })).ok).toBe(false);
  });

  it('accepts REVIEW_SAMPLE_RATE at both boundaries, 0 and 1', () => {
    expect(loadConfig(validEnv({ REVIEW_SAMPLE_RATE: '0' })).ok).toBe(true);
    expect(loadConfig(validEnv({ REVIEW_SAMPLE_RATE: '1' })).ok).toBe(true);
  });
});

describe('loadConfigFromProcessEnv — the one call site that reads process.env (F16)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, validEnv());
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('loads from the real process.env', () => {
    const result = loadConfigFromProcessEnv();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.authSigningKey).toBe(VALID_KEY);
  });

  it('reports the same error loadConfig would for a missing required key', () => {
    delete process.env['AUTH_SIGNING_KEY'];
    const result = loadConfigFromProcessEnv();
    expect(result).toEqual({
      ok: false,
      error: { key: 'authSigningKey', message: 'AUTH_SIGNING_KEY is required and was not set' },
    });
  });
});

describe('loadConfig — the optional pre-check configuration (M5-37)', () => {
  const PAIRING = { modelVersionId: 'm', promptVersionId: 'p' };
  const MESSAGE =
    'GENERATION_PRECHECK_CONFIG must be a JSON object mapping each check id to { modelVersionId, promptVersionId }';
  const refused = { ok: false, error: { key: 'generationPrecheckConfig', message: MESSAGE } };

  it('is absent from the config when the deployment did not set it, rather than present and empty', () => {
    for (const env of [validEnv(), validEnv({ GENERATION_PRECHECK_CONFIG: '' }), validEnv({ GENERATION_PRECHECK_CONFIG: '  ' })]) {
      const result = loadConfig(env);
      expect(result.ok).toBe(true);
      if (result.ok) expect('generationPrecheckConfig' in result.value).toBe(false);
    }
  });

  it('carries the mapping through unchanged when it is well-formed', () => {
    const result = loadConfig(validEnv({ GENERATION_PRECHECK_CONFIG: JSON.stringify({ answer_verification: PAIRING, syllabus_scope: PAIRING }) }));
    expect(result.ok && result.value.generationPrecheckConfig).toEqual({ answer_verification: PAIRING, syllabus_scope: PAIRING });
  });

  it('refuses what is not JSON', () => {
    expect(loadConfig(validEnv({ GENERATION_PRECHECK_CONFIG: '{not json' }))).toEqual(refused);
  });

  it('refuses JSON that is not an object of pairings: null, a number, an array, a pairing missing a field, a pairing of the wrong type', () => {
    for (const raw of ['null', '7', '[]', '{"a":null}', '{"a":{"modelVersionId":"m"}}', '{"a":{"modelVersionId":"m","promptVersionId":5}}', '{"a":3}']) {
      expect(loadConfig(validEnv({ GENERATION_PRECHECK_CONFIG: raw })), raw).toEqual(refused);
    }
  });
});

describe('loadConfig — the form package signing key (M6-26)', () => {
  const SEED = Buffer.alloc(32, 9).toString('base64');
  const MESSAGE = 'FORM_PACKAGE_SIGNING_KEY must be 32 random bytes, base64-encoded';

  it('is absent unless supplied, and an unset or blank value is no key', () => {
    for (const env of [validEnv(), validEnv({ FORM_PACKAGE_SIGNING_KEY: '' }), validEnv({ FORM_PACKAGE_SIGNING_KEY: '  ' })]) {
      const result = loadConfig(env);
      expect(result.ok).toBe(true);
      if (result.ok) expect('formPackageSigningKey' in result.value).toBe(false);
    }
  });

  it('carries a 32-byte base64 seed through', () => {
    const result = loadConfig(validEnv({ FORM_PACKAGE_SIGNING_KEY: SEED }));
    expect(result.ok && result.value.formPackageSigningKey).toBe(SEED);
  });

  it('refuses a value that is not 32 bytes of base64, without echoing it', () => {
    for (const bad of ['not base64 !!', Buffer.alloc(31, 1).toString('base64'), Buffer.alloc(33, 1).toString('base64'), 'a'.repeat(32)]) {
      const result = loadConfig(validEnv({ FORM_PACKAGE_SIGNING_KEY: bad }));
      expect(result, bad).toEqual({ ok: false, error: { key: 'formPackageSigningKey', message: MESSAGE } });
    }
  });

  it('refuses a key that is the auth key or the audit key: one key wearing a second name', () => {
    const seedAsAuth = Buffer.alloc(32, 3).toString('base64');
    expect(loadConfig(validEnv({ AUTH_SIGNING_KEY: seedAsAuth, FORM_PACKAGE_SIGNING_KEY: seedAsAuth }))).toEqual({
      ok: false,
      error: { key: 'formPackageSigningKey', message: 'FORM_PACKAGE_SIGNING_KEY must not equal AUTH_SIGNING_KEY or AUDIT_ANCHOR_KEY' },
    });
    expect(loadConfig(validEnv({ AUDIT_ANCHOR_KEY: seedAsAuth, FORM_PACKAGE_SIGNING_KEY: seedAsAuth })).ok).toBe(false);
  });
});

describe('loadConfig — the most live sessions a user may hold (M8-03)', () => {
  it('defaults to five, and an unset or blank variable is the default', () => {
    for (const env of [validEnv(), validEnv({ MAX_SESSIONS_PER_USER: '' })]) {
      const result = loadConfig(env);
      expect(result.ok && result.value.maxSessionsPerUser).toBe(5);
    }
  });

  it('takes a whole number from 1 to 50', () => {
    for (const good of ['1', '3', '50']) expect(loadConfig(validEnv({ MAX_SESSIONS_PER_USER: good })).ok && (loadConfig(validEnv({ MAX_SESSIONS_PER_USER: good })) as { value: { maxSessionsPerUser: number } }).value.maxSessionsPerUser).toBe(Number(good));
  });

  it('fails loudly on zero, a fraction, a negative, text, and a number past the cap', () => {
    for (const bad of ['0', '1.5', '-1', 'many', '51']) {
      expect(loadConfig(validEnv({ MAX_SESSIONS_PER_USER: bad })), bad).toEqual({ ok: false, error: { key: 'maxSessionsPerUser', message: 'MAX_SESSIONS_PER_USER must be a whole number from 1 to 50' } });
    }
  });
});

describe('loadConfig — the time-on-item interval cap (M6-37)', () => {
  it('defaults to the one exported value, and an unset or blank variable is the default', () => {
    for (const env of [validEnv(), validEnv({ TIME_ON_ITEM_INTERVAL_CAP_MS: '' })]) {
      const result = loadConfig(env);
      expect(result.ok && result.value.timeOnItemIntervalCapMs).toBe(DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS);
    }
  });

  it('takes a positive whole number of milliseconds', () => {
    const result = loadConfig(validEnv({ TIME_ON_ITEM_INTERVAL_CAP_MS: '45000' }));
    expect(result.ok && result.value.timeOnItemIntervalCapMs).toBe(45_000);
  });

  it('refuses zero, a fraction, a negative, text, and a number too large to be exact', () => {
    for (const bad of ['0', '1.5', '-5', 'two minutes', '99999999999999999999']) {
      expect(loadConfig(validEnv({ TIME_ON_ITEM_INTERVAL_CAP_MS: bad })), bad).toEqual({
        ok: false,
        error: { key: 'timeOnItemIntervalCapMs', message: 'TIME_ON_ITEM_INTERVAL_CAP_MS must be a positive whole number of milliseconds' },
      });
    }
  });
});

describe('loadConfig — whether this process runs the background jobs (M6-42)', () => {
  it('is on unless said otherwise, and takes true or false', () => {
    expect(loadConfig(validEnv())).toMatchObject({ ok: true, value: { backgroundJobsEnabled: true } });
    expect(loadConfig(validEnv({ BACKGROUND_JOBS_ENABLED: '' }))).toMatchObject({ ok: true, value: { backgroundJobsEnabled: true } });
    expect(loadConfig(validEnv({ BACKGROUND_JOBS_ENABLED: 'false' }))).toMatchObject({ ok: true, value: { backgroundJobsEnabled: false } });
    expect(loadConfig(validEnv({ BACKGROUND_JOBS_ENABLED: 'true' }))).toMatchObject({ ok: true, value: { backgroundJobsEnabled: true } });
  });

  it('refuses anything else, rather than guess', () => {
    for (const bad of ['yes', '1', 'FALSE', 'off']) {
      expect(loadConfig(validEnv({ BACKGROUND_JOBS_ENABLED: bad })), bad).toEqual({
        ok: false,
        error: { key: 'backgroundJobsEnabled', message: 'BACKGROUND_JOBS_ENABLED must be true or false' },
      });
    }
  });
});

describe('loadConfig — what the authentication routes allow, and how much hashing runs at once (M8-06, M8-07, M8-08)', () => {
  const ROUTES = [
    ['RATE_LIMIT_LOGIN', 'rateLimitLogin', true],
    ['RATE_LIMIT_REGISTER', 'rateLimitRegister', true],
    ['RATE_LIMIT_RECOVERY', 'rateLimitRecovery', true],
    ['RATE_LIMIT_RESET', 'rateLimitReset', false],
    ['RATE_LIMIT_VERIFICATION', 'rateLimitVerification', true],
    ['RATE_LIMIT_PASSWORD_CHANGE', 'rateLimitPasswordChange', true],
    ['RATE_LIMIT_PROFILE', 'rateLimitProfile', true],
    ['RATE_LIMIT_LEARNING', 'rateLimitLearning', true],
    ['RATE_LIMIT_EVENTS', 'rateLimitEvents', true],
    ['RATE_LIMIT_ATTEMPTS', 'rateLimitAttempts', true],
  ] as const;

  it('has a default for every one of them, the ones tests are built from', () => {
    const result = loadConfig(validEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [, key] of ROUTES) expect(result.value[key]).toEqual(DEFAULT_ABUSE_LIMITS[key]);
    expect(result.value.rateLimitLogin.source.tiers).toEqual([{ max: 100, windowMs: 10_000 }, { max: 1000, windowMs: 3_600_000 }]);
    expect(result.value.rateLimitLogin.subject?.tiers).toEqual([{ max: 5, windowMs: 60_000 }, { max: 30, windowMs: 900_000 }]);
    expect(result.value.rateLimitReset.subject).toBeNull();
    expect([result.value.passwordHashConcurrency, result.value.passwordHashQueue, result.value.passwordHashWaitMs, result.value.trustProxyHops]).toEqual([2, 256, 15_000, 0]);
  });

  // DEC-M8-35's classroom: 100 learners behind one address. A learner reads about 6 times a minute (opening home is about 5 reads, browsing about 6 a minute) and the app sends the answers of an
  // open run about 3 batches a minute. An address is an aggregate of a hundred people whose idle gaps interleave, so its sustained rate is the classroom's own, not one person's duty cycle.
  const CLASSROOM_LEARNERS = 100;
  const READS_PER_LEARNER_PER_MINUTE = 6;
  const EVENT_BATCHES_PER_LEARNER_PER_MINUTE = 3;
  const CLASSROOM_PER_MINUTE = {
    rateLimitLearning: CLASSROOM_LEARNERS * READS_PER_LEARNER_PER_MINUTE,
    rateLimitAttempts: CLASSROOM_LEARNERS * READS_PER_LEARNER_PER_MINUTE,
    rateLimitEvents: CLASSROOM_LEARNERS * EVENT_BATCHES_PER_LEARNER_PER_MINUTE,
  } as const;

  it("holds a source's sustained tier to the classroom rate the entry states, and below what the burst tier would allow for an hour (DEC-M8-35)", () => {
    for (const key of Object.keys(CLASSROOM_PER_MINUTE) as (keyof typeof CLASSROOM_PER_MINUTE)[]) {
      const tiers = [...DEFAULT_ABUSE_LIMITS[key].source.tiers].sort((a, b) => a.windowMs - b.windowMs);
      const burst = tiers[0]!;
      const sustained = tiers.at(-1)!;
      expect(sustained.windowMs, `${key} has an hourly source tier`).toBe(3_600_000);
      const sustainedPerMinute = sustained.max / (sustained.windowMs / 60_000);
      const burstPerMinute = burst.max / (burst.windowMs / 60_000);
      expect(sustainedPerMinute, `${key}: the sustained source tier, a minute at a time`).toBeGreaterThanOrEqual(CLASSROOM_PER_MINUTE[key]);
      expect(sustainedPerMinute, `${key}: still a constraint under the burst tier`).toBeLessThan(burstPerMinute);
    }
  });

  it('takes a policy from the environment, and a blank variable is the default', () => {
    for (const [variable, key] of ROUTES) {
      const taken = loadConfig(validEnv({ [variable]: 'source=7/1m' }));
      expect(taken.ok && taken.value[key].source.tiers).toEqual([{ max: 7, windowMs: 60_000 }]);
      const blank = loadConfig(validEnv({ [variable]: '' }));
      expect(blank.ok && blank.value[key]).toEqual(DEFAULT_ABUSE_LIMITS[key]);
    }
  });

  it('fails loudly on a policy that does not parse, naming the variable and what is wrong', () => {
    for (const [variable, key] of ROUTES) {
      expect(loadConfig(validEnv({ [variable]: 'source=lots' })), variable).toEqual({ ok: false, error: { key, message: `${variable}: source: "lots" is not hits/window, such as 5/1m` } });
    }
  });

  it('refuses a subject for the route that has nobody to name', () => {
    expect(loadConfig(validEnv({ RATE_LIMIT_RESET: 'source=5/1m;subject=5/1m' }))).toEqual({ ok: false, error: { key: 'rateLimitReset', message: 'RATE_LIMIT_RESET: this route has no subject to limit' } });
  });

  it.each([
    ['PASSWORD_HASH_CONCURRENCY', 'passwordHashConcurrency', ['1', '16'], ['0', '17', '1.5', 'many'], 'a whole number from 1 to 16'],
    ['PASSWORD_HASH_QUEUE', 'passwordHashQueue', ['0', '10000'], ['-1', '10001', 'x'], 'a whole number from 0 to 10000'],
    ['PASSWORD_HASH_WAIT_MS', 'passwordHashWaitMs', ['100', '120000'], ['99', '120001', '1s'], 'a whole number of milliseconds from 100 to 120000'],
    ['TRUST_PROXY_HOPS', 'trustProxyHops', ['0', '10'], ['-1', '11', 'one'], 'a whole number from 0 to 10'],
  ] as const)('takes %s in its range and fails loudly outside it', (variable, key, good, bad, what) => {
    for (const value of good) {
      const result = loadConfig(validEnv({ [variable]: value }));
      expect(result.ok && result.value[key], value).toBe(Number(value));
    }
    for (const value of bad) expect(loadConfig(validEnv({ [variable]: value })), value).toEqual({ ok: false, error: { key, message: `${variable} must be ${what}` } });
  });

  it('has defaults that are themselves checked: a built-in policy that does not parse is a failure at load, naming it', () => {
    expect(parseRouteLimitsOrThrow('source=5/1m', true).source.tiers).toEqual([{ max: 5, windowMs: 60_000 }]);
    expect(() => parseRouteLimitsOrThrow('source=lots', true)).toThrow('built-in rate limit "source=lots" does not parse: source: "lots" is not hits/window, such as 5/1m');
  });
});

describe('mail through SES and the app address (M8-41)', () => {
  const SES = { MAIL_SES_REGION: 'eu-west-1', MAIL_SENDER: 'no-reply@mail.example.org', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE0000000', AWS_SECRET_ACCESS_KEY: 'a-secret-that-is-not-one-0000000000' };

  it('is absent when none of it is set, and all of it is read when all is', () => {
    const none = loadConfig(validEnv());
    expect(none.ok && 'mailSes' in none.value).toBe(false);
    expect(none.ok && 'publicUrl' in none.value).toBe(false);
    const all = loadConfig(validEnv({ ...SES, PUBLIC_URL: 'https://learn.example.org' }));
    expect(all.ok && all.value.mailSes).toEqual({ region: 'eu-west-1', sender: 'no-reply@mail.example.org', accessKeyId: 'AKIDEXAMPLE0000000', secretAccessKey: SES.AWS_SECRET_ACCESS_KEY });
    expect(all.ok && all.value.publicUrl).toBe('https://learn.example.org');
  });

  it('refuses to start with some of the four and names the ones missing, not the values present', () => {
    for (const lacking of Object.keys(SES) as (keyof typeof SES)[]) {
      const { [lacking]: _gone, ...rest } = SES;
      const result = loadConfig(validEnv(rest));
      expect(result.ok, lacking).toBe(false);
      if (!result.ok) {
        expect(result.error.message, lacking).toContain(`missing ${lacking}`);
        expect(result.error.message, lacking).not.toContain(SES.AWS_SECRET_ACCESS_KEY);
        expect(result.error.message, lacking).not.toContain(SES.AWS_ACCESS_KEY_ID);
      }
    }
    expect(loadConfig(validEnv({ ...SES, AWS_SECRET_ACCESS_KEY: '  ' }))).toMatchObject({ ok: false, error: { key: 'mailSecretAccessKey' } });
  });

  it('refuses a region, a sender and a key id that are not shaped like the thing', () => {
    expect(loadConfig(validEnv({ ...SES, MAIL_SES_REGION: 'europe' }))).toMatchObject({ ok: false, error: { key: 'mailSesRegion' } });
    expect(loadConfig(validEnv({ ...SES, MAIL_SENDER: 'Asha <a@b.example>' }))).toMatchObject({ ok: false, error: { key: 'mailSender' } });
    expect(loadConfig(validEnv({ ...SES, MAIL_SENDER: 'not-an-address' }))).toMatchObject({ ok: false, error: { key: 'mailSender' } });
    expect(loadConfig(validEnv({ ...SES, AWS_ACCESS_KEY_ID: 'short' }))).toMatchObject({ ok: false, error: { key: 'mailAccessKeyId' } });
  });

  it('takes the app address as an origin and refuses anything with more in it', () => {
    expect(loadConfig(validEnv({ PUBLIC_URL: 'http://localhost:8080/' }))).toMatchObject({ ok: true, value: { publicUrl: 'http://localhost:8080' } });
    for (const bad of ['learn.example.org', 'ftp://x.example', 'https://x.example/app', 'https://x.example/?a=1', 'https://u:p@x.example', 'https://x.example/#f']) {
      expect(loadConfig(validEnv({ PUBLIC_URL: bad })), bad).toMatchObject({ ok: false, error: { key: 'publicUrl' } });
    }
  });
});
