import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';

const FIXED_NOW = new Date('2026-08-13T10:00:00.000Z');

function makeLogger(overrides: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    logLevel: 'info',
    nodeEnv: 'development',
    clock: () => FIXED_NOW,
    write: (line) => lines.push(line),
    ...overrides,
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

describe('createLogger — one JSON object per line, with the fixed envelope', () => {
  it('emits timestamp, level, message, correlationId and context', () => {
    const { logger, parsed } = makeLogger();
    logger.log({ level: 'info', message: 'item published', correlationId: 'corr-1', context: 'content' });
    expect(parsed()).toEqual([
      {
        timestamp: FIXED_NOW.toISOString(),
        level: 'info',
        message: 'item published',
        correlationId: 'corr-1',
        context: 'content',
      },
    ]);
  });

  it('merges an allowlisted attribute bag into the same object, and drops the rest', () => {
    const { logger, parsed } = makeLogger();
    logger.log({
      level: 'info',
      message: 'request handled',
      correlationId: 'corr-1',
      context: 'content',
      attributes: { route: '/v1/items', statusCode: 200, fullName: 'Jane Doe' },
    });
    const [record] = parsed();
    expect(record?.['route']).toBe('/v1/items');
    expect(record?.['statusCode']).toBe(200);
    expect(record?.['fullName']).toBeUndefined();
    expect(record?.['droppedKeys']).toEqual(['fullName']);
    expect(JSON.stringify(record)).not.toContain('Jane Doe');
  });
});

describe('createLogger — level filtering', () => {
  it('suppresses a level below the configured threshold', () => {
    const { logger, lines } = makeLogger({ logLevel: 'warn' });
    logger.log({ level: 'info', message: 'ignored', correlationId: 'corr-1', context: 'content' });
    expect(lines).toEqual([]);
  });

  it('emits a level at or above the configured threshold', () => {
    const { logger, lines } = makeLogger({ logLevel: 'warn' });
    logger.log({ level: 'error', message: 'kept', correlationId: 'corr-1', context: 'content' });
    expect(lines).toHaveLength(1);
  });

  it('debug is off in production regardless of the configured level', () => {
    const { logger, lines } = makeLogger({ logLevel: 'debug', nodeEnv: 'production' });
    logger.log({ level: 'debug', message: 'ignored in prod', correlationId: 'corr-1', context: 'content' });
    expect(lines).toEqual([]);
  });

  it('debug is emitted outside production when the threshold allows it', () => {
    const { logger, lines } = makeLogger({ logLevel: 'debug', nodeEnv: 'development' });
    logger.log({ level: 'debug', message: 'kept in dev', correlationId: 'corr-1', context: 'content' });
    expect(lines).toHaveLength(1);
  });
});

describe('createLogger — error logging (§7)', () => {
  it('always logs the error message and code', () => {
    const { logger, parsed } = makeLogger();
    const error = Object.assign(new Error('constraint violated'), { code: 'PERSISTENCE_REJECTED' });
    logger.log({ level: 'error', message: 'save failed', correlationId: 'corr-1', context: 'content', error });
    const [record] = parsed();
    expect(record?.['errorMessage']).toBe('constraint violated');
    expect(record?.['errorCode']).toBe('PERSISTENCE_REJECTED');
  });

  it('includes the stack outside production', () => {
    const { logger, parsed } = makeLogger({ nodeEnv: 'development' });
    const error = new Error('boom');
    logger.log({ level: 'error', message: 'failed', correlationId: 'corr-1', context: 'content', error });
    const [record] = parsed();
    expect(typeof record?.['errorStack']).toBe('string');
  });

  it('omits the stack in production, keeping message and code', () => {
    const { logger, parsed } = makeLogger({ nodeEnv: 'production' });
    const error = Object.assign(new Error('boom'), { code: 'E_BOOM' });
    logger.log({ level: 'error', message: 'failed', correlationId: 'corr-1', context: 'content', error });
    const [record] = parsed();
    expect(record?.['errorStack']).toBeUndefined();
    expect(record?.['errorMessage']).toBe('boom');
    expect(record?.['errorCode']).toBe('E_BOOM');
  });

  it('omits errorCode when the error carries none', () => {
    const { logger, parsed } = makeLogger();
    logger.log({ level: 'error', message: 'failed', correlationId: 'corr-1', context: 'content', error: new Error('boom') });
    const [record] = parsed();
    expect(record?.['errorCode']).toBeUndefined();
  });
});

describe('createLogger — real defaults', () => {
  it('writes to stdout and reads the clock when neither is overridden', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' });
      logger.log({ level: 'info', message: 'default path', correlationId: 'corr-1', context: 'content' });
      expect(writeSpy).toHaveBeenCalledOnce();
      const written = writeSpy.mock.calls[0]?.[0];
      expect(typeof written).toBe('string');
      expect(JSON.parse((written as string).trim())).toMatchObject({ message: 'default path' });
    } finally {
      writeSpy.mockRestore();
    }
  });
});
