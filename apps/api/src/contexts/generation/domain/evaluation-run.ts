import { err, ok, type Result } from './result.js';
import { preconditionFailedError, validationError, type GenerationError } from './generation-error.js';
import { isUuid } from './uuid.js';

/**
 * `EvaluationRun` — the evidence a version may be activated on (M5-43, F31).
 *
 * **No model or prompt version activates without a passing evaluation run.** A
 * version is activated for generation when a run names it, and a run that names a
 * version with no passing evaluation is refused, naming the version.
 *
 * The outcome is **derived, never asserted**. `evaluate` takes the scores and the
 * baseline and decides pass or fail itself, so whoever records an evaluation cannot
 * type in `pass` for a version that regressed. The rule is AI-ARCHITECTURE §14,
 * quoted where it matters: *regression blocks promotion — warn is not sufficient.*
 * A regression is therefore a stored `fail`, which the gate does not accept as a
 * pass, and not a warning beside a pass.
 *
 * What counts as a regression, which the architecture does not number and this
 * milestone had to choose (DEC-M5-10):
 *
 *   - **against the baseline**, any dimension the baseline reported that this run
 *     scores lower on, or does not report at all (an evaluation that quietly stops
 *     measuring something has not shown it held);
 *   - **against a floor**, any dimension with an absolute minimum — verification
 *     catch rate on known-bad items is at least 95% (F34) — scored below it;
 *   - and a run reporting nothing is not a pass.
 *
 * The first evaluation of a version has no baseline, so only floors apply to it.
 */

export const EVALUATION_DIMENSIONS = [
  'generation_acceptance',
  'verification_catch_rate',
  'explanation_quality',
  'difficulty_correlation',
] as const;
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

/** Absolute minimums. Only F34 is one the architecture states as a number. */
export const EVALUATION_FLOORS: Readonly<Partial<Record<EvaluationDimension, number>>> = Object.freeze({
  verification_catch_rate: 0.95,
});

