import { err, ok, type Result } from './result.js';
import { validationError, type GenerationError } from './generation-error.js';
import { freezeJson, isJsonObject } from './json-document.js';
import { isTokenCount } from './ai-budget.js';
import { createModelPin, type ModelPin, type ModelPinError, type ModelPinProps } from './model-pin.js';

/**
 * `GenerationRun` — one invocation of the pipeline, recorded.
 *
 * It owns the pin: the run's id is the `runId` every candidate it produced
 * carries, and the model and prompt versions it ran under are the ones those
 * candidates are pinned to. A candidate whose pin disagrees with its run's is
 * a candidate nobody can trace, and the schema refuses to store it.
 *
 * A run is a record of what was asked and when, not a lifecycle: nothing about
 * it changes afterwards. The request is held as a plain JSON document — what
 * was asked for is the application layer's to shape, and a run recorded under
 * an older request shape must stay readable (hence the schema version the
 * table carries beside it).
 *
 * The timestamp is supplied, never read: `domain/` has no clock.
 */

export interface GenerationRun {
  readonly pin: ModelPin;
  /** UTC, ISO-8601 with milliseconds (`toISOString`'s form), as supplied by the caller. */
  readonly requestedAt: string;
  readonly request: Readonly<Record<string, unknown>>;
  /**
   * What the run reserved from its period's budget, in tokens, when it was
   * enqueued (M5-41). The run is the record of the reservation, so the two cannot
   * disagree and the reservation is as immutable as the run.
   */
  readonly budgetTokens: number;
}

export type GenerationRunErrorCode = 'RUN_REQUESTED_AT_INVALID' | 'RUN_REQUEST_INVALID' | 'RUN_BUDGET_INVALID';

export type GenerationRunError = GenerationError<GenerationRunErrorCode> | ModelPinError;

export interface CreateGenerationRunProps {
  readonly pin: ModelPinProps;
  readonly requestedAt: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly budgetTokens: number;
}

// Milliseconds exactly, because that is what survives a round trip through
// storage unchanged: a looser form would come back as a different string.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function createGenerationRun(props: CreateGenerationRunProps): Result<GenerationRun, GenerationRunError> {
  const pin = createModelPin(props.pin);
  if (!pin.ok) return err(pin.error);

  if (typeof props.requestedAt !== 'string' || !UTC_TIMESTAMP.test(props.requestedAt)) {
    return err(
      validationError('RUN_REQUESTED_AT_INVALID', 'requestedAt must be a UTC ISO-8601 timestamp with milliseconds', 'requestedAt'),
    );
  }
  if (!isJsonObject(props.request)) {
    return err(validationError('RUN_REQUEST_INVALID', 'the run request must be a JSON object', 'request'));
  }

  if (!isTokenCount(props.budgetTokens)) {
    return err(validationError('RUN_BUDGET_INVALID', 'a run reserves a positive whole number of tokens', 'budgetTokens'));
  }

  return ok(
    Object.freeze({
      pin: pin.value,
      budgetTokens: props.budgetTokens,
      requestedAt: props.requestedAt,
      request: freezeJson(props.request) as Readonly<Record<string, unknown>>,
    }),
  );
}
