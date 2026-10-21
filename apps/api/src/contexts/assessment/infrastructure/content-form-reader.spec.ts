import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import type { ApplicationContext } from '../application/ports.js';
import { ContentFormReader } from './content-form-reader.js';

const CONTEXT: ApplicationContext = { principal: { kind: 'human', id: '00000000-0000-4000-8000-000000000001', roleContext: ['learner'] }, correlationId: 'c' };

describe('the content reader', () => {
  it('asks content for a version by its own id, as the caller, and hands the view on untouched', async () => {
    const seen: unknown[] = [];
    const reader = new ContentFormReader({
      itemVersion: { handle: async (query, context) => { seen.push([query, context]); return { ok: true, value: { itemVersionId: 'v', stem: 's' } }; } },
      stimulusVersion: { handle: async (query) => { seen.push(query); return { ok: true, value: { body: 'b' } }; } },
    });
    expect(expectValue(await reader.itemVersion('v', CONTEXT))).toEqual({ itemVersionId: 'v', stem: 's' });
    expect(expectValue(await reader.stimulusVersion('sv', CONTEXT))).toEqual({ body: 'b' });
    expect(seen).toEqual([[{ itemVersionId: 'v' }, CONTEXT], { stimulusVersionId: 'sv' }]);
  });

  it('passes content\'s refusal on as it came', async () => {
    const refusal = { kind: 'NotFound' as const, code: 'NOT_FOUND', message: 'no' };
    const reader = new ContentFormReader({
      itemVersion: { handle: async () => ({ ok: false, error: refusal }) },
      stimulusVersion: { handle: async () => ({ ok: false, error: refusal }) },
    });
    expect(expectError(await reader.itemVersion('v', CONTEXT))).toEqual(refusal);
    expect(expectError(await reader.stimulusVersion('v', CONTEXT))).toEqual(refusal);
  });
});
