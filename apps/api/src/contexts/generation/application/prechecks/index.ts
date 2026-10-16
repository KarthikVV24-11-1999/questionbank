import type { VersionRegistry } from '../../domain/repository-ports.js';
import type { Clock, ContentProposalChecks, JudgementProvider, SyllabusReader } from '../ports.js';
import type { BlockedPrecheck, PrecheckRunner } from './battery.js';
import { PRECHECK_IDS } from '../../domain/precheck-vocabulary.js';
import { validatePrecheckConfig, type PrecheckConfig } from './judge.js';
import { contentValidationCheck, duplicateDetectionCheck } from './content-checks.js';
import { judgementCheck } from './judgement-checks.js';
import { provenanceLicensingCheck } from './provenance-check.js';
import { syllabusScopeCheck } from './syllabus-check.js';
import { answerVerificationCheck } from './verification-check.js';

/**
 * Which of the twelve checks run, and which cannot, in one place.
 *
 * **Every check in the vocabulary is exactly one of the two.** A check that is
 * neither would be silently absent from the battery — the failure mode this file
 * exists to make impossible — and the spec holds the two lists to the vocabulary
 * as a set, so adding a thirteenth check or dropping a declaration is a failing
 * test and not a quiet gap.
 *
 * Checks 1, 2, 4 and 8 were blocked until content could answer for a proposal it
 * had not stored (M5-32, M5-33); they run now, through content's own validator
 * and duplicate query. Only check 9 remains, below.
 */

/**
 * The one named successor for the check that remains blocked: a source for the
 * §7 difficulty prior over a proposal. Its features are solution step count,
 * prerequisite depth, notation complexity, distractor plausibility and
 * comparable-item difficulty; nothing exposes them for content that is not
 * stored, and computing them here would be a second implementation of measures
 * other contexts own.
 */
export const DIFFICULTY_PRIOR_SUCCESSOR =
  'a difficulty prior over proposed content: the §7 features (step count, prerequisite depth, notation complexity, comparable-item difficulty) available without a stored version';

/**
 * Why check 9 cannot run. It is advisory, so it blocks nothing: a candidate is
 * acceptable without it, and the report says it did not run. This is debt D42.
 */
export const BLOCKED_PRECHECKS: readonly BlockedPrecheck[] = Object.freeze([
  {
    check: 'difficulty_plausibility',
    reason: 'the §7 prior needs features of the item — comparable-item difficulty among them — that nothing exposes for content that has not been stored',
    successor: DIFFICULTY_PRIOR_SUCCESSOR,
  },
]);

export interface PrecheckDependencies {
  readonly registry: VersionRegistry;
  readonly judge: JudgementProvider;
  readonly syllabus: SyllabusReader;
  /** Content's answers about a proposal it has not stored — validation, and duplicates. */
  readonly content: ContentProposalChecks;
  readonly clock: Clock;
  /** The registry rows each judged check runs under — validated here, when the battery is built. */
  readonly config: PrecheckConfig;
}

/** A battery that cannot be built to be correct is a deployment that does not start. */
export class InvalidPrecheckConfigurationError extends Error {
  constructor(code: string, message: string) {
    super(`the pre-check battery cannot be built: ${code}: ${message}`);
    this.name = 'InvalidPrecheckConfigurationError';
  }
}

export function buildPrechecks(deps: PrecheckDependencies): { readonly runners: readonly PrecheckRunner[]; readonly blocked: readonly BlockedPrecheck[] } {
  const config = validatePrecheckConfig(deps.config);
  if (!config.ok) throw new InvalidPrecheckConfigurationError(config.error.code, config.error.message);
  const { judge } = deps;

  const runners: PrecheckRunner[] = [
    answerVerificationCheck({ judge, config: config.value.answer_verification }),
    syllabusScopeCheck({ syllabus: deps.syllabus, judge, config: config.value.syllabus_scope }),
    judgementCheck('item_solution_key_consistency', { judge, config: config.value.item_solution_key_consistency }),
    judgementCheck('distractor_validity', { judge, config: config.value.distractor_validity }),
    judgementCheck('ambiguity_clarity', { judge, config: config.value.ambiguity_clarity }),
    judgementCheck('safety_appropriateness', { judge, config: config.value.safety_appropriateness }),
    provenanceLicensingCheck(deps.registry),
    contentValidationCheck('schema_validity', deps),
    contentValidationCheck('renderability', deps),
    contentValidationCheck('numeric_spec_completeness', deps),
    duplicateDetectionCheck(deps),
  ];

  return { runners, blocked: BLOCKED_PRECHECKS };
}

/** What a deployment that supplied no pre-check configuration needs before any judged check can run. */
export const UNCONFIGURED_SUCCESSOR =
  'a deployment that supplies the pre-check configuration: which registry model and prompt version each judged check runs under';

/**
 * The battery of a deployment that was not configured: nothing runs, and every
 * check says so.
 *
 * The alternative is a default pairing, and there is none to give — versions are
 * pinned data, never constants (ARCHITECTURE §8). So the honest battery is one
 * that declares all twelve checks blocked, and because a blocking check that did
 * not run cannot be accepted past, **nothing can be accepted** until the
 * deployment supplies the configuration. That is the safe way to be unconfigured.
 * Check 9 keeps its own, permanent reason.
 */
export function unconfiguredPrechecks(): { readonly runners: readonly PrecheckRunner[]; readonly blocked: readonly BlockedPrecheck[] } {
  const blocked = PRECHECK_IDS.map(
    (check): BlockedPrecheck =>
      BLOCKED_PRECHECKS.find((declared) => declared.check === check) ?? {
        check,
        reason: 'no pre-check configuration was supplied, so no judged or content check has a registry row to run under',
        successor: UNCONFIGURED_SUCCESSOR,
      },
  );
  return { runners: [], blocked };
}
