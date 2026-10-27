import { err, ok, type Result } from './result.js';

/**
 * One response, as evidence about one concept (M7-04, D-002).
 *
 * **Learning owns this value and nothing upstream owns a copy of it.** It is assembled from what scoring says happened to each
 * slot and what content says each item version is about, and then it is Learning's: mastery is derived from these rows, and a
 * rule changed later recomputes from them without re-collecting anything.
 *
 * **One response is one piece of evidence for the item's primary concept and nothing for its secondary tags** (DEC-M7-5), so
 * "8 responses" is a count. The item version is retained so a calibrated rule can recompute from history.
 *
 * **`difficultyEstimate` is an author's judgement, not a measured p-value** (DEC-M7-3). The name carries the distinction so no
 * later reader has to infer it (D71, ADR-0044); when Psychometrics produces item statistics, evidence recomputes against them.
 *
 * `occurredAt` is the instant the evidence is attributed to, which is also what a learner's study sitting is assigned from
 * (DEC-M7-2) and what a practice run's evidence will carry when it arrives through the same port (DEC-M7-4).
 *
 * Only a response that was given is evidence. An unattempted slot, a dropped item, a bonus and an indeterminate outcome say
 * nothing about what the learner knows, so this vocabulary has no value for them and the assembler does not produce one.
 */

/** Held to scoring's own list of outcomes by `platform/composition/learning-vocabulary.spec.ts`, not by an import. */
export const EVIDENCE_OUTCOMES = ['correct', 'incorrect'] as const;
export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number];

/** Held to content's `DIFFICULTY_BANDS` in the same place, in the same order. */
export const DIFFICULTY_ESTIMATES = ['foundational', 'moderate', 'challenging', 'advanced'] as const;
export type DifficultyEstimate = (typeof DIFFICULTY_ESTIMATES)[number];

export interface MasteryEvidence {
  readonly attemptRef: string;
  readonly slotRef: string;
  readonly itemVersionRef: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly outcome: EvidenceOutcome;
  readonly difficultyEstimate: DifficultyEstimate;
  /** An ISO-8601 UTC instant, in the one canonical rendering. */
  readonly occurredAt: string;
}

export type MasteryEvidenceProps = { readonly [K in keyof MasteryEvidence]: unknown };

export interface LearningError<Code extends string = string> {
  readonly kind: 'Validation';
  readonly code: Code;
  readonly message: string;
}

export type MasteryEvidenceErrorCode = 'EVIDENCE_REFERENCE_INVALID' | 'EVIDENCE_OUTCOME_INVALID' | 'EVIDENCE_DIFFICULTY_INVALID' | 'EVIDENCE_INSTANT_INVALID';

function invalid<Code extends MasteryEvidenceErrorCode>(code: Code, message: string): LearningError<Code> {
  return Object.freeze({ kind: 'Validation', code, message });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function createMasteryEvidence(props: MasteryEvidenceProps): Result<MasteryEvidence, LearningError<MasteryEvidenceErrorCode>> {
  for (const field of ['attemptRef', 'itemVersionRef', 'conceptIdentityId', 'taxonomyVersionId'] as const) {
    const value = props[field];
    if (typeof value !== 'string' || !UUID.test(value)) {
      return err(invalid('EVIDENCE_REFERENCE_INVALID', `${field} is not an identifier`));
    }
  }
  // A slot's reference is the paper's own name for it, not an identifier: it need only name something.
  if (typeof props.slotRef !== 'string' || props.slotRef.trim() === '') {
    return err(invalid('EVIDENCE_REFERENCE_INVALID', 'slotRef is empty'));
  }
  if (!(EVIDENCE_OUTCOMES as readonly unknown[]).includes(props.outcome)) {
    return err(invalid('EVIDENCE_OUTCOME_INVALID', 'only a correct or an incorrect response is evidence'));
  }
  if (!(DIFFICULTY_ESTIMATES as readonly unknown[]).includes(props.difficultyEstimate)) {
    return err(invalid('EVIDENCE_DIFFICULTY_INVALID', 'difficultyEstimate is not one of the authored bands'));
  }
  if (!isCanonicalInstant(props.occurredAt)) {
    return err(invalid('EVIDENCE_INSTANT_INVALID', 'occurredAt is not an ISO-8601 UTC instant'));
  }

  return ok(
    Object.freeze({
      attemptRef: props.attemptRef as string,
      slotRef: props.slotRef,
      itemVersionRef: props.itemVersionRef as string,
      conceptIdentityId: props.conceptIdentityId as string,
      taxonomyVersionId: props.taxonomyVersionId as string,
      outcome: props.outcome as EvidenceOutcome,
      difficultyEstimate: props.difficultyEstimate as DifficultyEstimate,
      occurredAt: props.occurredAt,
    }),
  );
}
