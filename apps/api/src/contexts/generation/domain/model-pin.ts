import { err, ok, type Result } from './result.js';
import { validationError, type GenerationError } from './generation-error.js';

/**
 * The pin F28 requires on every generated artifact: which model, which prompt,
 * which run.
 *
 * A candidate without all three is unconstructible, because the question
 * *"prompt v7 had a defect — which items are affected?"* must be answerable in
 * one query, and a nullable column cannot answer it: an artifact with a null
 * prompt version is affected by an unknown set of defects.
 *
 * Model and prompt versions are **pinned data, carried on the artifact**, never
 * configuration constants read at the moment of use (ARCHITECTURE §8,
 * AI-ARCHITECTURE §15). A constant would silently re-label every earlier
 * artifact the day it changed.
 *
 * Pure and deterministic: no clock, no randomness, nothing read from outside.
 */

/** The three members, in declaration order. A fourth is a change to this list and to every test of it. */
export const MODEL_PIN_FIELDS = ['modelVersionId', 'promptVersionId', 'runId'] as const;
export type ModelPinField = (typeof MODEL_PIN_FIELDS)[number];

export interface ModelPin {
  readonly modelVersionId: string;
  readonly promptVersionId: string;
  readonly runId: string;
}

export type ModelPinProps = ModelPin;

export type ModelPinErrorCode = 'MODEL_VERSION_ID_REQUIRED' | 'PROMPT_VERSION_ID_REQUIRED' | 'RUN_ID_REQUIRED';

export type ModelPinError = GenerationError<ModelPinErrorCode>;

const REQUIRED_CODE: Readonly<Record<ModelPinField, ModelPinErrorCode>> = Object.freeze({
  modelVersionId: 'MODEL_VERSION_ID_REQUIRED',
  promptVersionId: 'PROMPT_VERSION_ID_REQUIRED',
  runId: 'RUN_ID_REQUIRED',
});

/** Blank means absent, whitespace-only, or not a string at all — a pin read back from storage is untrusted. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

export function createModelPin(props: ModelPinProps): Result<ModelPin, ModelPinError> {
  for (const field of MODEL_PIN_FIELDS) {
    if (isBlank(props[field])) {
      return err(validationError(REQUIRED_CODE[field], `${field} is required — an unpinned artifact cannot be traced`, field));
    }
  }

  return ok(
    Object.freeze({
      modelVersionId: props.modelVersionId,
      promptVersionId: props.promptVersionId,
      runId: props.runId,
    }),
  );
}
