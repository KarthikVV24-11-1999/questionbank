import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { anEnvelope } from '../../testing/analytics-fixtures.js';
import { LocalDirectorySink } from './sink.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the local directory sink', () => {
  it('appends one line of JSON per event under a directory for the day it was ingested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qb-sink-'));
    roots.push(root);
    const sink = new LocalDirectorySink(root);
    const [a, b, c] = [anEnvelope(), anEnvelope(), anEnvelope()].map((event, i) => ({ ...event, received_at: i < 2 ? '2026-10-29T09:00:00.000Z' : '2026-10-30T00:00:01.000Z' }));
    for (const event of [a!, b!, c!]) await sink.write(event);
    const lines = (day: string) => readFileSync(join(root, `dt=${day}`, 'events.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event_id: string });
    expect(lines('2026-10-29').map((event) => event.event_id)).toEqual([a!.event_id, b!.event_id]);
    expect(lines('2026-10-30').map((event) => event.event_id)).toEqual([c!.event_id]);
  });
});
