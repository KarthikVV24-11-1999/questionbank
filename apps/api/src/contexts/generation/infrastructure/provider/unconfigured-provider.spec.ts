import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { versionId } from '../../../../testing/generation-fixtures.js';
import { UnconfiguredProvider } from './unconfigured-provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const provider = new UnconfiguredProvider();

describe('the provider a deployment has when none was chosen', () => {
  it('refuses a proposal as unavailable, naming that no provider is configured, and invents nothing', async () => {
    const result = await provider.propose({
      budgetScope: { feature: 'generation', runId: versionId('run', 1) },
      pin: { modelVersionId: versionId('model', 1), promptVersionId: versionId('prompt', 1), runId: versionId('run', 1) },
      grounding: [],
      task: { itemType: 'single_choice' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unavailable');
    expect(result.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.error.message).toContain('proposals');
  });

  it('refuses a judgement the same way', async () => {
    const result = await provider.judge({ budgetScope: { feature: 'generation', runId: versionId('run', 1) }, modelVersionId: versionId('model', 1), promptVersionId: versionId('prompt', 2), input: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('Unavailable');
    expect(result.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.error.message).toContain('judgements');
  });

  it('holds no credential and reads no environment: its source never names process.env', () => {
    expect(readFileSync(join(HERE, 'unconfigured-provider.ts'), 'utf8')).not.toMatch(/process\.env/u);
  });
});