export const SUBJECT_KINDS = ['model', 'prompt'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export type EvaluationScores = Readonly<Partial<Record<EvaluationDimension, number>>>;

export interface EvaluationRun {
  readonly evaluationRunId: string;
  readonly subject: { readonly kind: SubjectKind; readonly versionId: string };
  /** The named corpus it was scored against, so two runs are comparable only when this agrees. */
  readonly corpus: string;
  readonly scores: EvaluationScores;
  readonly baselineRunId?: string;
  /** The dimensions that regressed or missed a floor. Empty exactly when the outcome is `pass`. */
  readonly regressions: readonly EvaluationDimension[];
  readonly outcome: 'pass' | 'fail';
  /** UTC, ISO-8601 with milliseconds, as supplied by the caller. */
  readonly evaluatedAt: string;
}

export type EvaluationErrorCode =
  | 'EVALUATION_RUN_ID_INVALID'
  | 'EVALUATION_SUBJECT_INVALID'
  | 'EVALUATION_CORPUS_REQUIRED'
  | 'EVALUATION_SCORES_EMPTY'
  | 'EVALUATION_DIMENSION_UNKNOWN'
  | 'EVALUATION_SCORE_INVALID'
  | 'EVALUATION_EVALUATED_AT_INVALID'
  | 'EVALUATION_BASELINE_NOT_PASSING'
  | 'EVALUATION_BASELINE_OTHER_CORPUS'
  | 'EVALUATION_BASELINE_OTHER_SUBJECT_KIND';

export type EvaluationError = GenerationError<EvaluationErrorCode>;

export interface EvaluateProps {
  readonly evaluationRunId: string;
  readonly subject: { readonly kind: string; readonly versionId: string };
  readonly corpus: string;
  readonly scores: Readonly<Record<string, unknown>>;
  /** The passing run the version being evaluated is to be compared against — usually the one it replaces. */
  readonly baseline?: EvaluationRun;
  readonly evaluatedAt: string;
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isDimension(name: string): name is EvaluationDimension {
  return (EVALUATION_DIMENSIONS as readonly string[]).includes(name);
}

export function evaluate(props: EvaluateProps): Result<EvaluationRun, EvaluationError> {
  if (!isUuid(props.evaluationRunId)) {
    return err(validationError('EVALUATION_RUN_ID_INVALID', 'evaluationRunId must be a UUID', 'evaluationRunId'));
  }
  const kind = props.subject.kind;
  if (!(SUBJECT_KINDS as readonly string[]).includes(kind) || !isUuid(props.subject.versionId)) {
    return err(validationError('EVALUATION_SUBJECT_INVALID', 'an evaluation names a model or a prompt and the registry id of the version', 'subject'));
  }
  if (typeof props.corpus !== 'string' || props.corpus.trim().length === 0) {
    return err(validationError('EVALUATION_CORPUS_REQUIRED', 'an evaluation names the corpus it was scored against', 'corpus'));
  }
  if (typeof props.evaluatedAt !== 'string' || !UTC_TIMESTAMP.test(props.evaluatedAt)) {
    return err(validationError('EVALUATION_EVALUATED_AT_INVALID', 'evaluatedAt must be a UTC ISO-8601 timestamp with milliseconds', 'evaluatedAt'));
  }

  const entries = Object.entries(props.scores);
  if (entries.length === 0) {
    return err(validationError('EVALUATION_SCORES_EMPTY', 'an evaluation that measured nothing is not a pass', 'scores'));
  }
  const scores: Partial<Record<EvaluationDimension, number>> = {};
  for (const [name, value] of entries) {
    if (!isDimension(name)) {
      return err(validationError('EVALUATION_DIMENSION_UNKNOWN', `${name} is not one of ${EVALUATION_DIMENSIONS.join(', ')}`, `scores.${name}`));
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return err(validationError('EVALUATION_SCORE_INVALID', `${name} must be a number in [0, 1]`, `scores.${name}`));
    }
    scores[name] = value;
  }

  const baseline = props.baseline;
  if (baseline !== undefined) {
    if (baseline.outcome !== 'pass') {
      return err(preconditionFailedError('EVALUATION_BASELINE_NOT_PASSING', 'a version is compared against a passing evaluation, and this one did not pass', 'baselineRunId'));
    }
    if (baseline.subject.kind !== kind) {
      return err(preconditionFailedError('EVALUATION_BASELINE_OTHER_SUBJECT_KIND', `a ${kind} version is compared against another ${kind} version's evaluation`, 'baselineRunId'));
    }
    if (baseline.corpus !== props.corpus) {
      return err(preconditionFailedError('EVALUATION_BASELINE_OTHER_CORPUS', `the baseline was scored against ${baseline.corpus}, not ${props.corpus}, so the two cannot be compared`, 'baselineRunId'));
    }
  }

  const regressions = new Set<EvaluationDimension>();
  for (const dimension of EVALUATION_DIMENSIONS) {
    const score = scores[dimension];
    const floor = EVALUATION_FLOORS[dimension];
    if (score !== undefined && floor !== undefined && score < floor) regressions.add(dimension);
    const previous = baseline?.scores[dimension];
    if (previous !== undefined && (score === undefined || score < previous)) regressions.add(dimension);
  }

  const ordered = EVALUATION_DIMENSIONS.filter((dimension) => regressions.has(dimension));
  return ok(
    Object.freeze({
      evaluationRunId: props.evaluationRunId,
      subject: Object.freeze({ kind: kind as SubjectKind, versionId: props.subject.versionId }),
      corpus: props.corpus,
      scores: Object.freeze(scores),
      ...(baseline === undefined ? {} : { baselineRunId: baseline.evaluationRunId }),
      regressions: Object.freeze(ordered),
      outcome: ordered.length === 0 ? ('pass' as const) : ('fail' as const),
      evaluatedAt: props.evaluatedAt,
    }),
  );
}

export type ActivationErrorCode = 'VERSION_NOT_EVALUATED';

/**
 * The refusal when a run would activate versions with no passing evaluation. It
 * names every version that lacks one, so the caller is told which to evaluate
 * rather than told to try again.
 */
export function versionsNotEvaluated(
  missing: readonly { readonly kind: SubjectKind; readonly versionId: string }[],
): GenerationError<ActivationErrorCode> {
  const named = missing.map((version) => `${version.kind} version ${version.versionId}`).join(' and ');
  return preconditionFailedError(
    'VERSION_NOT_EVALUATED',
    `${named} ${missing.length === 1 ? 'has' : 'have'} no passing evaluation run, and no version activates without one (F31)`,
    missing[0]!.kind === 'model' ? 'modelVersionId' : 'promptVersionId',
  );
}
