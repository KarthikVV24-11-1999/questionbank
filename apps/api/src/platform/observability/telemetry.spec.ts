import { describe, expect, it, vi } from 'vitest';
import { createJsonTelemetry, createTelemetry } from './telemetry.js';
import { createRecordingTelemetry } from './recording-telemetry.js';
import { tsFilesUnder, readCode } from '../../fitness/source-scan.js';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Telemetry — a span cannot be started without a correlation id', () => {
  it('refuses a missing correlationId', () => {
    const telemetry = createRecordingTelemetry();
    // @ts-expect-error deliberately omitting the required field
    expect(() => telemetry.startSpan('route', {})).toThrow(/correlationId/);
  });

  it('refuses a blank correlationId', () => {
    const telemetry = createRecordingTelemetry();
    expect(() => telemetry.startSpan('route', { correlationId: '' })).toThrow(/correlationId/);
  });

  it('accepts a real correlation id and uses it as the trace id', () => {
    const telemetry = createRecordingTelemetry();
    const span = telemetry.startSpan('route', { correlationId: 'corr-1' });
    expect(span.traceId).toBe('corr-1');
    span.end();
  });
});

describe('Telemetry — span tree shape via withSpan', () => {
  it('produces one root span and nested children carrying the same trace id', async () => {
    const telemetry = createRecordingTelemetry();
    await telemetry.withSpan('http request', { correlationId: 'corr-1', route: '/v1/items' }, async (root) => {
      await telemetry.withSpan('handler', { correlationId: 'corr-1', handlerName: 'listItems' }, async (child) => {
        expect(child.parentSpanId).toBe(root.spanId);
        await telemetry.withSpan('repository call', { correlationId: 'corr-1' }, () => undefined);
      });
    });

    expect(telemetry.spans).toHaveLength(3);
    const [repoSpan, handlerSpan, rootSpan] = telemetry.spans;
    expect(rootSpan?.name).toBe('http request');
    expect(rootSpan?.parentSpanId).toBeUndefined();
    expect(handlerSpan?.name).toBe('handler');
    expect(handlerSpan?.parentSpanId).toBe(rootSpan?.spanId);
    expect(repoSpan?.name).toBe('repository call');
    expect(repoSpan?.parentSpanId).toBe(handlerSpan?.spanId);
    expect(new Set(telemetry.spans.map((s) => s.traceId))).toEqual(new Set(['corr-1']));
    for (const span of telemetry.spans) expect(span.status).toBe('ok');
  });

  it('preserves parent linkage across an await inside the callback', async () => {
    const telemetry = createRecordingTelemetry();
    await telemetry.withSpan('outer', { correlationId: 'corr-2' }, async (outer) => {
      await new Promise((r) => setTimeout(r, 0));
      await telemetry.withSpan('inner', { correlationId: 'corr-2' }, (inner) => {
        expect(inner.parentSpanId).toBe(outer.spanId);
      });
    });
  });
});

describe('Telemetry — a span is closed on the throwing path, and the error is not swallowed', () => {
  it('records status error and re-raises', async () => {
    const telemetry = createRecordingTelemetry();
    await expect(
      telemetry.withSpan('failing handler', { correlationId: 'corr-1' }, () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');

    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0]?.status).toBe('error');
    expect(telemetry.spans[0]?.errorMessage).toBe('handler blew up');
  });

  it('stringifies a thrown non-Error value rather than losing it', async () => {
    const telemetry = createRecordingTelemetry();
    await expect(
      telemetry.withSpan('failing handler', { correlationId: 'corr-1' }, () => {
        throw 'not an Error instance';
      }),
    ).rejects.toBe('not an Error instance');
    expect(telemetry.spans[0]?.errorMessage).toBe('not an Error instance');
  });

  it('end() is idempotent — calling it twice emits exactly one record', () => {
    const telemetry = createRecordingTelemetry();
    const span = telemetry.startSpan('op', { correlationId: 'corr-1' });
    span.end('ok');
    span.end('error', 'ignored, already ended');
    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0]?.status).toBe('ok');
  });
});

