import type { VersionRegistry } from '../../domain/repository-ports.js';
import type { JudgementProvider, SyllabusReader } from '../ports.js';
import type { BlockedPrecheck, PrecheckRunner } from './battery.js';
import { validatePrecheckConfig, type PrecheckConfig } from './judge.js';
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
 */

/**
 * The one named successor for every check below. It is content's work, in
 * content's own task, and not generation's to force: a **pure validator over
 * proposed content**, and a **duplicate check that accepts proposed content
 * rather than a stored version**.
 */
export const CONTENT_PROPOSAL_VALIDATION_SUCCESSOR =
  "content exposing a pure validator over proposed content, and a duplicate check that accepts proposed content rather than a stored version";

/**
 * Why these checks cannot run, and why the workarounds are worse than the gap.
 *
 * Content's validation takes `ItemVersion` — content's own aggregate, which
 * generation cannot construct — and content's queries read **stored** data, and
 * a candidate is in no content table until accept. Creating a content draft per
 * candidate to get at them would write into content for things content never
 * wanted (most candidates are rejected), multiply the orphan window of D40, and
 * hand generation the write exposure SEC-20 relies on it not having. Writing a
 * second renderability or duplicate check here would be the drift this
 * repository has been bitten by three times. So they are blocked.
 *
 * This is debt D42.
 *
 * **What is not lost:** nothing unsafe reaches content regardless. The
 * anti-corruption layer refuses what content's domain will not take; the refusal
 * simply arrives at accept rather than at pre-check — a throughput cost, not a
 * correctness one.
 */
export const BLOCKED_PRECHECKS: readonly BlockedPrecheck[] = Object.freeze([
  {
    check: 'schema_validity',
    reason: "content's validation is pure but takes content's own aggregate, which generation cannot build from a proposal",
    successor: CONTENT_PROPOSAL_VALIDATION_SUCCESSOR,
  },
  {
    check: 'renderability',
    reason: 'rendering a proposal across every surface is content\'s logic, and content renders stored versions only',
    successor: CONTENT_PROPOSAL_VALIDATION_SUCCESSOR,
  },
  {
    check: 'numeric_spec_completeness',
    reason: "completeness of a numeric specification is content's rule, which content applies to its own aggregate",
    successor: CONTENT_PROPOSAL_VALIDATION_SUCCESSOR,
  },
  {
    check: 'duplicate_detection',
    reason: "content's duplicate query takes a stored item version id, and a candidate is in no content table until accept",
    successor: CONTENT_PROPOSAL_VALIDATION_SUCCESSOR,
  },
  {
    check: 'difficulty_plausibility',
    reason: "the §7 prior needs comparable-item difficulty from content's stored data, which is not reachable for a proposal",
    successor: CONTENT_PROPOSAL_VALIDATION_SUCCESSOR,
  },
]);

export interface PrecheckDependencies {
  readonly registry: VersionRegistry;
  readonly judge: JudgementProvider;
  readonly syllabus: SyllabusReader;
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
  ];

  return { runners, blocked: BLOCKED_PRECHECKS };
}
