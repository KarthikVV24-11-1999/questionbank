import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, type ApplicationError } from '../authorization.js';
import type { JudgementProvider } from '../ports.js';
import type { CheckOutcome, PrecheckRunner } from './battery.js';
import { judgeIndependently, type JudgedCheckConfig, type JudgedCheckId } from './judge.js';

/**
 * Checks 6, 7, 10 and 11 (AI-ARCHITECTURE §11): item ↔ solution ↔ key
 * consistency, distractor validity, ambiguity, safety. Each is **one**
 * interaction with the provider, under **its own prompt version**, through the
 * gateway that enforces F29, and each returns a verdict *and its reasoning*.
 *
 * The reasoning is the point of the detail. "The reviewer should see the
 * verification's working, not just its verdict" (§11): a bare `fail` sends a
 * reviewer to redo the work, and a bare `pass` asks them to trust it. The
 * provider's rationale is recorded as the verdict's detail, so the person who
 * decides sees why.
 *
 * Severity is the vocabulary's, not this module's: 6, 7 and 11 block, 10 is
 * advisory. A check does not know which it is — it reports, and acceptance
 * decides.
 */

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreadable(what: string, why: string): ApplicationError {
  return applicationError('PreconditionFailed', 'PROPOSAL_UNREADABLE', `the proposal's ${what} ${why}`, `content.body.${what}`);
}

/** Option text only — what a learner reads. Never the key. */
function optionsOf(body: Json): Json[] | undefined {
  const spec = body['responseSpec'];
  const options = isObject(spec) ? spec['options'] : undefined;
  return Array.isArray(options) && options.every(isObject) ? options.map((option) => ({ optionId: option['optionId'], ordinal: option['ordinal'], body: option['body'] })) : undefined;
}

/**
 * What each check is shown. Built from an allowlist per check, so each sees what
 * its question needs and nothing it does not: consistency and distractor
 * validity need the key (the question is whether it is *right*); ambiguity and
 * safety are about what a learner reads, and do not.
 */
const INPUTS: Readonly<Record<'item_solution_key_consistency' | 'distractor_validity' | 'ambiguity_clarity' | 'safety_appropriateness', (itemType: string, body: Json) => Result<Json, ApplicationError>>> = {
  item_solution_key_consistency: (itemType, body) => {
    if (!isObject(body['solution'])) {
      return err(unreadable('solution', 'is absent, so there is nothing to check the item and its key against'));
    }
    if (!isObject(body['responseSpec']) || body['stem'] === undefined) return err(unreadable('responseSpec', 'cannot be read'));
    return ok({ itemType, stem: body['stem'], responseSpec: body['responseSpec'], solution: body['solution'] });
  },
  distractor_validity: (itemType, body) => {
    if (!isObject(body['responseSpec']) || body['stem'] === undefined) return err(unreadable('responseSpec', 'cannot be read'));
    return ok({ itemType, stem: body['stem'], responseSpec: body['responseSpec'] });
  },
  ambiguity_clarity: (itemType, body) => {
    if (body['stem'] === undefined) return err(unreadable('stem', 'is absent'));
    const options = optionsOf(body);
    return ok({ itemType, stem: body['stem'], ...(options === undefined ? {} : { options }) });
  },
  safety_appropriateness: (itemType, body) => {
    if (body['stem'] === undefined) return err(unreadable('stem', 'is absent'));
    const options = optionsOf(body);
    return ok({
      itemType,
      stem: body['stem'],
      ...(options === undefined ? {} : { options }),
      ...(isObject(body['solution']) ? { solution: body['solution'] } : {}),
    });
  },
};

export type JudgementCheckId = keyof typeof INPUTS;

/**
 * A model's reply read as a verdict and its reasoning, or refused as malformed.
 * Shared by every check that asks for a pass/fail with a rationale, so "usable"
 * means one thing.
 */
export function verdictFrom(check: string, output: Readonly<Record<string, unknown>>): Result<CheckOutcome, ApplicationError> {
  const { outcome, rationale } = output;
  if ((outcome !== 'pass' && outcome !== 'fail') || typeof rationale !== 'string' || rationale.trim().length === 0) {
    return err(applicationError('Unavailable', 'PROVIDER_REPLY_MALFORMED', `${check} returned no usable verdict and rationale`, check));
  }
  return ok({ outcome, detail: rationale.trim() });
}

/** A choice-less item has no distractors; there is nothing for that check to find wrong. */
function hasDistractors(itemType: string): boolean {
  return itemType === 'SINGLE_CORRECT_MCQ' || itemType === 'MULTIPLE_CORRECT_MCQ';
}

export function judgementCheck(
  check: JudgementCheckId & JudgedCheckId,
  deps: { readonly judge: JudgementProvider; readonly config: JudgedCheckConfig },
): PrecheckRunner {
  return {
    check,
    async run(candidate) {
      const { itemType, body } = candidate.content;

      // The check ran and found nothing to judge. Said in the detail, so a reviewer
      // is not left to wonder why no model was consulted.
      if (check === 'distractor_validity' && !hasDistractors(itemType)) {
        return ok<CheckOutcome>({ outcome: 'pass', detail: `not applicable: a ${itemType} item has no distractors, so none can be invalid` });
      }

      const input = INPUTS[check](itemType, body);
      if (!input.ok) return input;

      const answered = await judgeIndependently(deps.judge, candidate, check, deps.config, input.value);
      if (!answered.ok) return answered;

      return verdictFrom(check, answered.value.output);
    },
  };
}
