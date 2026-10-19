import { GENERATION_FEATURE } from '../../domain/ai-budget.js';
import { err, ok, type Result } from '../../domain/result.js';
import type { GenerationCandidate } from '../../domain/generation-candidate.js';
import { isUuid } from '../../domain/uuid.js';
import { applicationError, type ApplicationError } from '../authorization.js';
import type { JudgementProvider, JudgementResponse } from '../ports.js';

/**
 * The checks that put a question to a model, and the one gateway they all go
 * through.
 *
 * **F29 — independent derivation.** A model checking its own work agrees with
 * itself (§11), so a check's prompt version must not be the one its candidate
 * was generated with. That rule is enforced here, in the single function every
 * judged check calls, rather than asked of each check separately: a check that
 * wanted to skip it would have to skip the gateway, and there would be nowhere
 * for it to go. It runs before the provider is touched, so a refused check
 * costs nothing.
 */

/** The checks that need a second opinion from a model, in the vocabulary's order. */
export const JUDGED_CHECKS = [
  'answer_verification',
  'syllabus_scope',
  'item_solution_key_consistency',
  'distractor_validity',
  'ambiguity_clarity',
  'safety_appropriateness',
] as const;
export type JudgedCheckId = (typeof JUDGED_CHECKS)[number];

/** The registry rows a judged check runs under. Pinned data, never a constant — the deployment supplies them. */
export interface JudgedCheckConfig {
  readonly modelVersionId: string;
  readonly promptVersionId: string;
}

export type PrecheckConfig = Readonly<Record<JudgedCheckId, JudgedCheckConfig>>;

/**
 * F29, as a function: the prompt a check runs under is not the prompt its
 * candidate was generated with. `check` is named so the failure says which.
 */
export function requireIndependentPrompt(
  check: JudgedCheckId,
  generationPromptVersionId: string,
  checkPromptVersionId: string,
): Result<true, ApplicationError> {
  if (generationPromptVersionId === checkPromptVersionId) {
    return err(
      applicationError(
        'PreconditionFailed',
        'CHECK_REUSES_GENERATION_PROMPT',
        `${check} would run under prompt version ${checkPromptVersionId}, the one its candidate was generated with; a model checking its own derivation agrees with itself (F29, AI-ARCHITECTURE §11)`,
        'promptVersionId',
      ),
    );
  }
  return ok(true);
}

/**
 * Refuses a configuration that cannot be right, when it is built rather than
 * when a check first runs: every judged check names registry-shaped ids, and
 * each has **its own** prompt version. Two checks sharing a prompt would be one
 * check in two costumes, and a verdict from either would say less than it seems.
 */
export function validatePrecheckConfig(config: PrecheckConfig): Result<PrecheckConfig, ApplicationError> {
  const seen = new Map<string, JudgedCheckId>();
  for (const check of JUDGED_CHECKS) {
    const entry = config[check] as JudgedCheckConfig | undefined;
    for (const field of ['modelVersionId', 'promptVersionId'] as const) {
      if (!isUuid(entry?.[field])) {
        return err(
          applicationError('Validation', 'PRECHECK_CONFIG_INVALID', `${check}.${field} must be a registry UUID`, `${check}.${field}`),
        );
      }
    }
    const earlier = seen.get(entry!.promptVersionId);
    if (earlier !== undefined) {
      return err(
        applicationError(
          'Validation',
          'PRECHECK_PROMPTS_NOT_DISTINCT',
          `${check} and ${earlier} share prompt version ${entry!.promptVersionId}; each judged check has its own`,
          `${check}.promptVersionId`,
        ),
      );
    }
    seen.set(entry!.promptVersionId, check);
  }
  return ok(config);
}

/** Puts one question to the provider on a check's behalf, after F29 and not before. */
export async function judgeIndependently(
  provider: JudgementProvider,
  candidate: GenerationCandidate,
  check: JudgedCheckId,
  config: JudgedCheckConfig,
  input: Readonly<Record<string, unknown>>,
): Promise<Result<JudgementResponse, ApplicationError>> {
  const independent = requireIndependentPrompt(check, candidate.pin.promptVersionId, config.promptVersionId);
  if (!independent.ok) return independent;
  return provider.judge({
    budgetScope: { feature: GENERATION_FEATURE, runId: candidate.pin.runId },
    modelVersionId: config.modelVersionId,
    promptVersionId: config.promptVersionId,
    input,
  });
}
