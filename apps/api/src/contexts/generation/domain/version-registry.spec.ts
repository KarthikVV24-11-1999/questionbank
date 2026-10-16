import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { createModelVersion, createPromptVersion } from './version-registry.js';

const MODEL_ID = '00000000-0000-4000-8000-0000000a0003';
const PROMPT_ID = '00000000-0000-4000-8000-0000000b0007';
const SHA = 'a'.repeat(64);

describe('a model version', () => {
  it('records the model it pins and that automatic upgrades are prohibited, field by field', () => {
    const version = expectValue(
      createModelVersion({ modelVersionId: MODEL_ID, providerModelId: 'claude-opus-5-5', automaticUpgradesProhibited: true }),
    );
    expect(version.modelVersionId).toBe(MODEL_ID);
    expect(version.providerModelId).toBe('claude-opus-5-5');
    expect(version.automaticUpgradesProhibited).toBe(true);
    expect(Object.keys(version).sort()).toEqual(['automaticUpgradesProhibited', 'modelVersionId', 'providerModelId']);
    expect(Object.isFrozen(version)).toBe(true);
  });

  it('refuses an identifier that is not a UUID', () => {
    const failure = expectError(createModelVersion({ modelVersionId: 'model-v3', providerModelId: 'm', automaticUpgradesProhibited: true }));
    expect(failure.code).toBe('MODEL_VERSION_ID_NOT_A_UUID');
    expect(failure.location).toBe('modelVersionId');
  });

  it('refuses a version that does not name its model', () => {
    for (const providerModelId of ['', '  ', undefined as never]) {
      expect(expectError(createModelVersion({ modelVersionId: MODEL_ID, providerModelId, automaticUpgradesProhibited: true })).code).toBe(
        'PROVIDER_MODEL_REQUIRED',
      );
    }
  });

  it('refuses a version that does not prohibit automatic upgrades — AI-ARCHITECTURE §15', () => {
    for (const automaticUpgradesProhibited of [false, undefined, 'yes'] as const) {
      const failure = expectError(
        createModelVersion({ modelVersionId: MODEL_ID, providerModelId: 'm', automaticUpgradesProhibited: automaticUpgradesProhibited as never }),
      );
      expect(failure.code).toBe('AUTOMATIC_UPGRADES_MUST_BE_PROHIBITED');
      expect(failure.location).toBe('automaticUpgradesProhibited');
    }
  });
});

describe('a prompt version', () => {
  it('records the file it was published from and that file’s digest, field by field', () => {
    const version = expectValue(createPromptVersion({ promptVersionId: PROMPT_ID, sourceFile: 'prompts/generate-mcq.md', contentSha256: SHA }));
    expect(version.promptVersionId).toBe(PROMPT_ID);
    expect(version.sourceFile).toBe('prompts/generate-mcq.md');
    expect(version.contentSha256).toBe(SHA);
    expect(Object.keys(version).sort()).toEqual(['contentSha256', 'promptVersionId', 'sourceFile']);
    expect(Object.isFrozen(version)).toBe(true);
  });

  it('refuses an identifier that is not a UUID', () => {
    const failure = expectError(createPromptVersion({ promptVersionId: 'prompt-v7', sourceFile: 'p.md', contentSha256: SHA }));
    expect(failure.code).toBe('PROMPT_VERSION_ID_NOT_A_UUID');
    expect(failure.location).toBe('promptVersionId');
  });

  it('refuses a version that names no file', () => {
    for (const sourceFile of ['', '  ', undefined as never]) {
      expect(expectError(createPromptVersion({ promptVersionId: PROMPT_ID, sourceFile, contentSha256: SHA })).code).toBe('SOURCE_FILE_REQUIRED');
    }
  });

  it('refuses a digest that is not 64 lower-case hex characters', () => {
    for (const contentSha256 of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), undefined as never]) {
      const failure = expectError(createPromptVersion({ promptVersionId: PROMPT_ID, sourceFile: 'p.md', contentSha256 }));
      expect(failure.code).toBe('CONTENT_SHA256_INVALID');
      expect(failure.location).toBe('contentSha256');
    }
  });
});