describe('Telemetry — span attributes are filtered identically to log attributes', () => {
  const piiAttributes = {
    correlationId: 'corr-1',
    route: '/v1/authoring/items',
    email: 'jane.doe@example.com',
    phone: '+91-9876543210',
    fullName: 'Jane Doe',
  };

  it('drops the same three PII fields the logger drops, by name and by value', () => {
    const telemetry = createRecordingTelemetry();
    const span = telemetry.startSpan('op', piiAttributes);
    span.end();

    const record = telemetry.spans[0];
    expect(record?.attributes).toEqual({ route: '/v1/authoring/items' });
    expect(new Set(record?.droppedAttributeKeys)).toEqual(new Set(['email', 'phone', 'fullName']));
    expect(JSON.stringify(record)).not.toContain('jane.doe@example.com');
    expect(JSON.stringify(record)).not.toContain('+91-9876543210');
    expect(JSON.stringify(record)).not.toContain('Jane Doe');
  });

  it('never duplicates correlationId into the attribute bag', () => {
    const telemetry = createRecordingTelemetry();
    const span = telemetry.startSpan('op', { correlationId: 'corr-1' });
    span.end();
    expect(telemetry.spans[0]?.attributes).toEqual({});
  });
});

describe('createJsonTelemetry — writes one JSON line per ended span', () => {
  it('emits a parseable span record via the injected writer', () => {
    const lines: string[] = [];
    const telemetry = createJsonTelemetry({ write: (line) => lines.push(line) });
    const span = telemetry.startSpan('op', { correlationId: 'corr-1', route: '/v1/items' });
    span.end('ok');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed['type']).toBe('span');
    expect(parsed['traceId']).toBe('corr-1');
    expect(parsed['route']).toBe('/v1/items');
    expect(parsed['status']).toBe('ok');
  });

  it('includes parentSpanId for a nested span', async () => {
    const lines: string[] = [];
    const telemetry = createJsonTelemetry({ write: (line) => lines.push(line) });
    await telemetry.withSpan('outer', { correlationId: 'corr-1' }, async (outer) => {
      await telemetry.withSpan('inner', { correlationId: 'corr-1' }, () => undefined);
      expect(outer.spanId).toBeTruthy();
    });
    const inner = JSON.parse(lines[0] as string) as Record<string, unknown>;
    const outer = JSON.parse(lines[1] as string) as Record<string, unknown>;
    expect(inner['parentSpanId']).toBe(outer['spanId']);
    expect(outer['parentSpanId']).toBeUndefined();
  });

  it('includes errorMessage on a failing span and droppedKeys when attributes were filtered', async () => {
    const lines: string[] = [];
    const telemetry = createJsonTelemetry({ write: (line) => lines.push(line) });
    await expect(
      telemetry.withSpan('op', { correlationId: 'corr-1', fullName: 'Jane Doe' }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(record['errorMessage']).toBe('boom');
    expect(record['droppedKeys']).toEqual(['fullName']);
  });

  it('writes to stdout when no writer is injected', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const telemetry = createJsonTelemetry();
      telemetry.startSpan('op', { correlationId: 'corr-1' }).end();
      expect(writeSpy).toHaveBeenCalledOnce();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('createRecordingTelemetry — reset clears captured spans between tests', () => {
  it('empties spans on reset', () => {
    const telemetry = createRecordingTelemetry();
    telemetry.startSpan('op', { correlationId: 'corr-1' }).end();
    expect(telemetry.spans).toHaveLength(1);
    telemetry.reset();
    expect(telemetry.spans).toEqual([]);
  });
});

describe('createTelemetry — the shared core used by both sinks', () => {
  it('calls emit exactly once per ended span', () => {
    const emitted: unknown[] = [];
    const telemetry = createTelemetry((record) => emitted.push(record));
    telemetry.startSpan('op', { correlationId: 'corr-1' }).end();
    expect(emitted).toHaveLength(1);
  });
});

describe('No half-wired OTel SDK — no @opentelemetry import anywhere in this project', () => {
  it('scans a non-zero number of files and finds none', () => {
    const files = tsFilesUnder(API_SRC);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => readCode(file).includes('@opentelemetry'));
    expect(offenders).toEqual([]);
  });
});
