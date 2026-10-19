import { err, ok, type Result } from './result.js';
import { validationError, type GenerationError } from './generation-error.js';
import { createModelPin, type ModelPinError } from './model-pin.js';

/**
 * What one provider interaction cost, and the entry the ledger keeps of it
 * (M5-42).
 *
 * The unit is tokens (D47). An entry names the **model and prompt version the
 * interaction ran under** — which, for a judged check, are the check's own and not
 * the candidate's — and the run the spend is charged to. That is what makes spend
 * attributable: a total is only worth having if it can be split by the thing that
 * caused it.
 *
 * Total tokens is not a field. It is the sum of the two, derived by the database
 * on write and here on read, so it cannot be recorded as anything else.
 */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const SPEND_KINDS = ['propose', 'judge'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export interface SpendEntry {
  readonly ledgerId: string;
  readonly feature: string;
  /** The run the spend is charged to. */
  readonly runId: string;
  readonly modelVersionId: string;
  readonly promptVersionId: string;
  readonly kind: SpendKind;
  readonly usage: TokenUsage;
  /** UTC, ISO-8601 with milliseconds, as supplied by the caller. */
  readonly occurredAt: string;
}

export type SpendEntryErrorCode = 'SPEND_FEATURE_INVALID' | 'SPEND_KIND_INVALID' | 'SPEND_USAGE_INVALID' | 'SPEND_OCCURRED_AT_INVALID';

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** Tokens used are whole and not negative; zero is a real answer (a refusal costs input and nothing back). */
export function isUsageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isUsageCount(candidate['inputTokens']) && isUsageCount(candidate['outputTokens']);
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

export function createSpendEntry(props: SpendEntry): Result<SpendEntry, GenerationError<SpendEntryErrorCode> | ModelPinError> {
  // A pin is a run and a model and a prompt, each a non-blank reference: the same construction every artifact's pin goes through.
  const pin = createModelPin({ runId: props.runId, modelVersionId: props.modelVersionId, promptVersionId: props.promptVersionId });
  if (!pin.ok) return err(pin.error);
  if (typeof props.feature !== 'string' || props.feature.trim().length === 0) {
    return err(validationError('SPEND_FEATURE_INVALID', 'spend names the feature it is charged to', 'feature'));
  }
  if (!SPEND_KINDS.includes(props.kind)) {
    return err(validationError('SPEND_KIND_INVALID', `spend is one of ${SPEND_KINDS.join(', ')}`, 'kind'));
  }
  if (!isTokenUsage(props.usage)) {
    return err(validationError('SPEND_USAGE_INVALID', 'usage is whole, non-negative input and output token counts', 'usage'));
  }
  if (typeof props.occurredAt !== 'string' || !UTC_TIMESTAMP.test(props.occurredAt)) {
    return err(validationError('SPEND_OCCURRED_AT_INVALID', 'occurredAt must be a UTC ISO-8601 timestamp with milliseconds', 'occurredAt'));
  }
  return ok(
    Object.freeze({
      ledgerId: props.ledgerId,
      feature: props.feature,
      runId: pin.value.runId,
      modelVersionId: pin.value.modelVersionId,
      promptVersionId: pin.value.promptVersionId,
      kind: props.kind,
      usage: Object.freeze({ inputTokens: props.usage.inputTokens, outputTokens: props.usage.outputTokens }),
      occurredAt: props.occurredAt,
    }),
  );
}
