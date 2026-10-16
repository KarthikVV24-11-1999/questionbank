import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, type ApplicationError } from '../authorization.js';

/**
 * What an independent solver is shown, and what the proposal claims it answers.
 *
 * **The solver never sees the claimed key — by construction, not by filtering.**
 * The input is built from an allowlist: the stem, and for a choice question the
 * options as `{ optionId, ordinal, body }`. A key-bearing field is not removed
 * from a copy of the specification; it is never copied in. A denylist would
 * leak the first key-bearing field somebody added to the specification and
 * forgot to list, and this cannot.
 */

export const VERIFIABLE_ITEM_TYPES = ['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'NUMERIC'] as const;
export type VerifiableItemType = (typeof VERIFIABLE_ITEM_TYPES)[number];

export function isVerifiable(itemType: string): itemType is VerifiableItemType {
  return (VERIFIABLE_ITEM_TYPES as readonly string[]).includes(itemType);
}

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreadable(what: string): ApplicationError {
  return applicationError('PreconditionFailed', 'PROPOSAL_UNREADABLE', `the proposal's ${what} cannot be read for verification`, `content.body.${what}`);
}

/** The question, as an independent solver sees it. */
export function solveInputOf(itemType: VerifiableItemType, body: Json): Result<Json, ApplicationError> {
  const spec = body['responseSpec'];
  if (!isObject(spec) || body['stem'] === undefined) return err(unreadable('responseSpec'));

  if (itemType === 'NUMERIC') {
    const numeric = spec['spec'];
    const unit = isObject(numeric) && isObject(numeric['unit']) ? numeric['unit']['canonical'] : undefined;
    return ok({ itemType, stem: body['stem'], ...(typeof unit === 'string' ? { unit } : {}) });
  }

  const options = spec['options'];
  if (!Array.isArray(options) || !options.every(isObject)) return err(unreadable('responseSpec.options'));
  return ok({
    itemType,
    stem: body['stem'],
    options: options.map((option) => ({ optionId: option['optionId'], ordinal: option['ordinal'], body: option['body'] })),
  });
}

/** What the proposal says the answer is, in the form `normalizeAnswer` produces. */
export function claimedAnswerOf(itemType: VerifiableItemType, body: Json): Result<unknown, ApplicationError> {
  const spec = body['responseSpec'];
  if (!isObject(spec)) return err(unreadable('responseSpec'));
  const raw =
    itemType === 'SINGLE_CORRECT_MCQ'
      ? spec['correctOptionId']
      : itemType === 'MULTIPLE_CORRECT_MCQ'
        ? spec['correctOptionIds']
        : isObject(spec['spec'])
          ? spec['spec']['expectedValue']
          : undefined;
  const normalized = normalizeAnswer(itemType, raw);
  return normalized === undefined ? err(unreadable('responseSpec (its key)')) : ok(normalized);
}

/** One canonical form per item type, so two solves and a key can be compared; `undefined` when it is not an answer. */
export function normalizeAnswer(itemType: VerifiableItemType, raw: unknown): unknown {
  if (itemType === 'SINGLE_CORRECT_MCQ') {
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  }
  if (itemType === 'MULTIPLE_CORRECT_MCQ') {
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) return undefined;
    return [...new Set(raw.map((entry: string) => entry.trim()))].sort();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}
