import { err, ok, type Result } from './result.js';
import { validationError, type GenerationError } from './generation-error.js';
import { isUuid } from './uuid.js';

/**
 * The version registry's two kinds of row (AI-ARCHITECTURE §15).
 *
 * Versions are rows, pinned by reference: a run and every candidate it produced
 * carry the registry id, so "prompt v7 had a defect — which items are
 * affected?" is a join, and two runs cannot name one version in two spellings.
 * Both are immutable once published, which the database enforces; nothing here
 * has an edit.
 *
 * Published at deploy, not by a user: there is no handler that registers a
 * version, only a repository the deployment step calls.
 */

export interface ModelVersion {
  readonly modelVersionId: string;
  /** The model this row pins, exactly as the provider names it. */
  readonly providerModelId: string;
  /** §15: a recorded pin is never silently upgraded. Always true; a version claiming otherwise is refused. */
  readonly automaticUpgradesProhibited: true;
}

export interface PromptVersion {
  readonly promptVersionId: string;
  /** The file the version was published from, so a row traces back to a diff. */
  readonly sourceFile: string;
  /** Lower-case hex SHA-256 of that file's contents. */
  readonly contentSha256: string;
}

export type VersionRegistryErrorCode =
  | 'MODEL_VERSION_ID_NOT_A_UUID'
  | 'PROVIDER_MODEL_REQUIRED'
  | 'AUTOMATIC_UPGRADES_MUST_BE_PROHIBITED'
  | 'PROMPT_VERSION_ID_NOT_A_UUID'
  | 'SOURCE_FILE_REQUIRED'
  | 'CONTENT_SHA256_INVALID';

export type VersionRegistryError = GenerationError<VersionRegistryErrorCode>;

export interface CreateModelVersionProps {
  readonly modelVersionId: string;
  readonly providerModelId: string;
  readonly automaticUpgradesProhibited: boolean;
}

export interface CreatePromptVersionProps {
  readonly promptVersionId: string;
  readonly sourceFile: string;
  readonly contentSha256: string;
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

export function createModelVersion(props: CreateModelVersionProps): Result<ModelVersion, VersionRegistryError> {
  if (!isUuid(props.modelVersionId)) {
    return err(validationError('MODEL_VERSION_ID_NOT_A_UUID', 'modelVersionId must be a UUID', 'modelVersionId'));
  }
  if (isBlank(props.providerModelId)) {
    return err(validationError('PROVIDER_MODEL_REQUIRED', 'a model version names the model it pins', 'providerModelId'));
  }
  if (props.automaticUpgradesProhibited !== true) {
    return err(
      validationError(
        'AUTOMATIC_UPGRADES_MUST_BE_PROHIBITED',
        'a model version must record that automatic upgrades are prohibited (AI-ARCHITECTURE §15)',
        'automaticUpgradesProhibited',
      ),
    );
  }
  return ok(
    Object.freeze({
      modelVersionId: props.modelVersionId,
      providerModelId: props.providerModelId,
      automaticUpgradesProhibited: true as const,
    }),
  );
}

export function createPromptVersion(props: CreatePromptVersionProps): Result<PromptVersion, VersionRegistryError> {
  if (!isUuid(props.promptVersionId)) {
    return err(validationError('PROMPT_VERSION_ID_NOT_A_UUID', 'promptVersionId must be a UUID', 'promptVersionId'));
  }
  if (isBlank(props.sourceFile)) {
    return err(validationError('SOURCE_FILE_REQUIRED', 'a prompt version names the file it was published from', 'sourceFile'));
  }
  if (typeof props.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(props.contentSha256)) {
    return err(
      validationError('CONTENT_SHA256_INVALID', 'contentSha256 must be 64 lower-case hex characters', 'contentSha256'),
    );
  }
  return ok(
    Object.freeze({
      promptVersionId: props.promptVersionId,
      sourceFile: props.sourceFile,
      contentSha256: props.contentSha256,
    }),
  );
}
