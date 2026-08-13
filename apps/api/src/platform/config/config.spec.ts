import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, loadConfigFromProcessEnv } from './config.js';

const VALID_KEY = 'a'.repeat(32);

function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/questionbank',
    PORT: '3000',
    NODE_ENV: 'development',
    AUTH_SIGNING_KEY: VALID_KEY,
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
        authIssuer: 'questionbank',
        authTokenTtlSeconds: 3600,
        mediaStorageRoot: './var/media',
        logLevel: 'info',
      },
    });
  });

  it('applies documented defaults for every key but the signing key and the database URL', () => {
    const result = loadConfig({ DATABASE_URL: validEnv().DATABASE_URL, AUTH_SIGNING_KEY: VALID_KEY });
    expect(result).toEqual({
      ok: true,
      value: {
        databaseUrl: 'postgres://postgres@127.0.0.1:5432/questionbank',
        port: 3000,
        nodeEnv: 'development',
        authSigningKey: VALID_KEY,
        authIssuer: 'questionbank',
        authTokenTtlSeconds: 3600,
        mediaStorageRoot: './var/media',
        logLevel: 'info',
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
