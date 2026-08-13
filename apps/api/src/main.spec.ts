import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './main.js';

/**
 * Unit-speed: the one branch `main.ts` is allowed — a config error exits
 * non-zero with the error's own message — never reaches `createApplication`,
 * so this needs no database and no listening socket.
 */
const ENV_KEYS = ['DATABASE_URL', 'AUTH_SIGNING_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('main() — the config-error branch', () => {
  it('exits non-zero with the config error message on stderr, and never calls createApplication', async () => {
    delete process.env['DATABASE_URL'];
    delete process.env['AUTH_SIGNING_KEY'];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await main();

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL'));
    process.exitCode = 0;
  });
});
