/**
 * Planted violations for `generation-rules.spec.ts` (M5-22, EXT-05): the ways a
 * provider leaks out of its adapter. One of each, so the spec can name them.
 * Never imported by production code.
 */
import { request } from 'node:https';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const sdk: unknown = require('@anthropic-ai/sdk');

export const key = process.env['ANTHROPIC_API_KEY'];

export const MODEL = 'claude-opus-5-5';

export async function callTheProvider(): Promise<unknown> {
  request('https://api.example.test');
  return fetch('https://api.example.test/v1/messages');
}
